import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import ExcelJS from "exceljs";
import Store from "electron-store";
import { resolveConfig, type AppConfig } from "../../src/config.js";
import {
  IPC,
  type ResultFileMeta,
  type ResultSheet,
  type ScrapeLogEvent,
  type ScrapeStartResult,
} from "../shared/ipc.js";

// 设置存储：只存可序列化的覆盖项，不含密钥与路径（路径相对工作目录解析）
type StoredOverrides = Partial<AppConfig>;
const store = new Store<{ overrides: StoredOverrides; apiKeyEnc: string }>();

// 抓取产物与登录态的工作目录；relative path 在子进程里相对它解析
const workDir = path.join(app.getPath("userData"), "workspace");
const outputDir = path.join(workDir, "output");

// 持久化字段中需要剔除的：密钥单独走 safeStorage，路径交给工作目录默认值
const EXCLUDED_FIELDS: (keyof AppConfig)[] = ["dashscopeApiKey", "outputDir", "userDataDir"];

function stripExcluded(config: Partial<AppConfig>): StoredOverrides {
  const copy = { ...config };
  for (const key of EXCLUDED_FIELDS) delete copy[key];
  return copy;
}

function getApiKey(): string {
  const enc = store.get("apiKeyEnc");
  if (!enc) return "";
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return "";
  }
}

const runningChildren = new Map<string, ChildProcess>();

function detectStatus(line: string): ScrapeLogEvent["status"] | undefined {
  if (/(扫码|等待).*登录|登录.*(扫码|等待)/.test(line)) return "awaiting-login";
  if (/验证码|滑块|滑动验证/.test(line)) return "captcha";
  return undefined;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(app.getAppPath(), "out/preload/index.mjs"),
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(app.getAppPath(), "out/renderer/index.html"));
  }
}

function registerIpc(): void {
  // —— 设置 ——
  ipcMain.handle(IPC.settingsGet, () => {
    const overrides = store.get("overrides") ?? {};
    return {
      config: resolveConfig(overrides),
      hasApiKey: Boolean(getApiKey()),
      outputDir,
    };
  });

  ipcMain.handle(IPC.settingsSet, (_e, partial: Partial<AppConfig>) => {
    const prev = store.get("overrides") ?? {};
    store.set("overrides", { ...prev, ...stripExcluded(partial) });
    return true;
  });

  // —— 密钥（safeStorage 加密，落 OS keychain）——
  ipcMain.handle(IPC.secretSet, (_e, key: string) => {
    if (!key) {
      store.delete("apiKeyEnc");
      return true;
    }
    if (!safeStorage.isEncryptionAvailable()) return false;
    store.set("apiKeyEnc", safeStorage.encryptString(key).toString("base64"));
    return true;
  });
  ipcMain.handle(IPC.secretGet, () => Boolean(getApiKey()));

  // —— 抓取 ——
  ipcMain.handle(IPC.scrapeStart, async (event, config: AppConfig): Promise<ScrapeStartResult> => {
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const runId = randomUUID();
    const overrides = stripExcluded(config);
    const tmpPath = path.join(os.tmpdir(), `vp-scrape-${runId}.json`);
    await fsp.writeFile(tmpPath, JSON.stringify(overrides), "utf-8");

    const runnerPath = path.join(app.getAppPath(), "out/main/runner.js");
    const child = fork(runnerPath, ["--config", tmpPath], {
      cwd: workDir,
      env: {
        ...process.env,
        DASHSCOPE_API_KEY: getApiKey(),
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    runningChildren.set(runId, child);

    const send = (level: ScrapeLogEvent["level"], line: string, status?: ScrapeLogEvent["status"]) => {
      const payload: ScrapeLogEvent = { runId, level, line, status };
      event.sender.send(IPC.scrapeLog, payload);
    };

    const wire = (stream: NodeJS.ReadableStream | null, level: "info" | "error") => {
      let buf = "";
      stream?.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          send(level, line, detectStatus(line));
        }
      });
    };
    wire(child.stdout, "info");
    wire(child.stderr, "error");

    child.on("exit", (code) => {
      runningChildren.delete(runId);
      void fsp.unlink(tmpPath).catch(() => {});
      send("status", code === 0 ? "[done] 抓取完成" : `[done] 抓取退出，code=${code}`, "done");
    });

    return { runId };
  });

  ipcMain.handle(IPC.scrapeCancel, (_e, runId: string) => {
    const child = runningChildren.get(runId);
    if (child) {
      child.kill();
      runningChildren.delete(runId);
      return true;
    }
    return false;
  });

  // —— 结果 ——
  ipcMain.handle(IPC.resultsList, async (): Promise<ResultFileMeta[]> => {
    try {
      const names = await fsp.readdir(outputDir);
      const metas = await Promise.all(
        names
          .filter((n) => n.toLowerCase().endsWith(".xlsx"))
          .map(async (name) => {
            const full = path.join(outputDir, name);
            const st = await fsp.stat(full);
            return { name, path: full, size: st.size, mtimeMs: st.mtimeMs };
          }),
      );
      return metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.resultsRead, async (_e, filePath: string): Promise<ResultSheet> => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    if (!ws) return { columns: [], rows: [] };

    const header = ws.getRow(1);
    const columns: string[] = [];
    header.eachCell((cell, col) => {
      columns[col - 1] = String(cell.value ?? `列${col}`);
    });

    const rows: ResultSheet["rows"] = [];
    for (let r = 2; r <= ws.rowCount && r <= 501; r++) {
      const row = ws.getRow(r);
      const obj: ResultSheet["rows"][number] = {};
      columns.forEach((colName, i) => {
        const v = row.getCell(i + 1).value;
        obj[colName] = v == null ? null : typeof v === "object" ? String((v as { text?: string }).text ?? v) : (v as string | number);
      });
      rows.push(obj);
    }
    return { columns, rows };
  });

  ipcMain.handle(IPC.resultsOpen, (_e, filePath: string) => shell.openPath(filePath));
  ipcMain.handle(IPC.resultsReveal, (_e, filePath: string) => shell.showItemInFolder(filePath));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const child of runningChildren.values()) child.kill();
  if (process.platform !== "darwin") app.quit();
});

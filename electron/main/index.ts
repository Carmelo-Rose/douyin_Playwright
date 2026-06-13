import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import ExcelJS from "exceljs";
import Store from "electron-store";
import { resolveConfig, type AppConfig } from "../../src/config.js";
import { cancelJob, killAllJobs, runJob } from "./jobRunner.js";
import { backboneDim, clearPythonCache, probePython, resolvePython } from "./pythonRunner.js";
import {
  IPC,
  type MlEnvReport,
  type MlJobResult,
  type MlRunPaths,
  type MlSettings,
  type ResultFileMeta,
  type ResultSheet,
  type ScrapeLogEvent,
  type ScrapeStartResult,
  type SortedImage,
  type TrainReport,
} from "../shared/ipc.js";

// 自定义协议：在 renderer 里用 <img src="vpmedia://local/?p=<abs>"> 显示本地图片。
// 必须在 app ready 前注册 scheme 权限。
protocol.registerSchemesAsPrivileged([
  { scheme: "vpmedia", privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

// 设置存储：只存可序列化的覆盖项，不含密钥与路径（路径相对工作目录解析）
type StoredOverrides = Partial<AppConfig>;
const store = new Store<{ overrides: StoredOverrides; apiKeyEnc: string }>();

// 抓取产物与登录态的工作目录；relative path 在子进程里相对它解析
const workDir = path.join(app.getPath("userData"), "workspace");
const outputDir = path.join(workDir, "output");

// 允许被结果页读取/打开的目录集合。默认目录 + 每次抓取实际写入的目录。
const resultDirs = new Set<string>([path.resolve(outputDir)]);
function isInResultDirs(p: string): boolean {
  const abs = path.resolve(p);
  for (const root of resultDirs) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

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
      // dev 模式：__dirname = out/main/（electron-vite 虚拟），../preload/index.mjs 指向实时编译产物
      // prod 模式：__dirname = out/main/，路径相同，同样正确
      preload: path.join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    // dev 模式：等 Vite devserver 就绪再加载，避免白屏
    const url = process.env.ELECTRON_RENDERER_URL;
    const waitAndLoad = async () => {
      for (let i = 0; i < 30; i++) {
        try {
          await fetch(url, { signal: AbortSignal.timeout(500) });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      win.loadURL(url);
    };
    waitAndLoad();
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
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

  // —— 输出目录选择 ——
  ipcMain.handle(IPC.selectOutputDir, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择保存路径",
      defaultPath: outputDir,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
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
    // 优先使用用户在设置页选择的路径，回退到默认 outputDir
    const resolvedOutputDir = config.outputDir || outputDir;
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
    resultDirs.add(path.resolve(resolvedOutputDir));
    // 把路径字段补回：子进程读 JSON 时这些字段不能为 undefined
    const runnerConfig: AppConfig = {
      ...config,
      outputDir: resolvedOutputDir,
      userDataDir: config.userDataDir || path.join(workDir, ".user-data", config.platform === "xhs" ? "xhs" : "douyin"),
      dashscopeApiKey: "", // 密钥通过 env.DASHSCOPE_API_KEY 传递，JSON 里留空
    };
    const tmpPath = path.join(os.tmpdir(), `vp-scrape-${runId}.json`);
    await fsp.writeFile(tmpPath, JSON.stringify(runnerConfig), "utf-8");

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
      if (event.sender.isDestroyed()) return;
      event.sender.send(IPC.scrapeLog, { runId, level, line, status });
    };

    const wire = (stream: NodeJS.ReadableStream | null, level: "info" | "error") => {
      const decoder = new StringDecoder("utf8");
      let buf = "";
      stream?.on("data", (chunk: Buffer) => {
        buf += decoder.write(chunk); // 不完整的多字节序列缓存到下一个 chunk
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          send(level, line, detectStatus(line));
        }
      });
      stream?.on("end", () => {
        buf += decoder.end();
        if (buf.trim()) send(level, buf, detectStatus(buf));
      });
    };
    wire(child.stdout, "info");
    wire(child.stderr, "error");

    // close 在 stdio 流全部关闭后触发，确保最后几行日志不会排在 [done] 之后
    child.on("close", (code) => {
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
      const metas: ResultFileMeta[] = [];
      for (const dir of resultDirs) {
        let names: string[] = [];
        try { names = await fsp.readdir(dir); } catch { continue; }
        for (const name of names.filter((n) => n.toLowerCase().endsWith(".xlsx"))) {
          const full = path.join(dir, name);
          const st = await fsp.stat(full);
          metas.push({ name, path: full, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
      return metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.resultsRead, async (_e, filePath: string): Promise<ResultSheet> => {
    if (!isInResultDirs(filePath)) throw new Error("resultsRead: 路径越权");
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

  ipcMain.handle(IPC.resultsOpen, (_e, filePath: string) =>
    isInResultDirs(filePath) ? shell.openPath(filePath) : Promise.resolve("forbidden"),
  );
  ipcMain.handle(IPC.resultsReveal, (_e, filePath: string) => {
    if (isInResultDirs(filePath)) shell.showItemInFolder(filePath);
  });
}

// ========================= ML 工作台 =========================

const mlStore = new Store<{ settings: MlSettings }>({ name: "ml" });
const DEFAULT_ML: MlSettings = { pythonPath: "", backbone: "clip-b32", threshold: 0.75, maxNotes: 0, imgsPerNote: 0 };
const mlRunsDir = path.join(workDir, "ml-runs");
const PREFIX_RE = /^(\d{1,3})_/; // predict 输出文件名前缀 087_xxx -> P(good)=0.87

// vpmedia:// 只允许读这些根目录下的文件，防越权读任意路径
const allowedMediaRoots = new Set<string>();
function allowMedia(dir: string): void {
  allowedMediaRoots.add(path.resolve(dir));
}
function isAllowedMedia(p: string): boolean {
  const abs = path.resolve(p);
  for (const root of allowedMediaRoots) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}
function mediaUrl(abs: string): string {
  return `vpmedia://local/?p=${encodeURIComponent(abs)}`;
}
function mimeFor(p: string): string {
  const e = path.extname(p).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".gif") return "image/gif";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

function getMlSettings(): MlSettings {
  return { ...DEFAULT_ML, ...(mlStore.get("settings") ?? {}) };
}
function projectRoot(): string {
  return app.getAppPath();
}
function mlEnv(s: MlSettings): NodeJS.ProcessEnv {
  return { ...process.env, EMBED_BACKBONE: s.backbone, PYTHONIOENCODING: "utf-8" };
}
function parsePGood(name: string): number {
  const m = PREFIX_RE.exec(name);
  return m ? Number(m[1]) / 100 : -1;
}

async function startPyJob(event: Electron.IpcMainInvokeEvent, scriptFile: string, args: string[]): Promise<MlJobResult> {
  const s = getMlSettings();
  const python = await resolvePython(s.pythonPath);
  const jobId = randomUUID();
  runJob({
    jobId,
    command: python,
    args: [path.join("ml", scriptFile), ...args],
    cwd: projectRoot(),
    env: mlEnv(s),
    sender: event.sender,
    channel: IPC.mlLog,
  });
  return { jobId };
}

function registerMlIpc(): void {
  ipcMain.handle(IPC.mlGetSettings, () => getMlSettings());
  ipcMain.handle(IPC.mlSetSettings, (_e, partial: Partial<MlSettings>) => {
    mlStore.set("settings", { ...getMlSettings(), ...partial });
    if ("pythonPath" in partial) clearPythonCache(); // 路径变了，作废自动探测缓存
    return true;
  });

  ipcMain.handle(IPC.mlDetectEnv, async (): Promise<MlEnvReport> => {
    // 用户主动点"检测环境"：清缓存强制重新探测（依赖可能刚装好/路径刚改）
    clearPythonCache();
    const s = getMlSettings();
    const python = await resolvePython(s.pythonPath);
    const probe = await probePython(python, projectRoot(), mlEnv(s));
    const modelPath = path.join(projectRoot(), "ml/model/aesthetic_clf.joblib");
    const reportPath = path.join(projectRoot(), "ml/model/train_report.json");
    const hasModel = fs.existsSync(modelPath);
    let report: TrainReport | null = null;
    try {
      report = JSON.parse(await fsp.readFile(reportPath, "utf-8")) as TrainReport;
    } catch {
      report = null;
    }
    const modelDim = report?.feature_dim ?? null;
    const bDim = backboneDim(s.backbone) || null;
    const modelBackbone = report?.backbone ?? null;
    return {
      pythonPath: python,
      ok: !probe.error && probe.missing.length === 0,
      pythonVersion: probe.pythonVersion,
      missing: probe.missing,
      hasModel,
      modelDim,
      backboneDim: bDim,
      dimMismatch: Boolean(modelDim && bDim && modelDim !== bDim),
      modelBackbone,
      backboneMismatch: Boolean(modelBackbone && modelBackbone !== s.backbone),
      report,
      error: probe.error,
    };
  });

  ipcMain.handle(IPC.mlNewRun, async (): Promise<MlRunPaths> => {
    const runId = randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = path.join(mlRunsDir, stamp);
    const toPredictDir = path.join(runDir, "to_predict");
    await fsp.mkdir(toPredictDir, { recursive: true });
    allowMedia(runDir);
    return { runId, runDir, toPredictDir };
  });

  ipcMain.handle(IPC.mlSelectFolder, async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ title: "选择图片文件夹", properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return null;
    allowMedia(r.filePaths[0]);
    return r.filePaths[0];
  });

  ipcMain.handle(IPC.mlExtract, (e, p: { xlsx: string; out: string; maxNotes: number; imgsPerNote: number }) => {
    allowMedia(p.out);
    const args = ["--input", p.xlsx, "--out", p.out, "--imgs-per-note", String(p.imgsPerNote)];
    if (p.maxNotes > 0) args.push("--max-notes", String(p.maxNotes));
    return startPyJob(e, "extract_images_only.py", args);
  });

  ipcMain.handle(IPC.mlPredict, (e, p: { input: string; sortTo: string; threshold: number }) => {
    allowMedia(p.sortTo);
    return startPyJob(e, "predict.py", ["--input", p.input, "--sort-to", p.sortTo, "--threshold", String(p.threshold)]);
  });

  ipcMain.handle(IPC.mlMerge, (e, p: { runDir: string }) => startPyJob(e, "merge_feedback.py", ["--from", p.runDir]));

  ipcMain.handle(IPC.mlTrain, (e) => startPyJob(e, "train_singleimage.py", []));

  ipcMain.handle(IPC.mlListSorted, async (_e, runDir: string): Promise<SortedImage[]> => {
    allowMedia(runDir);
    const out: SortedImage[] = [];
    for (const label of ["good", "bad"] as const) {
      const dir = path.join(runDir, label);
      let names: string[] = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) continue;
        const abs = path.join(dir, name);
        out.push({ name, path: abs, url: mediaUrl(abs), label, pGood: parsePGood(name) });
      }
    }
    out.sort((a, b) => b.pGood - a.pGood);
    return out;
  });

  ipcMain.handle(IPC.mlFlipImage, async (_e, p: { path: string; to: "good" | "bad" }): Promise<SortedImage | null> => {
    const abs = path.resolve(p.path);
    if (!isAllowedMedia(abs)) return null;
    const runDir = path.dirname(path.dirname(abs)); // runDir/<good|bad>/<file>
    const destDir = path.join(runDir, p.to);
    await fsp.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(abs));
    await fsp.rename(abs, dest);
    return { name: path.basename(dest), path: dest, url: mediaUrl(dest), label: p.to, pGood: parsePGood(path.basename(dest)) };
  });

  // 软删除：把图移到 runDir/_trash/<good|bad>/ 下，可撤销。合并训练时忽略 _trash/。
  ipcMain.handle(IPC.mlRemoveImage, async (_e, p: { path: string }): Promise<{ trashPath: string } | null> => {
    const abs = path.resolve(p.path);
    if (!isAllowedMedia(abs)) return null;
    const label = path.basename(path.dirname(abs)); // good | bad
    const runDir = path.dirname(path.dirname(abs));
    const trashDir = path.join(runDir, "_trash", label);
    allowMedia(trashDir);
    await fsp.mkdir(trashDir, { recursive: true });
    const dest = path.join(trashDir, path.basename(abs));
    await fsp.rename(abs, dest);
    return { trashPath: dest };
  });

  // 撤销软删除：从 _trash/<good|bad>/ 移回 runDir/<good|bad>/
  ipcMain.handle(IPC.mlRestoreImage, async (_e, p: { trashPath: string }): Promise<SortedImage | null> => {
    const abs = path.resolve(p.trashPath);
    if (!isAllowedMedia(abs)) return null;
    const label = path.basename(path.dirname(abs)) as "good" | "bad";
    if (label !== "good" && label !== "bad") return null;
    const runDir = path.dirname(path.dirname(path.dirname(abs))); // runDir/_trash/<label>/<file>
    const destDir = path.join(runDir, label);
    await fsp.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(abs));
    await fsp.rename(abs, dest);
    return { name: path.basename(dest), path: dest, url: mediaUrl(dest), label, pGood: parsePGood(path.basename(dest)) };
  });

  ipcMain.handle(IPC.mlGetReport, async (): Promise<TrainReport | null> => {
    try {
      return JSON.parse(await fsp.readFile(path.join(projectRoot(), "ml/model/train_report.json"), "utf-8")) as TrainReport;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.mlCancel, (_e, jobId: string) => cancelJob(jobId));
}

app.whenReady().then(() => {
  protocol.handle("vpmedia", async (req) => {
    const p = new URL(req.url).searchParams.get("p");
    if (!p || !isAllowedMedia(p)) return new Response("forbidden", { status: 403 });
    try {
      const data = await fsp.readFile(p);
      return new Response(new Uint8Array(data), { headers: { "content-type": mimeFor(p) } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  registerIpc();
  registerMlIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const child of runningChildren.values()) child.kill();
  killAllJobs();
  if (process.platform !== "darwin") app.quit();
});

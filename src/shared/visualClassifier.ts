import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import type { AppConfig } from "../config.js";
import { normalizeImageUrlList } from "./imageUrls.js";

/**
 * 抓后批量识图（方案 A）。
 *
 * 调用本地 CLIP 审美模型（ml/predict.py + aesthetic_clf.joblib）对每条记录的图片
 * 批量打分，把 P(good) 最高分聚合回填到记录的 visual* 字段。
 *
 * 全程「不阻断导出」：缺模型 / 无图 / Python 失败时，记录会带上 visualStatus 原因，
 * 主表照常导出，只是这些记录不会进入 qualified sheet。
 */

const QUALIFIED_YES = "\u662f"; // 是
const QUALIFIED_NO = "\u5426"; // 否
const QUALIFIED_UNKNOWN = "\u672a\u5224\u65ad"; // 未判断

const IMAGE_DOWNLOAD_TIMEOUT_MS = 12_000;

export interface ClassifiableRecord {
  imageUrls?: string[];
  coverUrl?: string;
  visualQualified?: string;
  visualScore?: number;
  visualReason?: string;
  visualHatType?: string;
  visualStatus?: string;
  visualAnalyzedImages?: string;
}

interface PredictResultRow {
  name: string;
  path: string;
  verdict: string;
  prob_good: number;
}

interface PredictPayload {
  error: string | null;
  threshold?: number;
  results: PredictResultRow[];
}

/**
 * 对一批记录做抓后批量识图并回填 visual* 字段，返回同一数组（原地标注后的副本）。
 */
export async function classifyRecordsVisual<T extends ClassifiableRecord>(
  records: T[],
  config: AppConfig,
  label: string,
): Promise<T[]> {
  if (!config.visualClassifierEnabled) {
    console.log(`[${label}:clip] visual classifier disabled.`);
    return records;
  }

  if (records.length === 0) {
    return records;
  }

  const scriptPath = config.visualClassifierScript;
  if (!(await fs.pathExists(scriptPath))) {
    console.warn(`[${label}:clip] predict 脚本不存在，跳过识图：${scriptPath}`);
    return records.map((record) => ({
      ...record,
      visualStatus: "\u672a\u8bc6\u56fe\uff08predict.py \u4e0d\u5b58\u5728\uff09",
      visualQualified: QUALIFIED_UNKNOWN,
    }));
  }

  const limit =
    config.visualClassifierMaxItems > 0
      ? Math.min(config.visualClassifierMaxItems, records.length)
      : records.length;
  const target = records.slice(0, limit);
  const skipped = records.slice(limit).map((record) => ({
    ...record,
    visualStatus: "\u672a\u8bc6\u56fe\uff08\u8d85\u8fc7\u8bc6\u56fe\u4e0a\u9650\uff09",
    visualQualified: QUALIFIED_UNKNOWN,
  }));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hat-clip-"));
  try {
    console.log(
      `[${label}:clip] downloading images for ${target.length}/${records.length} records ` +
        `(maxImages=${config.visualClassifierMaxImages}, concurrency=${config.visualClassifierConcurrency}, threshold=${config.visualClassifierThreshold})...`,
    );

    // 每条记录的图片落到 tempDir，文件名前缀 = 记录序号，便于回填聚合：r{idx}__{imgIdx}.{ext}
    const recordUrls: string[][] = target.map((record) =>
      normalizeImageUrlList(record.imageUrls?.length ? record.imageUrls : [record.coverUrl ?? ""]).slice(
        0,
        config.visualClassifierMaxImages,
      ),
    );

    const downloadJobs: Array<{ recordIndex: number; imgIndex: number; url: string }> = [];
    recordUrls.forEach((urls, recordIndex) => {
      urls.forEach((url, imgIndex) => {
        downloadJobs.push({ recordIndex, imgIndex, url });
      });
    });

    const savedByRecord = new Map<number, string[]>();
    let downloaded = 0;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(Math.max(config.visualClassifierConcurrency, 1), Math.max(downloadJobs.length, 1)) },
      async () => {
        while (cursor < downloadJobs.length) {
          const job = downloadJobs[cursor];
          cursor += 1;
          const saved = await downloadImageToFile(job.url, tempDir, job.recordIndex, job.imgIndex);
          if (saved) {
            const list = savedByRecord.get(job.recordIndex) ?? [];
            list.push(saved);
            savedByRecord.set(job.recordIndex, list);
          }
          downloaded += 1;
          if (downloaded % 25 === 0 || downloaded === downloadJobs.length) {
            console.log(`[${label}:clip] downloaded ${downloaded}/${downloadJobs.length} images.`);
          }
        }
      },
    );
    await Promise.all(workers);

    const totalSaved = Array.from(savedByRecord.values()).reduce((sum, list) => sum + list.length, 0);
    if (totalSaved === 0) {
      console.warn(`[${label}:clip] 没有任何图片下载成功，跳过识图。`);
      return [
        ...target.map((record) => ({
          ...record,
          visualStatus: "\u8bc6\u56fe\u5931\u8d25\uff08\u56fe\u7247\u5168\u90e8\u4e0b\u8f7d\u5931\u8d25\uff09",
          visualQualified: QUALIFIED_UNKNOWN,
        })),
        ...skipped,
      ];
    }

    console.log(`[${label}:clip] running predict.py on ${totalSaved} images...`);
    const payload = await runPredict(scriptPath, tempDir, config);

    if (payload.error) {
      const reason =
        payload.error === "model_not_found"
          ? "\u8bc6\u56fe\u5931\u8d25\uff08\u672c\u5730\u6a21\u578b\u4e0d\u5b58\u5728\uff0c\u8bf7\u5148\u8bad\u7ec3\uff09"
          : `\u8bc6\u56fe\u5931\u8d25\uff08${payload.error}\uff09`;
      console.warn(`[${label}:clip] predict 返回错误：${payload.error}`);
      return [
        ...target.map((record) => ({ ...record, visualStatus: reason, visualQualified: QUALIFIED_UNKNOWN })),
        ...skipped,
      ];
    }

    // 用文件名前缀把每图分数归到对应记录
    const probByFile = new Map<string, number>();
    for (const row of payload.results) {
      probByFile.set(path.basename(row.path), row.prob_good);
    }

    const threshold = config.visualClassifierThreshold;
    let qualifiedCount = 0;
    const scored = target.map((record, recordIndex) => {
      const files = savedByRecord.get(recordIndex) ?? [];
      const analyzedUrls = recordUrls[recordIndex];
      if (files.length === 0) {
        return {
          ...record,
          visualQualified: QUALIFIED_UNKNOWN,
          visualScore: 0,
          visualStatus: "\u8bc6\u56fe\u5931\u8d25\uff08\u65e0\u53ef\u7528\u56fe\u7247\uff09",
          visualReason: "\u56fe\u7247\u94fe\u63a5\u65e0\u6cd5\u4e0b\u8f7d\u6216\u5df2\u8fc7\u671f",
          visualAnalyzedImages: analyzedUrls.join("\n"),
        };
      }

      let bestProb = 0;
      for (const file of files) {
        const prob = probByFile.get(path.basename(file));
        if (typeof prob === "number" && prob > bestProb) {
          bestProb = prob;
        }
      }

      const qualified = bestProb >= threshold;
      if (qualified) {
        qualifiedCount += 1;
      }
      return {
        ...record,
        visualQualified: qualified ? QUALIFIED_YES : QUALIFIED_NO,
        visualScore: Math.round(bestProb * 100) / 100,
        visualReason: `\u672c\u5730CLIP P(good)=${bestProb.toFixed(2)}\uff08\u9608\u503c ${threshold}\uff09`,
        visualStatus: "\u5df2\u8bc6\u56fe",
        visualAnalyzedImages: analyzedUrls.join("\n"),
      };
    });

    console.log(
      `[${label}:clip] done. qualified=${qualifiedCount}/${scored.length} (threshold=${threshold}), skipped=${skipped.length}.`,
    );
    return [...scored, ...skipped];
  } catch (error) {
    console.warn(`[${label}:clip] 识图异常，记录将原样导出：${error instanceof Error ? error.message : String(error)}`);
    return records.map((record) => ({
      ...record,
      visualStatus: `\u8bc6\u56fe\u5f02\u5e38\uff1a${error instanceof Error ? error.message : String(error)}`.slice(0, 180),
      visualQualified: QUALIFIED_UNKNOWN,
    }));
  } finally {
    await fs.remove(tempDir).catch(() => undefined);
  }
}

async function runPredict(scriptPath: string, inputDir: string, config: AppConfig): Promise<PredictPayload> {
  const args = [
    scriptPath,
    "--input",
    inputDir,
    "--threshold",
    String(config.visualClassifierThreshold),
    "--json",
  ];

  return new Promise<PredictPayload>((resolve, reject) => {
    const child = spawn(config.visualClassifierPython, args, {
      cwd: path.dirname(path.dirname(scriptPath)), // 项目根（ml 的上一级）
      // 强制 Python stdout/stderr 用 UTF-8，避免 Windows 默认 GBK 输出与 Node 的 utf8 解码错位导致 JSON.parse 崩。
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`predict.py 超时（${config.visualClassifierTimeoutMs}ms）`));
    }, config.visualClassifierTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const jsonLine = extractLastJsonLine(stdout);
      if (jsonLine) {
        try {
          resolve(JSON.parse(jsonLine) as PredictPayload);
          return;
        } catch (error) {
          reject(new Error(`无法解析 predict.py JSON 输出：${error instanceof Error ? error.message : String(error)}`));
          return;
        }
      }
      if (code !== 0) {
        reject(new Error(`predict.py 退出码 ${code}：${stderr.trim().slice(-300)}`));
        return;
      }
      reject(new Error(`predict.py 未输出 JSON：${stderr.trim().slice(-300)}`));
    });
  });
}

function extractLastJsonLine(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.startsWith("{") && line.endsWith("}")) {
      return line;
    }
  }
  return null;
}

async function downloadImageToFile(
  url: string,
  dir: string,
  recordIndex: number,
  imgIndex: number,
): Promise<string | null> {
  const normalizedUrl = url.trim();
  if (!normalizedUrl || !/^https?:\/\//i.test(normalizedUrl)) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(normalizedUrl, {
      signal: controller.signal,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: resolveImageReferer(normalizedUrl),
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      return null;
    }
    const extension = resolveImageExtension(response.headers.get("content-type"), normalizedUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength < 1024) {
      return null;
    }
    const fileName = `r${String(recordIndex).padStart(5, "0")}__${String(imgIndex).padStart(2, "0")}.${extension}`;
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, buffer);
    return filePath;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveImageReferer(url: string): string {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes("xhscdn.com") || lowerUrl.includes("xiaohongshu.com")) {
    return "https://www.xiaohongshu.com/";
  }
  if (
    lowerUrl.includes("douyinpic.com") ||
    lowerUrl.includes("byteimg.com") ||
    lowerUrl.includes("pstatp.com") ||
    lowerUrl.includes("douyinstatic.com")
  ) {
    return "https://www.douyin.com/";
  }
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function resolveImageExtension(contentType: string | null, url: string): string {
  const normalizedContentType = (contentType || "").toLowerCase();
  if (normalizedContentType.includes("image/png")) return "png";
  if (normalizedContentType.includes("image/jpeg") || normalizedContentType.includes("image/jpg")) return "jpg";
  if (normalizedContentType.includes("image/gif")) return "gif";
  if (normalizedContentType.includes("image/webp")) return "webp";

  const pathname = safePathname(url).toLowerCase();
  if (pathname.endsWith(".png")) return "png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "jpg";
  if (pathname.endsWith(".gif")) return "gif";
  if (pathname.endsWith(".webp")) return "webp";

  return "webp";
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

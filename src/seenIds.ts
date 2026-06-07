/**
 * 跨次运行的已抓取 ID 持久化缓存。
 *
 * 按"平台+关键词"分文件存储，每行一个 ID（NDJSON-ish 格式），只追加、不重写。
 * 文件路径：<outputDir>/.seen-ids/<platform>-<keyword>.txt
 *
 * 设计原则：
 * - 读写都在抓取结束后的单次同步路径，不影响抓取本身的性能。
 * - 文件损坏/不存在时静默降级为空集合，不中断抓取。
 * - ID 只增不减；若需要清空历史，删掉对应 .txt 文件即可。
 */

import fs from "node:fs";
import path from "node:path";

function cacheFilePath(outputDir: string, platform: string, keyword: string): string {
  const safe = keyword.replace(/[^\w\u4e00-\u9fa5-]/g, "_").slice(0, 60);
  return path.join(outputDir, ".seen-ids", `${platform}-${safe}.txt`);
}

/** 从磁盘加载已见过的 ID 集合。文件不存在或损坏时返回空 Set。 */
export function loadSeenIds(outputDir: string, platform: string, keyword: string): Set<string> {
  const filePath = cacheFilePath(outputDir, platform, keyword);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const ids = new Set<string>();
    for (const line of content.split("\n")) {
      const id = line.trim();
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

/** 将新 ID 追加写入磁盘缓存（只写本次新增的，不重写全文件）。 */
export function saveSeenIds(outputDir: string, platform: string, keyword: string, newIds: string[]): void {
  if (newIds.length === 0) return;
  const filePath = cacheFilePath(outputDir, platform, keyword);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, newIds.join("\n") + "\n", "utf-8");
  } catch (err) {
    console.warn(`[seenIds] 写入缓存失败（${filePath}）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

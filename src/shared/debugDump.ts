import path from "node:path";
import fs from "fs-extra";
import type { Platform } from "../types.js";

export async function writeDebugDump(
  outputDir: string,
  platform: Platform,
  index: number,
  url: string,
  body: unknown,
): Promise<string> {
  await fs.ensureDir(outputDir);
  const filename = `debug-${platform}-${Date.now()}-${index}-${pathSlug(url)}.json`;
  const filepath = path.join(outputDir, filename);
  await fs.writeJson(filepath, { url, body }, { spaces: 2 });
  return filepath;
}

function pathSlug(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "_").slice(0, 60) || "root";
  } catch {
    return "url";
  }
}

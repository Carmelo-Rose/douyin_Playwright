/**
 * 一次性工具：扫描历史表格，把已有的视频ID/笔记ID导入 seenIds 缓存。
 * 运行后，后续抓取会自动跳过这些历史内容。
 *
 * 用法：
 *   npx tsx scripts/import-seen-ids.ts [--dir <output目录>]
 *   默认 dir = output/
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ExcelJS from "exceljs";
import { loadSeenIds, saveSeenIds } from "../src/seenIds.js";

function readCliValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function resolveOutputDir(): string {
  const raw = readCliValue("--dir") || "output";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/** 从文件名猜平台和关键词：
 *  douyin-videos-帽子-20260607-171847.xlsx  → { platform: "douyin", keyword: "帽子" }
 *  xhs-notes-帽子-20260607-171847.xlsx      → { platform: "xhs",    keyword: "帽子" }
 */
function parseMeta(name: string): { platform: "douyin" | "xhs"; keyword: string } | null {
  const m = name.match(/^(douyin|xhs)-[^-]+-(.+?)-\d{8}-\d{6}\.xlsx$/i);
  if (!m) return null;
  return { platform: m[1].toLowerCase() as "douyin" | "xhs", keyword: m[2] };
}

async function readFirstColumnIds(filePath: string): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const ids: string[] = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return; // 跳过表头
    const cell = row.getCell(1);
    const val = cell.value;
    const id = val == null ? "" : typeof val === "object" ? String((val as { text?: string }).text ?? val) : String(val);
    if (id.trim()) ids.push(id.trim());
  });
  return ids;
}

async function main(): Promise<void> {
  const outputDir = resolveOutputDir();
  console.log(`扫描目录：${outputDir}`);

  let files: string[];
  try {
    files = fs.readdirSync(outputDir).filter((f) => f.toLowerCase().endsWith(".xlsx"));
  } catch {
    console.error(`目录不存在或无法读取：${outputDir}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log("未找到任何 .xlsx 文件，无需导入。");
    return;
  }

  // 按平台+关键词分组收集 ID
  const groups = new Map<string, { platform: "douyin" | "xhs"; keyword: string; ids: Set<string> }>();

  for (const file of files) {
    const meta = parseMeta(file);
    if (!meta) {
      console.log(`  跳过（无法识别格式）：${file}`);
      continue;
    }

    const key = `${meta.platform}|${meta.keyword}`;
    if (!groups.has(key)) {
      groups.set(key, { platform: meta.platform, keyword: meta.keyword, ids: new Set() });
    }

    const filePath = path.join(outputDir, file);
    process.stdout.write(`  读取 ${file} ...`);
    const ids = await readFirstColumnIds(filePath);
    const group = groups.get(key)!;
    for (const id of ids) group.ids.add(id);
    console.log(` ${ids.length} 条`);
  }

  // 写入缓存（与现有缓存合并，只追加新的）
  console.log("\n写入 seenIds 缓存：");
  for (const { platform, keyword, ids } of groups.values()) {
    const existing = loadSeenIds(outputDir, platform, keyword);
    const newIds = [...ids].filter((id) => !existing.has(id));
    if (newIds.length === 0) {
      console.log(`  ${platform} / ${keyword}：全部已在缓存中，无需写入`);
    } else {
      saveSeenIds(outputDir, platform, keyword, newIds);
      console.log(`  ${platform} / ${keyword}：新增 ${newIds.length} 条（已有 ${existing.size} 条）`);
    }
  }

  console.log("\n完成。后续抓取将自动跳过以上历史内容。");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

import path from "node:path";
import process from "node:process";
import ExcelJS from "exceljs";
import fs from "fs-extra";
import { loadConfig } from "../../config.js";
import type { AppConfig } from "../../config.js";
import type { NoteRecord } from "../../types.js";
import { scoreXhsVisualQuality } from "./visualFilter.js";

interface WorkbookRow {
  rowNumber: number;
  note: NoteRecord;
  firstImageUrl: string;
}

const REQUIRED_HEADERS = {
  noteId: "笔记ID",
  source: "来源",
  title: "标题",
  desc: "正文",
  authorName: "作者",
  authorId: "作者ID",
  createTime: "发布时间",
  likedCount: "点赞数",
  commentCount: "评论数",
  collectCount: "收藏数",
  shareUrl: "笔记链接",
  linkStatus: "链接状态",
  imageUrlsText: "图片链接",
  detailImageStatus: "详情补图状态",
  visualQualified: "视觉合格",
  visualScore: "视觉分数",
  visualHatType: "帽子类型",
  visualStatus: "视觉状态",
  visualReason: "视觉原因",
  visualAnalyzedImages: "已分析图片",
  coverUrl: "封面链接",
  capturedAt: "抓取时间",
} as const;

async function main(): Promise<void> {
  const inputPath = resolveInputPath();
  const config = withWorkbookScoringDefaults(loadConfig({ defaultPlatform: "xhs" }));
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.readFile(inputPath);
  const worksheet = workbook.getWorksheet("notes");
  if (!worksheet) {
    throw new Error(`Workbook is missing the notes sheet: ${inputPath}`);
  }

  const header = buildHeaderMap(worksheet);
  ensureRequiredColumns(worksheet, header);

  const rows = collectWorkbookRows(worksheet, header);
  console.log(`[xhs:workbook] input: ${inputPath}`);
  console.log(`[xhs:workbook] rows: ${rows.length}, model=${config.dashscopeModel}, maxImages=1`);

  const scored = await scoreXhsVisualQuality(
    rows.map((item) => item.note),
    config,
  );

  for (let index = 0; index < rows.length; index += 1) {
    writeScoreToRow(worksheet.getRow(rows[index].rowNumber), header, scored[index]);
  }

  await saveWorkbookInPlace(workbook, inputPath);
  console.log(`[xhs:workbook] saved in place: ${inputPath}`);
}

function withWorkbookScoringDefaults(config: AppConfig): AppConfig {
  return {
    ...config,
    xhsVisualFilter: true,
    xhsVisualMaxImages: 1,
    xhsVisualMaxItems: 0,
  };
}

async function saveWorkbookInPlace(workbook: ExcelJS.Workbook, inputPath: string): Promise<void> {
  const parsed = path.parse(inputPath);
  const tempPath = path.join(parsed.dir, `.${parsed.name}.tmp-${process.pid}${parsed.ext}`);
  try {
    await workbook.xlsx.writeFile(tempPath);
    try {
      await fs.move(tempPath, inputPath, { overwrite: true });
    } catch (moveError) {
      if (!isBusyError(moveError)) {
        throw moveError;
      }
      await fs.copy(tempPath, inputPath, { overwrite: true });
      await fs.remove(tempPath);
    }
  } catch (error) {
    await fs.remove(tempPath).catch(() => undefined);
    throw error;
  }
}

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "EBUSY" || code === "EPERM";
}

function resolveInputPath(): string {
  const input = readCliValue("--input");
  if (!input) {
    throw new Error('Missing --input. Example: npm run score:xhs-workbook -- --input "output/xhs-notes-帽子-20260605-093632.xlsx"');
  }
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function buildHeaderMap(worksheet: ExcelJS.Worksheet): Map<string, number> {
  const header = new Map<string, number>();
  worksheet.getRow(1).eachCell((cell, columnNumber) => {
    const value = cellText(cell).trim();
    if (value && !header.has(value)) {
      header.set(value, columnNumber);
    }
  });
  return header;
}

function ensureRequiredColumns(worksheet: ExcelJS.Worksheet, header: Map<string, number>): void {
  if (!header.has(REQUIRED_HEADERS.imageUrlsText)) {
    throw new Error(`notes sheet is missing required column: ${REQUIRED_HEADERS.imageUrlsText}`);
  }

  for (const name of [
    REQUIRED_HEADERS.visualQualified,
    REQUIRED_HEADERS.visualScore,
    REQUIRED_HEADERS.visualHatType,
    REQUIRED_HEADERS.visualStatus,
    REQUIRED_HEADERS.visualReason,
    REQUIRED_HEADERS.visualAnalyzedImages,
  ]) {
    if (!header.has(name)) {
      const columnNumber = worksheet.columnCount + 1;
      worksheet.getRow(1).getCell(columnNumber).value = name;
      header.set(name, columnNumber);
    }
  }
}

function collectWorkbookRows(worksheet: ExcelJS.Worksheet, header: Map<string, number>): WorkbookRow[] {
  const rows: WorkbookRow[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (rowIsEmpty(row)) {
      continue;
    }

    const imageUrls = splitImageUrls(readCell(row, header, REQUIRED_HEADERS.imageUrlsText));
    const firstImageUrl = imageUrls[0] ?? "";
    rows.push({
      rowNumber,
      firstImageUrl,
      note: {
        noteId: readCell(row, header, REQUIRED_HEADERS.noteId) || `row-${rowNumber}`,
        source: readCell(row, header, REQUIRED_HEADERS.source),
        noteType: "image",
        title: readCell(row, header, REQUIRED_HEADERS.title),
        desc: readCell(row, header, REQUIRED_HEADERS.desc),
        createTime: readCell(row, header, REQUIRED_HEADERS.createTime),
        authorName: readCell(row, header, REQUIRED_HEADERS.authorName),
        authorId: readCell(row, header, REQUIRED_HEADERS.authorId),
        likedCount: readNumberCell(row, header, REQUIRED_HEADERS.likedCount),
        commentCount: readNumberCell(row, header, REQUIRED_HEADERS.commentCount),
        collectCount: readNumberCell(row, header, REQUIRED_HEADERS.collectCount),
        shareUrl: readCell(row, header, REQUIRED_HEADERS.shareUrl),
        linkStatus: readCell(row, header, REQUIRED_HEADERS.linkStatus),
        coverUrl: firstImageUrl,
        imageUrls: firstImageUrl ? [firstImageUrl] : [],
        detailImageStatus: readCell(row, header, REQUIRED_HEADERS.detailImageStatus),
        capturedAt: readCell(row, header, REQUIRED_HEADERS.capturedAt),
        rawSnippet: "",
      },
    });
  }
  return rows;
}

function writeScoreToRow(row: ExcelJS.Row, header: Map<string, number>, note: NoteRecord): void {
  setCell(row, header, REQUIRED_HEADERS.visualQualified, note.visualQualified ?? "");
  setCell(row, header, REQUIRED_HEADERS.visualScore, note.visualScore ?? "");
  setCell(row, header, REQUIRED_HEADERS.visualHatType, note.visualHatType ?? "");
  setCell(row, header, REQUIRED_HEADERS.visualStatus, note.visualStatus ?? "");
  setCell(row, header, REQUIRED_HEADERS.visualReason, note.visualReason ?? "");
  setCell(row, header, REQUIRED_HEADERS.visualAnalyzedImages, note.visualAnalyzedImages ?? "");
  row.commit();
}

function splitImageUrls(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function rowIsEmpty(row: ExcelJS.Row): boolean {
  let hasValue = false;
  row.eachCell((cell) => {
    if (cellText(cell).trim()) {
      hasValue = true;
    }
  });
  return !hasValue;
}

function readCell(row: ExcelJS.Row, header: Map<string, number>, name: string): string {
  const column = header.get(name);
  return column ? cellText(row.getCell(column)).trim() : "";
}

function readNumberCell(row: ExcelJS.Row, header: Map<string, number>, name: string): number {
  const value = readCell(row, header, name).replace(/,/g, "");
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function setCell(row: ExcelJS.Row, header: Map<string, number>, name: string, value: string | number): void {
  const column = header.get(name);
  if (!column) {
    throw new Error(`Missing output column: ${name}`);
  }
  row.getCell(column).value = value;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) {
    return "";
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text: unknown }).text ?? "");
  }
  if (typeof value === "object" && "richText" in value) {
    return (value as { richText: { text: string }[] }).richText.map((part) => part.text).join("");
  }
  if (typeof value === "object" && "result" in value) {
    return String((value as { result: unknown }).result ?? "");
  }
  return String(value);
}

function readCliValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index !== -1) {
    return process.argv[index + 1];
  }

  const prefix = `${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

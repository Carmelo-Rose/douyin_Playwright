import path from "node:path";
import ExcelJS from "exceljs";
import fs from "fs-extra";
import type { NoteRecord, VideoRecord } from "./types.js";

export async function exportVideosToXlsx(videos: VideoRecord[], outputDir: string, keyword: string): Promise<string> {
  await fs.ensureDir(outputDir);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "douyin_playwright";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("videos");
  worksheet.columns = [
    { header: "视频ID", key: "awemeId", width: 22 },
    { header: "来源", key: "source", width: 18 },
    { header: "标题/描述", key: "desc", width: 60 },
    { header: "作者", key: "authorName", width: 24 },
    { header: "发布时间", key: "createTime", width: 24 },
    { header: "点赞数", key: "diggCount", width: 12 },
    { header: "评论数", key: "commentCount", width: 12 },
    { header: "分享数", key: "shareCount", width: 12 },
    { header: "收藏数", key: "collectCount", width: 12 },
    { header: "分享链接", key: "shareUrl", width: 50 },
    { header: "封面链接", key: "coverUrl", width: 60 },
    { header: "抓取时间", key: "capturedAt", width: 24 },
  ];

  worksheet.addRows(videos);
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  const filename = `douyin-videos-${sanitizeFilename(keyword)}-${formatTimestamp(new Date())}.xlsx`;
  const outputPath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(outputPath);

  return outputPath;
}

export async function exportNotesToXlsx(notes: NoteRecord[], outputDir: string, keyword: string): Promise<string> {
  await fs.ensureDir(outputDir);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "douyin_playwright";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("notes");
  worksheet.columns = [
    { header: "笔记ID", key: "noteId", width: 28 },
    { header: "来源", key: "source", width: 18 },
    { header: "标题", key: "title", width: 36 },
    { header: "正文", key: "desc", width: 60 },
    { header: "作者", key: "authorName", width: 24 },
    { header: "作者ID", key: "authorId", width: 24 },
    { header: "发布时间", key: "createTime", width: 24 },
    { header: "点赞数", key: "likedCount", width: 12 },
    { header: "评论数", key: "commentCount", width: 12 },
    { header: "收藏数", key: "collectCount", width: 12 },
    { header: "笔记链接", key: "shareUrl", width: 50 },
    { header: "封面链接", key: "coverUrl", width: 60 },
    { header: "抓取时间", key: "capturedAt", width: 24 },
  ];

  worksheet.addRows(notes);
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  const filename = `xhs-notes-${sanitizeFilename(keyword)}-${formatTimestamp(new Date())}.xlsx`;
  const outputPath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(outputPath);

  return outputPath;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "keyword";
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

import path from "node:path";
import ExcelJS from "exceljs";
import fs from "fs-extra";
import type { ContentType, NoteRecord, VideoRecord } from "./types.js";
import { normalizeImageUrlList } from "./shared/imageUrls.js";

type ImageExtension = "jpeg" | "png" | "gif" | "webp";
interface WorkbookImage {
  base64: string;
  extension: ImageExtension;
}

const THUMBNAIL_COLUMN_WIDTH = 18;
const THUMBNAIL_ROW_HEIGHT = 82;
const THUMBNAIL_SIZE = 88;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 12_000;
const IMAGE_DOWNLOAD_CONCURRENCY = 4;
const VIDEO_EMBEDDED_IMAGE_COUNT = 6;
const NOTE_EMBEDDED_IMAGE_COUNT = 6;

export async function exportVideosToXlsx(videos: VideoRecord[], outputDir: string, keyword: string, contentType: ContentType = "video"): Promise<string> {
  await fs.ensureDir(outputDir);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "douyin_playwright";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet(contentType === "image" ? "notes" : "videos");
  worksheet.columns = [
    { header: contentType === "image" ? "图文ID" : "视频ID", key: "awemeId", width: 22 },
    { header: "来源", key: "source", width: 18 },
    { header: "标题/描述", key: "desc", width: 60 },
    { header: "作者", key: "authorName", width: 24 },
    { header: "发布时间", key: "createTime", width: 24 },
    { header: "点赞数", key: "diggCount", width: 12 },
    { header: "评论数", key: "commentCount", width: 12 },
    { header: "分享数", key: "shareCount", width: 12 },
    { header: "收藏数", key: "collectCount", width: 12 },
    { header: "分享链接", key: "shareUrl", width: 50 },
    ...Array.from({ length: VIDEO_EMBEDDED_IMAGE_COUNT }, (_, index) => ({
      header: `图片${index + 1}`,
      key: `image${index + 1}`,
      width: THUMBNAIL_COLUMN_WIDTH,
    })),
    { header: "图片链接", key: "imageUrlsText", width: 80 },
    { header: "详情补图状态", key: "detailImageStatus", width: 24 },
    { header: "视觉合格", key: "visualQualified", width: 14 },
    { header: "视觉分数", key: "visualScore", width: 12 },
    { header: "帽子类型", key: "visualHatType", width: 16 },
    { header: "视觉状态", key: "visualStatus", width: 24 },
    { header: "视觉原因", key: "visualReason", width: 50 },
    { header: "已分析图片", key: "visualAnalyzedImages", width: 60 },
    { header: "封面链接", key: "coverUrl", width: 60 },
    { header: "抓取时间", key: "capturedAt", width: 24 },
  ];

  worksheet.addRows(videos.map(videoToXlsxRow));
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  await embedImageGrid(workbook, worksheet, videos.map((video) => resolveVideoImageUrls(video).slice(0, VIDEO_EMBEDDED_IMAGE_COUNT)), 11);
  addQualifiedVideosSheet(workbook, videos, contentType);

  const filenamePrefix = contentType === "image" ? "douyin-notes" : "douyin-videos";
  const filename = `${filenamePrefix}-${sanitizeFilename(keyword)}-${formatTimestamp(new Date())}.xlsx`;
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
    { header: "笔记链接", key: "shareUrl", width: 72 },
    { header: "链接状态", key: "linkStatus", width: 20 },
    ...Array.from({ length: NOTE_EMBEDDED_IMAGE_COUNT }, (_, index) => ({
      header: `图片${index + 1}`,
      key: `image${index + 1}`,
      width: THUMBNAIL_COLUMN_WIDTH,
    })),
    { header: "图片链接", key: "imageUrlsText", width: 80 },
    { header: "详情补图状态", key: "detailImageStatus", width: 24 },
    { header: "视觉合格", key: "visualQualified", width: 14 },
    { header: "视觉分数", key: "visualScore", width: 12 },
    { header: "帽子类型", key: "visualHatType", width: 16 },
    { header: "视觉状态", key: "visualStatus", width: 24 },
    { header: "视觉原因", key: "visualReason", width: 50 },
    { header: "已分析图片", key: "visualAnalyzedImages", width: 60 },
    { header: "封面链接", key: "coverUrl", width: 60 },
    { header: "抓取时间", key: "capturedAt", width: 24 },
  ];

  worksheet.addRows(notes.map(noteToXlsxRow));
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  await embedImageGrid(workbook, worksheet, notes.map((note) => resolveNoteImageUrls(note).slice(0, NOTE_EMBEDDED_IMAGE_COUNT)), 13);
  addQualifiedNotesSheet(workbook, notes);

  const filename = `xhs-notes-${sanitizeFilename(keyword)}-${formatTimestamp(new Date())}.xlsx`;
  const outputPath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(outputPath);

  return outputPath;
}

function videoToXlsxRow(video: VideoRecord): VideoRecord & { imageUrlsText: string } {
  return {
    ...video,
    imageUrlsText: resolveVideoImageUrls(video).join("\n"),
  };
}

function resolveVideoImageUrls(video: VideoRecord): string[] {
  const urls = video.imageUrls?.length ? video.imageUrls : [video.coverUrl];
  return normalizeImageUrlList(urls);
}

function addQualifiedVideosSheet(workbook: ExcelJS.Workbook, videos: VideoRecord[], contentType: ContentType): void {
  const qualified = videos
    .filter((video) => video.visualQualified === "是" || video.visualQualified === "疑似")
    // 按 P(good) 降序：模型的核心价值是排序，best-first 便于人工终审从高分往下挑
    .sort((a, b) => (b.visualScore ?? 0) - (a.visualScore ?? 0));
  const worksheet = workbook.addWorksheet("qualified");
  worksheet.columns = [
    { header: "视觉合格", key: "visualQualified", width: 14 },
    { header: "视觉分数", key: "visualScore", width: 12 },
    { header: "帽子类型", key: "visualHatType", width: 16 },
    { header: "分享链接", key: "shareUrl", width: 50 },
    { header: contentType === "image" ? "图文ID" : "视频ID", key: "awemeId", width: 22 },
    { header: "标题/描述", key: "desc", width: 60 },
    { header: "作者", key: "authorName", width: 24 },
    { header: "发布时间", key: "createTime", width: 24 },
    { header: "点赞数", key: "diggCount", width: 12 },
    { header: "收藏数", key: "collectCount", width: 12 },
    { header: "视觉原因", key: "visualReason", width: 50 },
    { header: "图片链接", key: "imageUrlsText", width: 80 },
  ];
  worksheet.addRows(qualified.map(videoToXlsxRow));
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
}

function noteToXlsxRow(note: NoteRecord): NoteRecord & { imageUrlsText: string } {
  return {
    ...note,
    imageUrlsText: resolveNoteImageUrls(note).join("\n"),
  };
}

function addQualifiedNotesSheet(workbook: ExcelJS.Workbook, notes: NoteRecord[]): void {
  const qualified = notes
    .filter((note) => note.visualQualified === "是" || note.visualQualified === "疑似")
    // 按 P(good) 降序：模型的核心价值是排序，best-first 便于人工终审从高分往下挑
    .sort((a, b) => (b.visualScore ?? 0) - (a.visualScore ?? 0));
  const worksheet = workbook.addWorksheet("qualified");
  worksheet.columns = [
    { header: "视觉合格", key: "visualQualified", width: 14 },
    { header: "视觉分数", key: "visualScore", width: 12 },
    { header: "帽子类型", key: "visualHatType", width: 16 },
    { header: "笔记链接", key: "shareUrl", width: 72 },
    { header: "标题", key: "title", width: 40 },
    { header: "作者", key: "authorName", width: 24 },
    { header: "发布时间", key: "createTime", width: 24 },
    { header: "点赞数", key: "likedCount", width: 12 },
    { header: "收藏数", key: "collectCount", width: 12 },
    { header: "视觉原因", key: "visualReason", width: 50 },
    { header: "图片链接", key: "imageUrlsText", width: 80 },
    { header: "笔记ID", key: "noteId", width: 28 },
  ];
  worksheet.addRows(qualified.map(noteToXlsxRow));
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
}

function resolveNoteImageUrls(note: NoteRecord): string[] {
  const urls = note.imageUrls?.length ? note.imageUrls : [note.coverUrl];
  return normalizeImageUrlList(urls);
}

async function embedImageGrid(
  workbook: ExcelJS.Workbook,
  worksheet: ExcelJS.Worksheet,
  imageRows: string[][],
  firstImageColumnNumber: number,
): Promise<void> {
  const imageCache = new Map<string, Promise<WorkbookImage | null>>();
  const uniqueUrls = normalizeImageUrlList(imageRows.flat());
  let cursor = 0;
  let completed = 0;

  if (uniqueUrls.length > 0) {
    console.log(`[xlsx:images] downloading ${uniqueUrls.length} image(s), concurrency=${IMAGE_DOWNLOAD_CONCURRENCY}...`);
    const workers = Array.from(
      { length: Math.min(IMAGE_DOWNLOAD_CONCURRENCY, uniqueUrls.length) },
      async () => {
        while (cursor < uniqueUrls.length) {
          const url = uniqueUrls[cursor];
          cursor += 1;
          const image = await downloadImage(url);
          imageCache.set(url, Promise.resolve(image));
          completed += 1;
          if (completed % 10 === 0 || completed === uniqueUrls.length) {
            console.log(`[xlsx:images] downloaded ${completed}/${uniqueUrls.length}.`);
          }
        }
      },
    );
    await Promise.all(workers);
  }

  for (let index = 0; index < imageRows.length; index += 1) {
    const rowNumber = index + 2;
    const row = worksheet.getRow(rowNumber);
    row.height = THUMBNAIL_ROW_HEIGHT;

    for (let imageIndex = 0; imageIndex < imageRows[index].length; imageIndex += 1) {
      const imageColumnNumber = firstImageColumnNumber + imageIndex;
      row.getCell(imageColumnNumber).value = "";

      const imageUrl = imageRows[index][imageIndex];
      const image = await cachedDownloadImage(imageUrl, imageCache);
      if (!image) {
        continue;
      }

      const imageId = workbook.addImage(image as ExcelJS.Image);
      worksheet.addImage(imageId, {
        tl: { col: imageColumnNumber - 1 + 0.08, row: rowNumber - 1 + 0.08 },
        ext: { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE },
        editAs: "oneCell",
      });
    }
  }
}

function cachedDownloadImage(url: string, cache: Map<string, Promise<WorkbookImage | null>>): Promise<WorkbookImage | null> {
  const normalizedUrl = url.trim();
  if (!cache.has(normalizedUrl)) {
    cache.set(normalizedUrl, downloadImage(normalizedUrl));
  }
  return cache.get(normalizedUrl)!;
}

async function downloadImage(url: string): Promise<WorkbookImage | null> {
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      console.warn(`Could not download cover image (${response.status}): ${normalizedUrl}`);
      return null;
    }

    const extension = resolveImageExtension(response.headers.get("content-type"), normalizedUrl);
    if (!extension) {
      console.warn(`Unsupported cover image format, keeping link only: ${normalizedUrl}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return { base64: `data:image/${extension};base64,${buffer.toString("base64")}`, extension };
  } catch (error) {
    console.warn(`Could not download cover image: ${error instanceof Error ? error.message : String(error)}`);
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
  if (lowerUrl.includes("douyinpic.com") || lowerUrl.includes("byteimg.com") || lowerUrl.includes("pstatp.com") || lowerUrl.includes("douyinstatic.com")) {
    return "https://www.douyin.com/";
  }

  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function resolveImageExtension(contentType: string | null, url: string): ImageExtension | null {
  const normalizedContentType = (contentType || "").toLowerCase();
  if (normalizedContentType.includes("image/png")) {
    return "png";
  }
  if (normalizedContentType.includes("image/jpeg") || normalizedContentType.includes("image/jpg")) {
    return "jpeg";
  }
  if (normalizedContentType.includes("image/gif")) {
    return "gif";
  }
  if (normalizedContentType.includes("image/webp")) {
    return "webp";
  }

  const pathname = safePathname(url).toLowerCase();
  if (pathname.endsWith(".png")) {
    return "png";
  }
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "jpeg";
  }
  if (pathname.endsWith(".gif")) {
    return "gif";
  }
  if (pathname.endsWith(".webp")) {
    return "webp";
  }

  return null;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
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

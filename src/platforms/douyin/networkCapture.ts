import path from "node:path";
import process from "node:process";
import type { Page, Response } from "playwright";
import { normalizeCandidates } from "./normalize.js";
import { writeDebugDump } from "../../shared/debugDump.js";
import type { ContentType, RawVideoCandidate, VideoRecord } from "../../types.js";

const URL_PREFIX_ALLOW = [
  "/aweme/v1/web/",
  "/aweme/v2/web/",
];

const URL_BLACKLIST = [
  "verifycenter",
  "captcha",
  "survey",
  "questionnaire",
  "/nps",
  "feedback",
  "monitor",
  "track",
  "report",
  "/im/",
  "notice",
  "emoji",
  "emoticon",
  "sticker",
  "favorite",
  "watermark",
  "hot/search",
  "abtest",
  "carnival",
  "installed",
  "passport",
  "webcast/setting",
  "spotlight",
  "multicast",
  "mix/listcollection",
  "page/turn",
  "solution/resource",
  "user/settings",
  "user/info",
  "ttwid",
  "creator/external",
  "activity/pull",
  "suggest_words",
  "search/sug",
  "select/tab/course",
  "test/settings",
  "ab/params",
  "external/notification",
  "social/count",
  "query/user",
];

const DEBUG = process.env.DEBUG_CAPTURE === "true" || process.env.DEBUG_CAPTURE === "1";
const DEBUG_DUMP_DIR = path.resolve(process.cwd(), "output");
const DEBUG_DUMP_MAX = 15;
const RESPONSE_READ_TIMEOUT_MS = 10_000;

export interface NetworkCaptureHandle {
  getVideos: () => VideoRecord[];
  flush: () => Promise<void>;
  reset: () => void;
}

interface NetworkCaptureOptions {
  contentType?: ContentType;
}

export function attachNetworkCapture(page: Page, options: NetworkCaptureOptions = {}): NetworkCaptureHandle {
  const videos: VideoRecord[] = [];
  const seenUrls = new Set<string>();
  const pendingResponses = new Set<Promise<void>>();
  let dumpsWritten = 0;

  page.on("response", async (response) => {
    if (DEBUG && ["xhr", "fetch"].includes(response.request().resourceType()) && response.status() >= 200 && response.status() < 400) {
      const u = response.url();
      const lower = u.toLowerCase();
      const skip = URL_BLACKLIST.some((k) => lower.includes(k)) || lower.includes(".js") || lower.includes(".css") || lower.includes(".png") || lower.includes(".jpg") || lower.includes(".webp");
      if (!skip) {
        const short = u.length > 220 ? u.slice(0, 220) + "..." : u;
        console.log(`[xhr] ${short}`);
      }
    }
    if (!isCandidateResponse(response) || seenUrls.has(response.url())) {
      return;
    }

    seenUrls.add(response.url());

    const task = (async () => {
      const payloads = await readResponsePayloads(response);
      if (payloads.length === 0) {
        return;
      }

      const candidates = payloads.flatMap((payload) => extractCandidatesFromJson(payload, options.contentType));
      if (DEBUG) {
        console.log(`[capture] url=${response.url()} payloads=${payloads.length} candidates=${candidates.length}`);
        if (dumpsWritten < DEBUG_DUMP_MAX) {
          dumpsWritten += 1;
          writeDebugDump(DEBUG_DUMP_DIR, "douyin", dumpsWritten, response.url(), payloads.length === 1 ? payloads[0] : payloads)
            .then((filepath) => console.log(`[capture] dumped raw response to ${filepath}`))
            .catch((err: unknown) => console.warn(`[capture] dump failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
      videos.push(...normalizeCandidates(candidates));
    })();

    pendingResponses.add(task);
    task.finally(() => pendingResponses.delete(task)).catch(() => undefined);
  });

  return {
    getVideos: () => videos,
    flush: async () => {
      // Wait for responses already in flight without being held open by
      // background requests that the live search page starts afterward.
      await Promise.allSettled(Array.from(pendingResponses));
    },
    reset: () => {
      videos.length = 0;
      seenUrls.clear();
      if (DEBUG) {
        console.log("[capture] buffer reset");
      }
    },
  };
}

async function readResponsePayloads(response: Response): Promise<unknown[]> {
  let text: string;
  try {
    text = await withTimeout(response.text(), RESPONSE_READ_TIMEOUT_MS);
  } catch {
    return [];
  }

  return parseJsonPayloads(text);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  });
}

function parseJsonPayloads(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) {
    return [direct];
  }

  const payloads: unknown[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const candidate = line.startsWith("data:") ? line.slice("data:".length).trim() : line;
    if (!candidate || candidate === "[DONE]") {
      continue;
    }

    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) {
      payloads.push(parsed);
    }
  }

  return payloads;
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function extractCandidatesFromJson(json: unknown, contentType?: ContentType): RawVideoCandidate[] {
  const candidates: RawVideoCandidate[] = [];
  walkJson(json, candidates, 0, contentType);
  return candidates;
}

function isCandidateResponse(response: Response): boolean {
  const request = response.request();
  const resourceType = request.resourceType();
  if (!["xhr", "fetch"].includes(resourceType)) {
    return false;
  }

  if (response.status() < 200 || response.status() >= 300) {
    return false;
  }

  const url = response.url().toLowerCase();
  if (URL_BLACKLIST.some((key) => url.includes(key))) {
    return false;
  }

  return URL_PREFIX_ALLOW.some((prefix) => url.includes(prefix));
}

function walkJson(value: unknown, output: RawVideoCandidate[], depth: number, contentType?: ContentType): void {
  if (depth > 14 || value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkJson(item, output, depth + 1, contentType);
    }
    return;
  }

  if (typeof value === "object") {
    const candidate = objectToCandidate(value, contentType);
    if (candidate) {
      output.push(candidate);
      return;
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      walkJson(child, output, depth + 1, contentType);
    }
  }
}

function objectToCandidate(value: unknown, contentType?: ContentType): RawVideoCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const awemeId = pickString(obj, ["aweme_id"]);
  if (!awemeId) {
    return null;
  }

  if (typeof obj.statistics !== "object" && typeof obj.author !== "object") {
    return null;
  }

  const desc = pickString(obj, ["desc", "item_title", "title"]);
  if (!desc) {
    return null;
  }

  const shareInfo = (obj.share_info as Record<string, unknown> | undefined) ?? {};
  const shareUrl = pickString(obj, ["share_url"]) || pickString(shareInfo, ["share_url", "url"]);
  const awemeType = pickNumber(obj, ["aweme_type"]);
  const mediaType = pickNumber(obj, ["media_type"]);
  const imageUrls = pickImagePostUrls(obj);
  const isImagePost = isImageAweme(obj, imageUrls, shareUrl);
  if (contentType === "image" && !isImagePost) {
    return null;
  }
  if (contentType === "video" && isImagePost) {
    return null;
  }

  const stats = (obj.statistics as Record<string, unknown> | undefined) ?? {};
  const author = (obj.author as Record<string, unknown> | undefined) ?? {};

  return {
    awemeId,
    awemeType,
    mediaType,
    isImagePost,
    desc,
    createTime: pickNumber(obj, ["create_time"]),
    authorName: pickString(author, ["nickname", "name"]),
    authorSecUid: pickString(author, ["sec_uid"]),
    diggCount: pickNumber(stats, ["digg_count"]),
    commentCount: pickNumber(stats, ["comment_count"]),
    shareCount: pickNumber(stats, ["share_count"]),
    collectCount: pickNumber(stats, ["collect_count"]),
    playCount: pickNumber(stats, ["play_count"]),
    shareUrl,
    coverUrl: isImagePost ? imageUrls[0] || pickCoverUrl(obj) : pickCoverUrl(obj),
    imageUrls: isImagePost ? imageUrls : [],
    raw: value,
  };
}

function pickString(object: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" || typeof value === "number") {
      const s = String(value);
      if (s) return s;
    }
  }
  return "";
}

function pickNumber(object: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function pickCoverUrl(object: Record<string, unknown>): string {
  const video = object.video as Record<string, unknown> | undefined;
  const cover = video?.cover as Record<string, unknown> | undefined;
  const urlList = cover?.url_list;
  if (Array.isArray(urlList) && typeof urlList[0] === "string") {
    return urlList[0];
  }
  const dynamicCover = video?.dynamic_cover as Record<string, unknown> | undefined;
  const dyList = dynamicCover?.url_list;
  if (Array.isArray(dyList) && typeof dyList[0] === "string") {
    return dyList[0];
  }
  return "";
}

function pickImagePostUrls(object: Record<string, unknown>): string[] {
  const imageLists = [object.images, object.image_list, object.original_images].filter(Array.isArray) as unknown[][];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const images of imageLists) {
    for (const image of images) {
      const url = pickImageUrlFromImage(image);
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    if (urls.length > 0) {
      break;
    }
  }
  return urls;
}

function pickImageUrlFromImage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const object = value as Record<string, unknown>;
  for (const key of ["url_list", "urlList", "watermark_free_download_url_list", "download_url_list"]) {
    const list = object[key];
    if (!Array.isArray(list)) {
      continue;
    }
    const url = list.find((item): item is string => typeof item === "string" && looksLikeImageUrl(item));
    if (url) {
      return url;
    }
  }
  const directUrl = pickString(object, ["url"]);
  return directUrl && looksLikeImageUrl(directUrl) ? directUrl : "";
}

function isImageAweme(object: Record<string, unknown>, imageUrls: string[], shareUrl: string): boolean {
  return (
    pickNumber(object, ["aweme_type"]) === 68 ||
    pickNumber(object, ["media_type"]) === 2 ||
    object.is_slides === true ||
    imageUrls.length > 0 ||
    shareUrl.includes("/note/")
  );
}

function looksLikeImageUrl(value: string): boolean {
  const url = value.trim();
  const lowerUrl = url.toLowerCase();
  if (!/^https?:\/\//i.test(url)) {
    return false;
  }
  if (!["douyinpic.com", "byteimg.com", "pstatp.com", "douyinstatic.com"].some((host) => lowerUrl.includes(host))) {
    return false;
  }
  if (/\.(mp4|webm|mov|m3u8|mp3|m4a|aac|wav)(?:[?#]|$)/i.test(lowerUrl)) {
    return false;
  }
  if (["avatar", "author", "user", "music", "emoji", "sticker", "icon", "logo", "watermark"].some((hint) => lowerUrl.includes(`/${hint}`))) {
    return false;
  }
  return /\.(jpe?g|png|webp)(?:[?#]|$)/i.test(lowerUrl) || lowerUrl.includes("aweme-images") || lowerUrl.includes("biz_tag=aweme_images");
}

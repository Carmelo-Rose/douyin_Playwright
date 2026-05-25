import path from "node:path";
import process from "node:process";
import type { Page, Response } from "playwright";
import { normalizeCandidates } from "./normalize.js";
import { writeDebugDump } from "../../shared/debugDump.js";
import type { RawVideoCandidate, VideoRecord } from "../../types.js";

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

export interface NetworkCaptureHandle {
  getVideos: () => VideoRecord[];
  reset: () => void;
}

export function attachNetworkCapture(page: Page): NetworkCaptureHandle {
  const videos: VideoRecord[] = [];
  const seenUrls = new Set<string>();
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

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return;
    }

    const candidates = extractCandidatesFromJson(json);
    if (DEBUG) {
      console.log(`[capture] url=${response.url()} candidates=${candidates.length}`);
      if (dumpsWritten < DEBUG_DUMP_MAX) {
        dumpsWritten += 1;
        writeDebugDump(DEBUG_DUMP_DIR, "douyin", dumpsWritten, response.url(), json)
          .then((filepath) => console.log(`[capture] dumped raw response to ${filepath}`))
          .catch((err: unknown) => console.warn(`[capture] dump failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    videos.push(...normalizeCandidates(candidates));
  });

  return {
    getVideos: () => videos,
    reset: () => {
      videos.length = 0;
      seenUrls.clear();
      if (DEBUG) {
        console.log("[capture] buffer reset");
      }
    },
  };
}

export function extractCandidatesFromJson(json: unknown): RawVideoCandidate[] {
  const candidates: RawVideoCandidate[] = [];
  walkJson(json, candidates, 0);
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

function walkJson(value: unknown, output: RawVideoCandidate[], depth: number): void {
  if (depth > 14 || value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkJson(item, output, depth + 1);
    }
    return;
  }

  if (typeof value === "object") {
    const candidate = objectToCandidate(value);
    if (candidate) {
      output.push(candidate);
      return;
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      walkJson(child, output, depth + 1);
    }
  }
}

function objectToCandidate(value: unknown): RawVideoCandidate | null {
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

  const stats = (obj.statistics as Record<string, unknown> | undefined) ?? {};
  const author = (obj.author as Record<string, unknown> | undefined) ?? {};

  return {
    awemeId,
    desc,
    createTime: pickNumber(obj, ["create_time"]),
    authorName: pickString(author, ["nickname", "name"]),
    authorSecUid: pickString(author, ["sec_uid"]),
    diggCount: pickNumber(stats, ["digg_count"]),
    commentCount: pickNumber(stats, ["comment_count"]),
    shareCount: pickNumber(stats, ["share_count"]),
    collectCount: pickNumber(stats, ["collect_count"]),
    playCount: pickNumber(stats, ["play_count"]),
    shareUrl: pickString(obj, ["share_url"]),
    coverUrl: pickCoverUrl(obj),
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

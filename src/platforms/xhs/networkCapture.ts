import path from "node:path";
import process from "node:process";
import type { Page, Response } from "playwright";
import { writeDebugDump } from "../../shared/debugDump.js";
import type { NoteRecord, RawNoteCandidate } from "../../types.js";
import { normalizeNoteCandidates } from "./normalize.js";

const URL_ALLOW = [
  "/api/sns/web/v1/search/",
  "/api/sns/web/v1/homefeed",
  "/api/sns/web/v1/feed",
  "/api/sns/web/v1/note",
];

const URL_BLACKLIST = [
  "captcha",
  "login",
  "passport",
  "collect/user",
  "comment/page",
  "notification",
  "im/",
  "track",
  "report",
  "websocket",
  ".js",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
];

const DEBUG = process.env.DEBUG_CAPTURE === "true" || process.env.DEBUG_CAPTURE === "1";
const DEBUG_DUMP_DIR = path.resolve(process.cwd(), "output");
const DEBUG_DUMP_MAX = 20;

export interface XhsNetworkCaptureHandle {
  getNotes: () => NoteRecord[];
  reset: () => void;
}

export function attachXhsNetworkCapture(page: Page): XhsNetworkCaptureHandle {
  const notes: NoteRecord[] = [];
  const seenUrls = new Set<string>();
  let dumpsWritten = 0;

  page.on("response", async (response) => {
    if (!isCandidateResponse(response)) {
      return;
    }

    // 小红书 search/notes 是 POST，翻页游标在请求 body 里、URL 每次都一样。
    // 只按 URL 去重会让除首页外的所有翻页/筛选响应被丢弃，token 也随之丢失。
    // 把 postData 纳入去重键，保证每一页结果都被解析。
    const dedupeKey = `${response.url()}\n${response.request().postData() ?? ""}`;
    if (seenUrls.has(dedupeKey)) {
      return;
    }

    seenUrls.add(dedupeKey);

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return;
    }

    const candidates = extractNoteCandidatesFromJson(json);
    if (DEBUG) {
      console.log(`[xhs:capture] url=${response.url()} candidates=${candidates.length}`);
      if (dumpsWritten < DEBUG_DUMP_MAX) {
        dumpsWritten += 1;
        writeDebugDump(DEBUG_DUMP_DIR, "xhs", dumpsWritten, response.url(), json)
          .then((filepath) => console.log(`[xhs:capture] dumped raw response to ${filepath}`))
          .catch((err: unknown) => console.warn(`[xhs:capture] dump failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    notes.push(...normalizeNoteCandidates(candidates));
  });

  return {
    getNotes: () => notes,
    reset: () => {
      notes.length = 0;
      seenUrls.clear();
      if (DEBUG) {
        console.log("[xhs:capture] buffer reset");
      }
    },
  };
}

export function extractNoteCandidatesFromJson(json: unknown): RawNoteCandidate[] {
  const candidates: RawNoteCandidate[] = [];
  walkJson(json, candidates, 0);
  return candidates;
}

function isCandidateResponse(response: Response): boolean {
  const request = response.request();
  if (!["xhr", "fetch"].includes(request.resourceType())) {
    return false;
  }

  if (response.status() < 200 || response.status() >= 300) {
    return false;
  }

  const url = response.url().toLowerCase();
  if (URL_BLACKLIST.some((key) => url.includes(key))) {
    return false;
  }

  return URL_ALLOW.some((part) => url.includes(part));
}

function walkJson(value: unknown, output: RawNoteCandidate[], depth: number): void {
  if (depth > 16 || value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkJson(item, output, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const candidate = objectToCandidate(value);
  if (candidate) {
    output.push(candidate);
    return;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    walkJson(child, output, depth + 1);
  }
}

function objectToCandidate(value: unknown): RawNoteCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const noteCard = asRecord(obj.note_card) ?? asRecord(obj.noteCard);
  const user = asRecord(obj.user) ?? asRecord(obj.user_info) ?? asRecord(noteCard?.user) ?? asRecord(noteCard?.user_info);
  const interact = asRecord(obj.interact_info) ?? asRecord(obj.interactInfo) ?? asRecord(noteCard?.interact_info) ?? asRecord(noteCard?.interactInfo);

  const noteId = pickString(obj, ["note_id", "noteId", "id"]) || pickString(noteCard, ["note_id", "noteId", "id"]);
  if (!noteId) {
    return null;
  }

  const title = pickString(obj, ["title", "display_title"]) || pickString(noteCard, ["title", "display_title"]);
  const desc = pickString(obj, ["desc", "description"]) || pickString(noteCard, ["desc", "description"]);
  const shareUrl = pickString(obj, ["share_url", "shareUrl", "url", "web_url", "webUrl"]) || pickString(noteCard, ["share_url", "shareUrl", "url", "web_url", "webUrl"]);
  const xsecToken = pickStringDeep(obj, ["xsec_token", "xsecToken"]) || pickStringDeep(noteCard, ["xsec_token", "xsecToken"]);
  const xsecSource = pickStringDeep(obj, ["xsec_source", "xsecSource"]) || pickStringDeep(noteCard, ["xsec_source", "xsecSource"]);
  if (!title && !desc && !shareUrl && !xsecToken) {
    return null;
  }

  return {
    noteId,
    noteType: inferNoteType(obj, noteCard),
    title,
    desc,
    createTime: pickNumberOrString(obj, ["time", "timestamp", "create_time", "createTime"]) || pickNumberOrString(noteCard, ["time", "timestamp", "create_time", "createTime"]),
    authorName: pickString(user, ["nickname", "name", "user_name"]),
    authorId: pickString(user, ["user_id", "userId", "id"]),
    likedCount: pickNumber(interact, ["liked_count", "likedCount", "like_count", "likeCount"]),
    commentCount: pickNumber(interact, ["comment_count", "commentCount"]),
    collectCount: pickNumber(interact, ["collected_count", "collectedCount", "collect_count", "collectCount"]),
    shareUrl,
    xsecToken,
    xsecSource,
    coverUrl: pickCoverUrl(obj) || pickCoverUrl(noteCard),
    raw: value,
  };
}

function inferNoteType(object: Record<string, unknown>, noteCard: Record<string, unknown> | undefined): string {
  const explicit =
    pickString(object, ["type", "note_type", "noteType", "card_type", "cardType"]) ||
    pickString(noteCard, ["type", "note_type", "noteType", "card_type", "cardType"]);
  const normalized = explicit.toLowerCase();
  if (normalized.includes("video")) {
    return "video";
  }
  if (normalized.includes("normal") || normalized.includes("image") || normalized.includes("photo")) {
    return "normal";
  }

  const hasVideoFields = [
    "video",
    "video_info",
    "videoInfo",
    "media",
    "media_info",
    "mediaInfo",
  ].some((key) => object[key] !== undefined || noteCard?.[key] !== undefined);

  return hasVideoFields ? "video" : explicit;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pickString(object: Record<string, unknown> | undefined, keys: string[]): string {
  if (!object) return "";
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" || typeof value === "number") {
      const s = String(value);
      if (s) return s;
    }
  }
  return "";
}

function pickStringDeep(object: Record<string, unknown> | undefined, keys: string[], depth = 0): string {
  if (!object || depth > 5) return "";

  const direct = pickString(object, keys);
  if (direct) return direct;

  for (const value of Object.values(object)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = pickStringDeep(value as Record<string, unknown>, keys, depth + 1);
      if (nested) return nested;
    }
  }

  return "";
}

function pickNumber(object: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const n = Number.parseInt(value.replace(/,/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function pickNumberOrString(object: Record<string, unknown> | undefined, keys: string[]): number | string | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function pickCoverUrl(object: Record<string, unknown> | undefined): string {
  if (!object) return "";

  const cover = asRecord(object.cover) ?? asRecord(object.image) ?? asRecord(object.image_info);
  const urlList = cover?.url_list ?? cover?.urlList;
  if (Array.isArray(urlList) && typeof urlList[0] === "string") {
    return urlList[0];
  }

  return (
    pickString(cover, ["url", "trace_id"]) ||
    pickString(object, ["cover", "cover_url", "coverUrl", "url_default"])
  );
}

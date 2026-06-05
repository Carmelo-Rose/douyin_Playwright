import type { NoteRecord, RawNoteCandidate } from "../../types.js";
import { normalizeImageUrlList } from "../../shared/imageUrls.js";

export function normalizeNoteCandidates(candidates: RawNoteCandidate[]): NoteRecord[] {
  const capturedAt = formatLocalDateTime(new Date());
  const notes = candidates
    .map((candidate) => normalizeNoteCandidate(candidate, capturedAt))
    .filter((note): note is NoteRecord => Boolean(note));
  return dedupeNotes(notes);
}

export function dedupeNotes(notes: NoteRecord[]): NoteRecord[] {
  const seen = new Map<string, NoteRecord>();
  const output: NoteRecord[] = [];

  for (const note of notes) {
    if (!note.noteId) {
      continue;
    }
    const existing = seen.get(note.noteId);
    if (existing) {
      existing.source = mergeSource(existing.source, note.source);
      mergeBetterNoteFields(existing, note);
      continue;
    }
    seen.set(note.noteId, note);
    output.push(note);
  }

  return output;
}

function normalizeNoteCandidate(candidate: RawNoteCandidate, capturedAt: string): NoteRecord | null {
  const noteId = cleanText(candidate.noteId);
  if (!noteId) {
    return null;
  }

  const shareUrl = buildXhsShareUrl(noteId, candidate);

  return {
    noteId,
    source: "",
    noteType: cleanText(candidate.noteType),
    title: cleanText(candidate.title),
    desc: cleanText(candidate.desc),
    createTime: formatCreateTimeFromNoteId(noteId) || formatCreateTime(candidate.createTime),
    authorName: cleanText(candidate.authorName),
    authorId: cleanText(candidate.authorId),
    likedCount: toInt(candidate.likedCount),
    commentCount: toInt(candidate.commentCount),
    collectCount: toInt(candidate.collectCount),
    shareUrl,
    linkStatus: describeXhsLinkStatus(shareUrl),
    coverUrl: cleanText(candidate.coverUrl),
    imageUrls: normalizeImageUrls(candidate.imageUrls, candidate.coverUrl),
    detailImageStatus: "",
    capturedAt,
    rawSnippet: toRawSnippet(candidate.raw),
  };
}

function mergeBetterNoteFields(target: NoteRecord, candidate: NoteRecord): void {
  if (scoreXhsShareUrl(candidate.shareUrl) > scoreXhsShareUrl(target.shareUrl)) {
    target.shareUrl = candidate.shareUrl;
    target.linkStatus = candidate.linkStatus;
  }

  if (!target.coverUrl && candidate.coverUrl) {
    target.coverUrl = candidate.coverUrl;
  }
  if (candidate.imageUrls.length > target.imageUrls.length) {
    target.imageUrls = candidate.imageUrls;
  }
  if (!target.detailImageStatus && candidate.detailImageStatus) {
    target.detailImageStatus = candidate.detailImageStatus;
  }
  if (!target.authorName && candidate.authorName) {
    target.authorName = candidate.authorName;
  }
  if (!target.authorId && candidate.authorId) {
    target.authorId = candidate.authorId;
  }
  if (!target.title && candidate.title) {
    target.title = candidate.title;
  }
  if (!target.desc && candidate.desc) {
    target.desc = candidate.desc;
  }
  if (!target.createTime && candidate.createTime) {
    target.createTime = candidate.createTime;
  }
}

function buildXhsShareUrl(noteId: string, candidate: RawNoteCandidate): string {
  const rawUrl = cleanText(candidate.shareUrl);
  const url = rawUrl || `https://www.xiaohongshu.com/explore/${noteId}`;
  const token = cleanText(candidate.xsecToken);
  const source = cleanText(candidate.xsecSource) || "pc_search";

  if (!token || url.includes("xsec_token=")) {
    return url;
  }

  try {
    const parsed = new URL(url, "https://www.xiaohongshu.com");
    parsed.searchParams.set("xsec_token", token);
    parsed.searchParams.set("xsec_source", source);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}xsec_token=${encodeURIComponent(token)}&xsec_source=${encodeURIComponent(source)}`;
  }
}

function describeXhsLinkStatus(url: string): string {
  if (url.includes("xsec_token=")) {
    return "优先打开链接";
  }
  return "裸链接，PC可能受限";
}

function scoreXhsShareUrl(url: string): number {
  let score = 0;
  if (url.startsWith("https://www.xiaohongshu.com/")) score += 1;
  if (url.includes("/explore/")) score += 1;
  if (url.includes("?")) score += 1;
  if (url.includes("xsec_source=")) score += 2;
  if (url.includes("xsec_token=")) score += 5;
  return score;
}

function mergeSource(left: string, right: string): string {
  const sources = new Set(
    [...left.split(","), ...right.split(",")]
      .map((source) => source.trim())
      .filter(Boolean),
  );
  return Array.from(sources).join(",");
}

function formatCreateTime(value: number | string | undefined): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    return cleanText(value);
  }

  const numeric = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }

  const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return formatLocalDateTime(new Date(milliseconds));
}

/**
 * 把小红书卡片上的展示日期文案换算成 "YYYY-MM-DD HH:MM:SS"。
 * 支持：YYYY-MM-DD / MM-DD / X秒|分钟|小时|天|周|月|年前 / 昨天|前天|今天|刚刚。
 * 解析不出返回 ""。在 Node 侧执行（不能放进 page.evaluate）。
 */
export function resolveXhsDisplayDate(text: string, now: Date = new Date()): string {
  const raw = text.trim();
  if (!raw) {
    return "";
  }

  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    return formatLocalDateTime(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  m = raw.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    let date = new Date(now.getFullYear(), month, day);
    // MM-DD 不含年份：算出来比今天还晚 → 实际是去年发的。
    if (date.getTime() > now.getTime() + 24 * 3600 * 1000) {
      date = new Date(now.getFullYear() - 1, month, day);
    }
    return formatLocalDateTime(date);
  }

  m = raw.match(/^(\d+)\s*(秒|分钟|小时|天|周|月|年)前$/);
  if (m) {
    const n = Number(m[1]);
    const unitMs: Record<string, number> = {
      "秒": 1000,
      "分钟": 60 * 1000,
      "小时": 3600 * 1000,
      "天": 24 * 3600 * 1000,
      "周": 7 * 24 * 3600 * 1000,
      "月": 30 * 24 * 3600 * 1000,
      "年": 365 * 24 * 3600 * 1000,
    };
    return formatLocalDateTime(new Date(now.getTime() - n * (unitMs[m[2]] ?? 0)));
  }

  if (/昨天/.test(raw)) return formatLocalDateTime(new Date(now.getTime() - 24 * 3600 * 1000));
  if (/前天/.test(raw)) return formatLocalDateTime(new Date(now.getTime() - 2 * 24 * 3600 * 1000));
  if (/今天|刚刚/.test(raw)) return formatLocalDateTime(now);

  return "";
}

export function resolveXhsDisplayDateStable(text: string, now: Date = new Date()): string {
  const raw = text.trim();
  if (!raw) {
    return "";
  }

  const clockMatch = raw.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s|$)/);
  const hour = clockMatch ? Number(clockMatch[1]) : 0;
  const minute = clockMatch ? Number(clockMatch[2]) : 0;
  const second = clockMatch?.[3] ? Number(clockMatch[3]) : 0;
  const withClock = (date: Date): string => {
    if (clockMatch) {
      date.setHours(hour, minute, second, 0);
    }
    return formatLocalDateTime(date);
  };

  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return formatLocalDateTime(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  match = raw.match(/^(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const month = Number(match[1]) - 1;
    const day = Number(match[2]);
    let date = new Date(now.getFullYear(), month, day);
    if (date.getTime() > now.getTime() + 24 * 3600 * 1000) {
      date = new Date(now.getFullYear() - 1, month, day);
    }
    return withClock(date);
  }

  match = raw.match(new RegExp("^(\\d+)\\s*(\\u79d2|\\u5206\\u949f|\\u5c0f\\u65f6|\\u5929|\\u5468|\\u6708|\\u5e74)\\u524d"));
  if (match) {
    const amount = Number(match[1]);
    const unitMs: Record<string, number> = {
      "\u79d2": 1000,
      "\u5206\u949f": 60 * 1000,
      "\u5c0f\u65f6": 3600 * 1000,
      "\u5929": 24 * 3600 * 1000,
      "\u5468": 7 * 24 * 3600 * 1000,
      "\u6708": 30 * 24 * 3600 * 1000,
      "\u5e74": 365 * 24 * 3600 * 1000,
    };
    return formatLocalDateTime(new Date(now.getTime() - amount * (unitMs[match[2]] ?? 0)));
  }

  if (raw.includes("\u6628\u5929")) return withClock(new Date(now.getTime() - 24 * 3600 * 1000));
  if (raw.includes("\u524d\u5929")) return withClock(new Date(now.getTime() - 2 * 24 * 3600 * 1000));
  if (raw.includes("\u4eca\u5929") || raw.includes("\u521a\u521a")) return withClock(new Date(now));

  return "";
}

export function formatCreateTimeFromNoteId(noteId: string): string {
  const match = noteId.match(/^[0-9a-fA-F]{24}$/);
  if (!match) {
    return "";
  }

  const seconds = Number.parseInt(noteId.slice(0, 8), 16);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }

  return formatLocalDateTime(new Date(seconds * 1000));
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function toInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseInt(value.replace(/,/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toRawSnippet(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 500);
  } catch {
    return "";
  }
}

function normalizeImageUrls(values: unknown, coverUrl: unknown): string[] {
  const urls = Array.isArray(values) ? values.map(cleanText).filter(Boolean) : [];
  const cover = cleanText(coverUrl);
  return normalizeImageUrlList([cover, ...urls]);
}

function formatLocalDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

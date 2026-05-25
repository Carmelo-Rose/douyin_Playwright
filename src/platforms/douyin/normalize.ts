import type { RawVideoCandidate, VideoRecord } from "../../types.js";

export function normalizeCandidates(candidates: RawVideoCandidate[]): VideoRecord[] {
  const capturedAt = formatLocalDateTime(new Date());
  const videos = candidates
    .map((c) => normalizeCandidate(c, capturedAt))
    .filter((v): v is VideoRecord => Boolean(v));
  return dedupeVideos(videos);
}

export function dedupeVideos(videos: VideoRecord[]): VideoRecord[] {
  const seen = new Map<string, VideoRecord>();
  const out: VideoRecord[] = [];
  for (const v of videos) {
    const key = v.awemeId;
    if (!key) continue;
    const existing = seen.get(key);
    if (existing) {
      existing.source = mergeSource(existing.source, v.source);
      continue;
    }
    seen.set(key, v);
    out.push(v);
  }
  return out;
}

function normalizeCandidate(c: RawVideoCandidate, capturedAt: string): VideoRecord | null {
  const awemeId = cleanText(c.awemeId);
  const desc = cleanText(c.desc);
  if (!awemeId) return null;
  const shareUrl = cleanText(c.shareUrl) || `https://www.douyin.com/video/${awemeId}`;

  return {
    awemeId,
    source: "",
    desc,
    createTime: c.createTime ? formatLocalDateTime(new Date(c.createTime * 1000)) : "",
    authorName: cleanText(c.authorName),
    authorSecUid: cleanText(c.authorSecUid),
    diggCount: toInt(c.diggCount),
    commentCount: toInt(c.commentCount),
    shareCount: toInt(c.shareCount),
    collectCount: toInt(c.collectCount),
    playCount: toInt(c.playCount),
    shareUrl,
    coverUrl: cleanText(c.coverUrl),
    capturedAt,
    rawSnippet: toRawSnippet(c.raw),
  };
}

function mergeSource(left: string, right: string): string {
  const sources = new Set(
    [...left.split(","), ...right.split(",")]
      .map((source) => source.trim())
      .filter(Boolean),
  );
  return Array.from(sources).join(",");
}

export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function toInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
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

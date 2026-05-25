import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import type { Page, Response } from "playwright";
import { openBrowserSession } from "./browser.js";
import { loadConfig } from "./config.js";
import { waitForDouyinLogin } from "./platforms/douyin/login.js";

const DEFAULT_WAIT_MS = 15_000;
const RESPONSE_READ_TIMEOUT_MS = 5_000;
const MAX_WALK_DEPTH = 18;
const MAX_HYDRATION_TEXT_LENGTH = 500_000;

const INTERESTING_URL_PARTS = [
  "/aweme/v1/web/",
  "/aweme/v2/web/",
  "/aweme/v1/play/",
  "/aweme/v1/aweme/",
  "/web/api/v2/aweme/",
];

const AWEME_ID_KEYS = [
  "aweme_id",
  "awemeId",
  "item_id",
  "itemId",
  "group_id",
  "groupId",
];

const PLAY_COUNT_KEYS = [
  "play_count",
  "playCount",
  "play_cnt",
  "playCnt",
  "video_play_count",
  "videoPlayCount",
  "view_count",
  "viewCount",
  "vv_count",
  "vvCount",
  "read_count",
  "readCount",
];

type PlayCountSource = "network" | "hydration" | "hydration_regex" | "visible_text";

export interface PlayCountProbeInput {
  awemeId?: string;
  videoUrl?: string;
  waitMs?: number;
}

export interface PlayCountCandidate {
  source: PlayCountSource;
  count: number;
  field?: string;
  jsonPath?: string;
  responseUrl?: string;
  label?: string;
  rawSnippet?: string;
}

export interface PlayCountProbeResult {
  awemeId: string;
  videoUrl: string;
  best: PlayCountCandidate | null;
  candidates: PlayCountCandidate[];
  capturedAt: string;
}

interface ResolvedTarget {
  awemeId: string;
  videoUrl: string;
}

export async function probeVideoPlayCount(page: Page, input: PlayCountProbeInput): Promise<PlayCountProbeResult> {
  const target = await resolveTarget(page, input);
  const networkCandidates = await collectNetworkCandidates(page, target, input.waitMs ?? DEFAULT_WAIT_MS);
  const hydrationCandidates = await extractHydrationCandidates(page, target.awemeId);
  const visibleTextCandidates = await extractVisibleTextCandidates(page);
  const candidates = dedupeCandidates([
    ...networkCandidates,
    ...hydrationCandidates,
    ...visibleTextCandidates,
  ]);

  return {
    ...target,
    best: chooseBestCandidate(candidates),
    candidates,
    capturedAt: new Date().toISOString(),
  };
}

async function collectNetworkCandidates(page: Page, target: ResolvedTarget, waitMs: number): Promise<PlayCountCandidate[]> {
  const candidates: PlayCountCandidate[] = [];
  const responseTasks: Promise<void>[] = [];
  const seenUrls = new Set<string>();

  const handler = (response: Response): void => {
    if (!shouldReadResponse(response) || seenUrls.has(response.url())) {
      return;
    }
    seenUrls.add(response.url());
    responseTasks.push(
      readResponseCandidates(response, target.awemeId)
        .then((items) => {
          candidates.push(...items);
        })
        .catch(() => {
          // Ignore non-JSON or blocked responses; the probe reports what it can see.
        }),
    );
  };

  page.on("response", handler);
  try {
    await page.goto(target.videoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    await page.mouse.wheel(0, 900).catch(() => undefined);
    await page.waitForTimeout(waitMs);
  } finally {
    page.off("response", handler);
  }

  await Promise.allSettled(responseTasks);
  return candidates;
}

async function readResponseCandidates(response: Response, awemeId: string): Promise<PlayCountCandidate[]> {
  const json = await withTimeout(response.json(), RESPONSE_READ_TIMEOUT_MS);
  return extractPlayCountCandidatesFromJson(json, awemeId, "network", response.url());
}

export function extractPlayCountCandidatesFromJson(
  json: unknown,
  awemeId: string,
  source: PlayCountSource = "network",
  responseUrl?: string,
): PlayCountCandidate[] {
  const candidates: PlayCountCandidate[] = [];

  walkJsonForPlayCount(json, {
    awemeId,
    candidates,
    responseUrl,
    source,
    seen: new Set<string>(),
  });

  return candidates;
}

function walkJsonForPlayCount(
  value: unknown,
  context: {
    awemeId: string;
    candidates: PlayCountCandidate[];
    responseUrl?: string;
    source: PlayCountSource;
    seen: Set<string>;
    path?: string;
    activeAwemeId?: string;
    depth?: number;
  },
): void {
  const depth = context.depth ?? 0;
  if (depth > MAX_WALK_DEPTH || value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkJsonForPlayCount(item, {
        ...context,
        path: appendJsonPath(context.path, String(index)),
        depth: depth + 1,
      });
    });
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const object = value as Record<string, unknown>;
  const ownAwemeId = pickString(object, AWEME_ID_KEYS);
  const activeAwemeId = ownAwemeId || context.activeAwemeId;
  const currentPath = context.path ?? "$";

  if (activeAwemeId === context.awemeId) {
    addCountFields(object, currentPath, context);

    const statistics = asRecord(object.statistics);
    if (statistics) {
      addCountFields(statistics, appendJsonPath(currentPath, "statistics"), context);
    }
  }

  for (const [key, child] of Object.entries(object)) {
    walkJsonForPlayCount(child, {
      ...context,
      path: appendJsonPath(currentPath, key),
      activeAwemeId,
      depth: depth + 1,
    });
  }
}

function addCountFields(
  object: Record<string, unknown>,
  jsonPath: string,
  context: {
    candidates: PlayCountCandidate[];
    responseUrl?: string;
    source: PlayCountSource;
    seen: Set<string>;
  },
): void {
  for (const field of PLAY_COUNT_KEYS) {
    const count = toCount(object[field]);
    if (count === null) {
      continue;
    }

    const key = `${context.source}|${context.responseUrl ?? ""}|${jsonPath}|${field}|${count}`;
    if (context.seen.has(key)) {
      continue;
    }
    context.seen.add(key);

    context.candidates.push({
      source: context.source,
      count,
      field,
      jsonPath,
      responseUrl: context.responseUrl,
      rawSnippet: toRawSnippet(object),
    });
  }
}

async function extractHydrationCandidates(page: Page, awemeId: string): Promise<PlayCountCandidate[]> {
  const texts = await page.evaluate(`(() => {
      const id = ${JSON.stringify(awemeId)};
      const maxLength = ${MAX_HYDRATION_TEXT_LENGTH};
      const values = new Set();
      const add = (value) => {
        if (!value) return;
        if (!value.includes(id) && !value.includes("play_count") && !value.includes("playCount")) return;
        values.add(value.slice(0, maxLength));
      };

      for (const elementId of ["RENDER_DATA", "SSR_RENDER_DATA", "__NEXT_DATA__"]) {
        add(document.getElementById(elementId)?.textContent);
      }

      for (const script of Array.from(document.scripts)) {
        add(script.textContent);
        if (values.size >= 8) break;
      }

      return Array.from(values);
    })()`) as string[];

  const candidates: PlayCountCandidate[] = [];
  for (const text of texts) {
    const decoded = maybeDecodeURIComponent(text);
    const parsed = tryParseJsonish(decoded);
    if (parsed !== null) {
      candidates.push(...extractPlayCountCandidatesFromJson(parsed, awemeId, "hydration"));
      continue;
    }
    candidates.push(...extractPlayCountsByRegex(decoded, awemeId));
  }

  return candidates;
}

function extractPlayCountsByRegex(text: string, awemeId: string): PlayCountCandidate[] {
  const id = escapeRegExp(awemeId);
  const fields = PLAY_COUNT_KEYS.map(escapeRegExp).join("|");
  const patterns = [
    new RegExp(`"(?:${AWEME_ID_KEYS.map(escapeRegExp).join("|")})"\\s*:\\s*"?${id}"?[\\s\\S]{0,8000}?"(${fields})"\\s*:\\s*"?([0-9]+)"?`, "g"),
    new RegExp(`"(${fields})"\\s*:\\s*"?([0-9]+)"?[\\s\\S]{0,8000}?"(?:${AWEME_ID_KEYS.map(escapeRegExp).join("|")})"\\s*:\\s*"?${id}"?`, "g"),
  ];

  const candidates: PlayCountCandidate[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const field = match[1];
      const count = toCount(match[2]);
      if (count === null) continue;
      const key = `${field}|${count}|${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        source: "hydration_regex",
        count,
        field,
        label: "page script regex",
        rawSnippet: text.slice(Math.max(0, match.index - 160), match.index + 360),
      });
    }
  }
  return candidates;
}

async function extractVisibleTextCandidates(page: Page): Promise<PlayCountCandidate[]> {
  const texts = await page.evaluate(`(() => {
    const values = new Set();
    const add = (value) => {
      const clean = value?.replace(/\\s+/g, " ").trim();
      if (!clean) return;
      if (clean.includes("播放") || clean.includes("观看") || clean.includes("浏览")) {
        values.add(clean.slice(0, 240));
      }
    };

    for (const line of (document.body?.innerText ?? "").split(/\\n+/)) {
      add(line);
    }

    for (const el of Array.from(document.querySelectorAll("[aria-label],[title]"))) {
      add(el.getAttribute("aria-label"));
      add(el.getAttribute("title"));
    }

    return Array.from(values).slice(0, 200);
  })()`) as string[];

  const candidates: PlayCountCandidate[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const count = parseVisiblePlayCount(text);
    if (count === null) {
      continue;
    }
    const key = `${count}|${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({
      source: "visible_text",
      count,
      label: text,
    });
  }
  return candidates;
}

async function resolveTarget(page: Page, input: PlayCountProbeInput): Promise<ResolvedTarget> {
  const directAwemeId = cleanText(input.awemeId);
  if (directAwemeId) {
    return {
      awemeId: directAwemeId,
      videoUrl: normalizeVideoUrl(input.videoUrl, directAwemeId),
    };
  }

  const rawUrl = cleanText(input.videoUrl);
  if (!rawUrl) {
    throw new Error("Please provide --aweme-id <id> or --url <douyin video url>.");
  }

  const parsedFromUrl = extractAwemeId(rawUrl);
  if (parsedFromUrl) {
    return {
      awemeId: parsedFromUrl,
      videoUrl: normalizeVideoUrl(rawUrl, parsedFromUrl),
    };
  }

  await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
  const resolvedUrl = page.url();
  const resolvedAwemeId = extractAwemeId(resolvedUrl);
  if (!resolvedAwemeId) {
    throw new Error(`Could not resolve aweme_id from URL: ${rawUrl} -> ${resolvedUrl}`);
  }

  return {
    awemeId: resolvedAwemeId,
    videoUrl: normalizeVideoUrl(resolvedUrl, resolvedAwemeId),
  };
}

function shouldReadResponse(response: Response): boolean {
  if (response.status() < 200 || response.status() >= 300) {
    return false;
  }

  const type = response.request().resourceType();
  if (!["xhr", "fetch"].includes(type)) {
    return false;
  }

  const url = response.url().toLowerCase();
  return INTERESTING_URL_PARTS.some((part) => url.includes(part));
}

function chooseBestCandidate(candidates: PlayCountCandidate[]): PlayCountCandidate | null {
  const sourcePriority: Record<PlayCountSource, number> = {
    network: 0,
    hydration: 1,
    hydration_regex: 2,
    visible_text: 3,
  };

  return [...candidates]
    .filter((candidate) => candidate.count > 0)
    .sort((a, b) => sourcePriority[a.source] - sourcePriority[b.source] || b.count - a.count)[0] ?? null;
}

function dedupeCandidates(candidates: PlayCountCandidate[]): PlayCountCandidate[] {
  const seen = new Set<string>();
  const output: PlayCountCandidate[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.source,
      candidate.count,
      candidate.field ?? "",
      candidate.jsonPath ?? "",
      candidate.responseUrl ?? "",
      candidate.label ?? "",
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

function normalizeVideoUrl(rawUrl: string | undefined, awemeId: string): string {
  const cleaned = cleanText(rawUrl);
  if (cleaned && /[?&]modal_id=/.test(cleaned) && extractAwemeId(cleaned) === awemeId) {
    return cleaned;
  }
  return `https://www.douyin.com/jingxuan?modal_id=${awemeId}`;
}

function extractAwemeId(value: string): string {
  const patterns = [
    /\/(?:video|note)\/(\d{10,})/,
    /[?&](?:modal_id|aweme_id|item_id)=(\d{10,})/,
    /\b(\d{18,22})\b/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function parseVisiblePlayCount(text: string): number | null {
  const patterns = [
    /(?:播放(?:量|数)?|观看|浏览)[^\d]{0,10}([\d,.]+)\s*(亿|万|w|W|k|K)?/,
    /([\d,.]+)\s*(亿|万|w|W|k|K)?\s*(?:次)?(?:播放|观看|浏览)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }
    return parseCountParts(match[1], match[2]);
  }
  return null;
}

function parseCountParts(numberText: string, unitText: string | undefined): number | null {
  const base = Number.parseFloat(numberText.replace(/,/g, ""));
  if (!Number.isFinite(base)) {
    return null;
  }

  const unit = unitText?.toLowerCase();
  const multiplier = unit === "亿" ? 100_000_000 : unit === "万" || unit === "w" ? 10_000 : unit === "k" ? 1_000 : 1;
  return Math.round(base * multiplier);
}

function tryParseJsonish(text: string): unknown | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^window\.[A-Za-z0-9_$]+\s*=\s*/, "").replace(/;$/, ""),
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next shape
    }
  }
  return null;
}

function maybeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pickString(object: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function toCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }

  if (typeof value === "string") {
    const number = Number.parseInt(value.replace(/,/g, ""), 10);
    if (Number.isFinite(number) && number >= 0) {
      return number;
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function appendJsonPath(parent: string | undefined, key: string): string {
  const safeKey = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  return parent ? `${parent}${safeKey}` : `$${safeKey}`;
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toRawSnippet(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 600);
  } catch {
    return "";
  }
}

function shortenUrl(url: string | undefined): string {
  if (!url) return "";
  return url.length > 150 ? `${url.slice(0, 150)}...` : url;
}

function readCliValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
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

async function writeProbeResult(result: PlayCountProbeResult, outputDir: string): Promise<string> {
  await fs.ensureDir(outputDir);
  const outputPath = path.join(outputDir, `play-count-probe-${result.awemeId}-${formatTimestamp(new Date())}.json`);
  await fs.writeJson(outputPath, result, { spaces: 2 });
  return outputPath;
}

function printProbeResult(result: PlayCountProbeResult, outputPath: string): void {
  console.log(`aweme_id: ${result.awemeId}`);
  console.log(`video_url: ${result.videoUrl}`);
  if (result.best) {
    console.log(`best_play_count: ${result.best.count} (${result.best.source}${result.best.field ? `/${result.best.field}` : ""})`);
  } else {
    console.log("best_play_count: not found");
  }
  console.log(`candidates: ${result.candidates.length}`);

  for (const candidate of result.candidates.slice(0, 12)) {
    const parts = [
      `- ${candidate.count}`,
      candidate.source,
      candidate.field ? `field=${candidate.field}` : "",
      candidate.jsonPath ? `path=${candidate.jsonPath}` : "",
      candidate.label ? `label=${candidate.label}` : "",
      candidate.responseUrl ? `url=${shortenUrl(candidate.responseUrl)}` : "",
    ].filter(Boolean);
    console.log(parts.join(" | "));
  }

  if (result.candidates.length > 12) {
    console.log(`... ${result.candidates.length - 12} more candidates in JSON output`);
  }
  console.log(`result_json: ${outputPath}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const awemeId = readCliValue("--aweme-id") || process.env.PLAY_COUNT_AWEME_ID;
  const videoUrl = readCliValue("--url") || process.env.PLAY_COUNT_URL;
  const waitMs = readPositiveInt(readCliValue("--wait-ms") || process.env.PLAY_COUNT_WAIT_MS, DEFAULT_WAIT_MS);

  console.log("[play-count] opening browser session...");
  const { context, page } = await openBrowserSession(config);
  try {
    console.log("[play-count] checking Douyin login...");
    await waitForDouyinLogin(page, { humanLike: config.humanLike });
    console.log(`[play-count] probing detail page, waitMs=${waitMs}...`);
    const result = await probeVideoPlayCount(page, { awemeId, videoUrl, waitMs });
    const outputPath = await writeProbeResult(result, config.outputDir);
    printProbeResult(result, outputPath);
  } finally {
    console.log("[play-count] closing browser session...");
    await context.close();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

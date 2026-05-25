/**
 * Deep probe for Douyin play_count discovery.
 *
 * 与 src/playCountProbe.ts 的区别：
 *   1. 抓所有 XHR/fetch 响应（不再按 URL 前缀白名单过滤）。
 *   2. 不再只匹配 play_count 字段名 —— 找到包含目标 aweme_id 的对象后，
 *      把对象里所有 > 0 的数值字段全列出来，方便发现隐藏 proxy 字段
 *      （heat / pv / vv / score / popularity / impression / pop_score ...）。
 *   3. 多个未测过的页面入口：抖音首页 feed / 热榜 / discover / 作者页 modal
 *      / 综合搜索按"最多点赞"排序后滚动。
 *   4. 每个命中响应整体 dump 到 output/play-count-deep-<id>-<ts>/raw/，
 *      summary.json 汇总所有页面下的字段分布。
 *
 * 用法：
 *   npm run probe:deep -- --aweme-id 7639981756393854137
 *   npm run probe:deep -- --aweme-id 7639981756393854137 --sec-uid MS4wLjABAAAA... --keyword 帽子
 *
 * 跑完把 output/play-count-deep-* 整个目录交给 Claude 分析 unique numeric fields。
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import type { Page, Response } from "playwright";
import { openBrowserSession } from "./browser.js";
import { loadConfig } from "./config.js";
import { waitForDouyinLogin } from "./platforms/douyin/login.js";

const RESPONSE_READ_TIMEOUT_MS = 5_000;
const PER_PAGE_SETTLE_MS = 4_000;
const MAX_WALK_DEPTH = 22;

const AWEME_ID_KEYS = ["aweme_id", "awemeId", "item_id", "itemId", "group_id", "groupId"];

const KNOWN_BORING_KEYS = new Set([
  // 已知字段不算"新发现"，但也保留收集（方便对照）。这里只列出会被显著降权的键。
  "digg_count", "diggCount",
  "comment_count", "commentCount",
  "share_count", "shareCount",
  "collect_count", "collectCount",
  "download_count", "downloadCount",
  "forward_count", "forwardCount",
  "follower_count", "followerCount",
  "following_count", "followingCount",
  "favoriting_count", "favoritingCount",
  "total_favorited", "totalFavorited",
  "aweme_count", "awemeCount",
  "admire_count", "admireCount",
  "live_count", "liveCount",
]);

interface NumericFieldHit {
  field: string;
  value: number;
  jsonPath: string;
  responseUrl: string;
}

interface PageProbeResult {
  pageTag: string;
  url: string;
  finalUrl: string;
  capturedResponses: number;
  hitResponses: number;
  rawDumps: string[];
  numericFields: NumericFieldHit[];
  errors: string[];
}

interface FieldSummary {
  field: string;
  isKnown: boolean;
  distinctValues: number[];
  occurrences: number;
  pages: string[];
  sampleResponseUrl: string;
  samplePath: string;
}

interface DeepProbeResult {
  awemeId: string;
  secUid?: string;
  keyword?: string;
  capturedAt: string;
  outputDir: string;
  pages: PageProbeResult[];
  uniqueNumericFields: FieldSummary[];
  newCandidateFields: FieldSummary[];
}

async function main(): Promise<void> {
  const config = loadConfig();
  const awemeId = readCliValue("--aweme-id") || process.env.DEEP_PROBE_AWEME_ID;
  if (!awemeId) {
    throw new Error("Please pass --aweme-id <id>");
  }
  const secUid = readCliValue("--sec-uid") || process.env.DEEP_PROBE_SEC_UID;
  const keyword = readCliValue("--keyword") || process.env.DEEP_PROBE_KEYWORD;

  const ts = formatTimestamp(new Date());
  const outputDir = path.join(config.outputDir, `play-count-deep-${awemeId}-${ts}`);
  await fs.ensureDir(path.join(outputDir, "raw"));

  console.log(`[deep-probe] aweme_id=${awemeId}`);
  console.log(`[deep-probe] output dir: ${outputDir}`);

  console.log("[deep-probe] opening browser session...");
  const { context, page } = await openBrowserSession(config);
  try {
    await waitForDouyinLogin(page, { humanLike: config.humanLike });

    const result: DeepProbeResult = {
      awemeId,
      secUid,
      keyword,
      capturedAt: new Date().toISOString(),
      outputDir,
      pages: [],
      uniqueNumericFields: [],
      newCandidateFields: [],
    };

    const pageDefs = buildPageDefs(awemeId, { secUid, keyword });
    for (const def of pageDefs) {
      console.log(`[deep-probe] -> page: ${def.tag}`);
      const pageResult = await probePage(page, def, awemeId, outputDir);
      console.log(
        `[deep-probe]    captured=${pageResult.capturedResponses}, hit=${pageResult.hitResponses}, dumps=${pageResult.rawDumps.length}, errors=${pageResult.errors.length}`,
      );
      result.pages.push(pageResult);
    }

    aggregate(result);

    const summaryPath = path.join(outputDir, "summary.json");
    await fs.writeJson(summaryPath, result, { spaces: 2 });

    printDeepResult(result);
    console.log(`\nsummary: ${summaryPath}`);
  } finally {
    console.log("[deep-probe] closing browser session...");
    await context.close();
  }
}

interface PageDef {
  tag: string;
  description: string;
  setup: (page: Page) => Promise<string>;
  interact?: (page: Page) => Promise<void>;
}

function buildPageDefs(awemeId: string, opts: { secUid?: string; keyword?: string }): PageDef[] {
  const defs: PageDef[] = [
    {
      tag: "jingxuan_modal",
      description: "https://www.douyin.com/jingxuan?modal_id=<id> — 基准对照入口",
      setup: async (p) => {
        const url = `https://www.douyin.com/jingxuan?modal_id=${awemeId}`;
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        return url;
      },
    },
    {
      tag: "homepage_feed",
      description: "https://www.douyin.com/ — 推荐 feed",
      setup: async (p) => {
        await p.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
        return p.url();
      },
      interact: async (p) => {
        for (let i = 0; i < 3; i += 1) {
          await p.mouse.wheel(0, 1400).catch(() => undefined);
          await p.waitForTimeout(1_500);
        }
      },
    },
    {
      tag: "hot_rank",
      description: "https://www.douyin.com/hot — 热榜入口",
      setup: async (p) => {
        await p.goto("https://www.douyin.com/hot", { waitUntil: "domcontentloaded", timeout: 60_000 });
        return p.url();
      },
      interact: async (p) => {
        await p.mouse.wheel(0, 1400).catch(() => undefined);
        await p.waitForTimeout(2_000);
        await p.mouse.wheel(0, 1400).catch(() => undefined);
        await p.waitForTimeout(2_000);
      },
    },
    {
      tag: "discover",
      description: "https://www.douyin.com/discover — 发现页",
      setup: async (p) => {
        await p.goto("https://www.douyin.com/discover", { waitUntil: "domcontentloaded", timeout: 60_000 });
        return p.url();
      },
      interact: async (p) => {
        await p.mouse.wheel(0, 1400).catch(() => undefined);
        await p.waitForTimeout(2_000);
      },
    },
    {
      tag: "channel_video",
      description: "https://www.douyin.com/channel/300203 — 视频频道（看是否暴露 play_count）",
      setup: async (p) => {
        await p.goto("https://www.douyin.com/channel/300203", { waitUntil: "domcontentloaded", timeout: 60_000 });
        return p.url();
      },
      interact: async (p) => {
        for (let i = 0; i < 2; i += 1) {
          await p.mouse.wheel(0, 1400).catch(() => undefined);
          await p.waitForTimeout(1_500);
        }
      },
    },
    {
      tag: "video_full_page",
      description: "https://www.douyin.com/video/<id> — 直接全页详情（非 modal）",
      setup: async (p) => {
        const url = `https://www.douyin.com/video/${awemeId}`;
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        return url;
      },
      interact: async (p) => {
        await p.waitForTimeout(2_000);
        await p.mouse.wheel(0, 800).catch(() => undefined);
        await p.waitForTimeout(2_000);
      },
    },
    {
      tag: "share_v3",
      description: "https://www.iesdouyin.com/share/video/<id>/ — 分享页 v3（有 SSR & RPC）",
      setup: async (p) => {
        const url = `https://www.iesdouyin.com/share/video/${awemeId}/`;
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        return url;
      },
      interact: async (p) => {
        await p.waitForTimeout(3_000);
        await p.mouse.wheel(0, 800).catch(() => undefined);
        await p.waitForTimeout(2_000);
      },
    },
  ];

  if (opts.secUid) {
    defs.push({
      tag: "author_modal",
      description: `https://www.douyin.com/user/<sec_uid>?modal_id=<id>`,
      setup: async (p) => {
        const url = `https://www.douyin.com/user/${opts.secUid}?modal_id=${awemeId}`;
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        return url;
      },
      interact: async (p) => {
        await p.waitForTimeout(2_500);
        await p.mouse.wheel(0, 1200).catch(() => undefined);
        await p.waitForTimeout(2_500);
      },
    });
  }

  if (opts.keyword) {
    defs.push({
      tag: "search_sort_like",
      description: `综合搜索 "${opts.keyword}" + 切换"最多点赞"排序`,
      setup: async (p) => {
        const url = `https://www.douyin.com/root/search/${encodeURIComponent(opts.keyword!)}?type=general`;
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        return url;
      },
      interact: async (p) => {
        await p.waitForTimeout(3_000);
        // try to toggle sort to "最多点赞" / "最热"
        for (const text of ["最多点赞", "最热", "最热门", "热度", "综合排序"]) {
          try {
            const locator = p.getByText(text, { exact: true }).first();
            if (await locator.isVisible({ timeout: 1_000 })) {
              await locator.click({ timeout: 1_500 });
              console.log(`[deep-probe]    clicked sort: ${text}`);
              await p.waitForTimeout(2_000);
              break;
            }
          } catch {
            // try next
          }
        }
        for (let i = 0; i < 3; i += 1) {
          await p.mouse.wheel(0, 1400).catch(() => undefined);
          await p.waitForTimeout(1_500);
        }
      },
    });
  }

  return defs;
}

async function probePage(
  page: Page,
  def: PageDef,
  awemeId: string,
  outputDir: string,
): Promise<PageProbeResult> {
  const result: PageProbeResult = {
    pageTag: def.tag,
    url: "",
    finalUrl: "",
    capturedResponses: 0,
    hitResponses: 0,
    rawDumps: [],
    numericFields: [],
    errors: [],
  };

  const responseTasks: Promise<void>[] = [];
  const seenUrls = new Set<string>();
  let dumpIndex = 0;

  const handler = (response: Response): void => {
    const type = response.request().resourceType();
    if (!["xhr", "fetch", "document"].includes(type)) {
      return;
    }
    if (response.status() < 200 || response.status() >= 300) {
      return;
    }
    const url = response.url();
    if (seenUrls.has(url)) {
      return;
    }
    seenUrls.add(url);
    result.capturedResponses += 1;

    responseTasks.push(
      handleResponse(response, awemeId, def.tag, outputDir, () => {
        dumpIndex += 1;
        return dumpIndex;
      })
        .then((report) => {
          if (!report) return;
          result.hitResponses += 1;
          result.rawDumps.push(report.dumpFilename);
          result.numericFields.push(...report.hits);
        })
        .catch((err: unknown) => {
          result.errors.push(`response handling: ${err instanceof Error ? err.message : String(err)}`);
        }),
    );
  };

  page.on("response", handler);
  try {
    result.url = await def.setup(page);
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    if (def.interact) {
      await def.interact(page);
    } else {
      await page.waitForTimeout(PER_PAGE_SETTLE_MS);
    }
    await page.waitForTimeout(PER_PAGE_SETTLE_MS);
    result.finalUrl = page.url();
  } catch (err) {
    result.errors.push(`setup: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    page.off("response", handler);
  }

  await Promise.allSettled(responseTasks);
  return result;
}

interface HandleResult {
  dumpFilename: string;
  hits: NumericFieldHit[];
}

async function handleResponse(
  response: Response,
  awemeId: string,
  pageTag: string,
  outputDir: string,
  nextDumpIndex: () => number,
): Promise<HandleResult | null> {
  let bodyText: string;
  try {
    bodyText = await withTimeout(response.text(), RESPONSE_READ_TIMEOUT_MS);
  } catch {
    return null;
  }
  if (!bodyText || !bodyText.includes(awemeId)) {
    return null;
  }

  // Document responses can be huge HTML. Skip if too large but contains aweme_id —
  // still log a small JSON entry capturing the meta only.
  const isDocument = response.request().resourceType() === "document";
  if (isDocument && bodyText.length > 1_500_000) {
    return null;
  }

  // Try to parse as JSON. If it fails, try scraping inline JSON blobs (script tags).
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    if (isDocument) {
      parsed = extractInlineJsonObjects(bodyText, awemeId);
    }
  }

  if (parsed === null || parsed === undefined) {
    return null;
  }

  const dumpIdx = nextDumpIndex();
  const dumpFilename = `${pageTag}-${String(dumpIdx).padStart(3, "0")}.json`;
  const dumpPath = path.join(outputDir, "raw", dumpFilename);
  try {
    await fs.writeJson(
      dumpPath,
      { url: response.url(), status: response.status(), resourceType: response.request().resourceType(), body: parsed },
      { spaces: 2 },
    );
  } catch {
    // ignore disk write errors for individual dumps
  }

  const hits = collectNumericFieldHits(parsed, awemeId, response.url());
  return { dumpFilename, hits };
}

function extractInlineJsonObjects(html: string, awemeId: string): unknown {
  const collected: unknown[] = [];
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const text = match[1];
    if (!text.includes(awemeId)) continue;
    const trimmed = text.trim();
    const tryCandidates = [
      trimmed,
      trimmed.replace(/^window\.[\w.$]+\s*=\s*/, "").replace(/;$/, ""),
      trimmed.replace(/^self\.[\w.$]+\s*=\s*/, "").replace(/;$/, ""),
    ];
    for (const candidate of tryCandidates) {
      try {
        collected.push(JSON.parse(candidate));
        break;
      } catch {
        // try next
      }
    }
    if (collected.length >= 6) break;
  }
  return collected.length > 0 ? collected : null;
}

function collectNumericFieldHits(value: unknown, awemeId: string, responseUrl: string): NumericFieldHit[] {
  const hits: NumericFieldHit[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown, currentPath: string, activeAwemeId: string | undefined, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || node === null || node === undefined) return;

    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, `${currentPath}[${idx}]`, activeAwemeId, depth + 1));
      return;
    }
    if (typeof node !== "object") return;

    const obj = node as Record<string, unknown>;
    const ownAwemeId = pickStringField(obj, AWEME_ID_KEYS);
    const activeId = ownAwemeId || activeAwemeId;

    if (activeId === awemeId) {
      collectNumericsForObject(obj, currentPath, responseUrl, hits, seen);
    }

    for (const [key, child] of Object.entries(obj)) {
      walk(child, `${currentPath}.${key}`, activeId, depth + 1);
    }
  };

  walk(value, "$", undefined, 0);
  return hits;
}

function collectNumericsForObject(
  obj: Record<string, unknown>,
  currentPath: string,
  responseUrl: string,
  hits: NumericFieldHit[],
  seen: Set<string>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (isLikelyIdOrTimestamp(key)) continue;
    const num = toCount(value);
    if (num === null || num === 0) continue;
    if (num > 1e13) continue; // probably a timestamp / id-like
    const sig = `${responseUrl}|${currentPath}|${key}|${num}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    hits.push({
      field: key,
      value: num,
      jsonPath: `${currentPath}.${key}`,
      responseUrl,
    });
  }

  // Recurse one level into "statistics" / "stats" / "video_data" / "metrics" objects
  // even if they don't carry aweme_id directly.
  for (const nestKey of ["statistics", "stats", "videoStats", "videoStatistics", "video_data", "metrics", "data", "info"]) {
    const inner = obj[nestKey];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      collectNumericsForObject(
        inner as Record<string, unknown>,
        `${currentPath}.${nestKey}`,
        responseUrl,
        hits,
        seen,
      );
    }
  }
}

function aggregate(result: DeepProbeResult): void {
  const fieldMap = new Map<
    string,
    { values: Set<number>; occurrences: number; pages: Set<string>; sampleUrl: string; samplePath: string }
  >();

  for (const pageResult of result.pages) {
    for (const hit of pageResult.numericFields) {
      let entry = fieldMap.get(hit.field);
      if (!entry) {
        entry = {
          values: new Set(),
          occurrences: 0,
          pages: new Set(),
          sampleUrl: hit.responseUrl,
          samplePath: hit.jsonPath,
        };
        fieldMap.set(hit.field, entry);
      }
      entry.values.add(hit.value);
      entry.occurrences += 1;
      entry.pages.add(pageResult.pageTag);
    }
  }

  const summaries: FieldSummary[] = Array.from(fieldMap.entries())
    .map(([field, info]) => ({
      field,
      isKnown: KNOWN_BORING_KEYS.has(field),
      distinctValues: Array.from(info.values).sort((a, b) => b - a),
      occurrences: info.occurrences,
      pages: Array.from(info.pages).sort(),
      sampleResponseUrl: info.sampleUrl,
      samplePath: info.samplePath,
    }))
    .sort((a, b) => b.occurrences - a.occurrences);

  result.uniqueNumericFields = summaries;
  result.newCandidateFields = summaries.filter((s) => !s.isKnown);
}

function printDeepResult(result: DeepProbeResult): void {
  console.log(`\n=== Deep Probe: ${result.awemeId} ===`);
  for (const page of result.pages) {
    console.log(`\n[${page.pageTag}]`);
    console.log(`  setup_url: ${page.url}`);
    console.log(`  final_url: ${page.finalUrl}`);
    console.log(`  captured XHR/fetch/document: ${page.capturedResponses}`);
    console.log(`  hit aweme_id responses: ${page.hitResponses}`);
    console.log(`  raw dumps: ${page.rawDumps.length}`);
    if (page.errors.length > 0) {
      console.log(`  errors: ${page.errors.slice(0, 3).join(" | ")}`);
    }

    if (page.numericFields.length > 0) {
      const groups = new Map<string, { values: Set<number>; count: number }>();
      for (const h of page.numericFields) {
        let g = groups.get(h.field);
        if (!g) {
          g = { values: new Set(), count: 0 };
          groups.set(h.field, g);
        }
        g.values.add(h.value);
        g.count += 1;
      }
      const sorted = Array.from(groups.entries()).sort((a, b) => b[1].count - a[1].count);
      for (const [field, info] of sorted.slice(0, 20)) {
        const vals = Array.from(info.values).sort((a, b) => b - a).slice(0, 6);
        const known = KNOWN_BORING_KEYS.has(field) ? " (known)" : "";
        console.log(`    ${field}=[${vals.join(", ")}] x${info.count}${known}`);
      }
    }
  }

  const candidates = result.newCandidateFields;
  console.log(`\n=== NEW candidate fields (not in known counter list) — top 40 ===`);
  if (candidates.length === 0) {
    console.log("  (none — all observed numeric fields are already-known counters)");
  } else {
    for (const f of candidates.slice(0, 40)) {
      const vals = f.distinctValues.slice(0, 6);
      console.log(`  ${f.field}: values=[${vals.join(", ")}], pages=[${f.pages.join(",")}], n=${f.occurrences}`);
      console.log(`    sample_path: ${f.samplePath}`);
      console.log(`    sample_url:  ${shortenUrl(f.sampleResponseUrl)}`);
    }
  }
}

function shortenUrl(url: string): string {
  if (!url) return "";
  return url.length > 170 ? `${url.slice(0, 170)}...` : url;
}

function readCliValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function pickStringField(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return "";
}

function toCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function isLikelyIdOrTimestamp(key: string): boolean {
  const lk = key.toLowerCase();
  return (
    lk === "id" ||
    lk === "uid" ||
    lk === "duration" ||
    lk === "width" ||
    lk === "height" ||
    lk === "fps" ||
    lk === "bitrate" ||
    lk === "ratio" ||
    lk === "size" ||
    lk === "file_size" ||
    lk === "filesize" ||
    lk === "data_size" ||
    lk === "level" ||
    lk === "version" ||
    lk === "version_code" ||
    lk === "status_code" ||
    lk === "code" ||
    lk.endsWith("_id") ||
    lk.endsWith("id") && lk.length > 2 ||
    lk.endsWith("_uid") ||
    lk.endsWith("uid") ||
    lk.includes("create_time") ||
    lk.includes("createtime") ||
    lk.includes("update_time") ||
    lk.includes("updatetime") ||
    lk.includes("publish_time") ||
    lk.includes("publishtime") ||
    lk.includes("expire") ||
    lk.includes("timestamp")
  );
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

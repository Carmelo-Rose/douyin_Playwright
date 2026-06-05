import path from "node:path";
import process from "node:process";
import ExcelJS from "exceljs";
import fs from "fs-extra";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Locator, Page } from "playwright";

chromiumExtra.use(StealthPlugin());

interface WeiboMonitorConfig {
  searchQueries: string[];
  relevanceKeywords: string[];
  excludeKeywords: string[];
  maxScrolls: number;
  captureTimeoutMs: number;
  headless: boolean;
  browserChannel: string;
  userDataDir: string;
  outputDir: string;
  realtime: boolean;
  recentDays: number;
  requireKeywordMatch: boolean;
  requireImage: boolean;
  queryDelayMs: number;
}

interface WeiboPostRecord {
  query: string;
  matchedKeywords: string;
  postId: string;
  text: string;
  authorName: string;
  createTime: string;
  source: string;
  engagementText: string;
  postUrl: string;
  authorUrl: string;
  imageUrls: string;
  capturedAt: string;
}

const DEFAULT_CONFIG_PATH = "social-monitor/config.weibo.json";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function main(): Promise<void> {
  const config = await loadConfig();
  const queries = readCliValues("--query");
  const searchQueries = queries.length > 0 ? queries : config.searchQueries;

  if (searchQueries.length === 0) {
    throw new Error("No search query configured. Add searchQueries in config or pass --query.");
  }

  const { context, page } = await openWeiboBrowser(config);
  const allRecords: WeiboPostRecord[] = [];
  const outputPath = buildOutputPath(config.outputDir, searchQueries.join("_"));

  try {
    for (let i = 0; i < searchQueries.length; i += 1) {
      const query = searchQueries[i];
      console.log(`\n[weibo] search: ${query}`);

      try {
        const records = await captureSearchResults(page, query, config);
        allRecords.push(...records);
        console.log(`[weibo] ${query}: ${records.length} records`);
      } catch (error) {
        console.warn(`[weibo] ${query}: failed (${(error as Error).message}); keep going`);
      }

      // Persist after every query so a mid-run block/abort never loses earlier results.
      await writeWeiboPostsXlsx(dedupeRecords(allRecords), outputPath);

      if (i < searchQueries.length - 1 && config.queryDelayMs > 0) {
        await page.waitForTimeout(randomBetween(config.queryDelayMs, config.queryDelayMs * 2));
      }
    }
  } finally {
    await context.close();
  }

  const deduped = dedupeRecords(allRecords);
  await writeWeiboPostsXlsx(deduped, outputPath);
  console.log(`\n[weibo] exported ${deduped.length} records: ${outputPath}`);
}

async function loadConfig(): Promise<WeiboMonitorConfig> {
  const configPath = resolveFromCwd(readCliValue("--config") || DEFAULT_CONFIG_PATH);
  const raw = await fs.readJson(configPath);
  const config = raw as Partial<WeiboMonitorConfig>;

  return {
    searchQueries: normalizeStringArray(config.searchQueries),
    relevanceKeywords: normalizeStringArray(config.relevanceKeywords),
    excludeKeywords: normalizeStringArray(config.excludeKeywords),
    maxScrolls: positiveInt(config.maxScrolls, 3),
    captureTimeoutMs: positiveInt(config.captureTimeoutMs, 15_000),
    headless: typeof config.headless === "boolean" ? config.headless : false,
    browserChannel: config.browserChannel?.trim() || "chrome",
    userDataDir: resolveFromCwd(config.userDataDir || ".user-data/weibo-monitor"),
    outputDir: resolveFromCwd(config.outputDir || "output"),
    realtime: typeof config.realtime === "boolean" ? config.realtime : false,
    recentDays: Number.isFinite(Number(config.recentDays)) ? Math.max(0, Number(config.recentDays)) : 7,
    requireKeywordMatch:
      typeof config.requireKeywordMatch === "boolean" ? config.requireKeywordMatch : false,
    requireImage: typeof config.requireImage === "boolean" ? config.requireImage : true,
    queryDelayMs: positiveInt(config.queryDelayMs, 4_000),
  };
}

async function openWeiboBrowser(config: WeiboMonitorConfig): Promise<{ context: BrowserContext; page: Page }> {
  await fs.ensureDir(config.userDataDir);

  const launchOptions: Parameters<typeof chromiumExtra.launchPersistentContext>[1] = {
    headless: config.headless,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent: DEFAULT_USER_AGENT,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  };

  if (config.browserChannel) {
    launchOptions.channel = config.browserChannel;
  }

  let context: BrowserContext;
  try {
    context = await chromiumExtra.launchPersistentContext(config.userDataDir, launchOptions);
  } catch (error) {
    if (!config.browserChannel) {
      throw error;
    }

    console.warn(
      `[weibo] failed to launch Chrome channel (${(error as Error).message}); fallback to bundled Chromium`,
    );
    delete launchOptions.channel;
    context = await chromiumExtra.launchPersistentContext(config.userDataDir, launchOptions);
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-expect-error - keep chrome.runtime present for fingerprint parity.
    if (!window.chrome) window.chrome = { runtime: {} };
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30_000);
  return { context, page };
}

async function captureSearchResults(
  page: Page,
  query: string,
  config: WeiboMonitorConfig,
): Promise<WeiboPostRecord[]> {
  // Default = relevance/hot ranking (better signal for this use case).
  // realtime (xsort=time) sorts newest-first but is much noisier.
  const params = new URLSearchParams({ q: query, Refer: "index" });
  if (config.realtime) {
    params.set("xsort", "time");
  }
  // timescope restricts to a recent window; it works regardless of sort, so we can
  // keep relevance ranking AND only look at the last N days.
  if (config.recentDays > 0) {
    params.set("typeall", "1");
    params.set("suball", "1");
    params.set("timescope", buildTimescope(config.recentDays));
  }
  const searchUrl = `https://s.weibo.com/weibo?${params.toString()}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCardsOrLogin(page, config.captureTimeoutMs);

  const records: WeiboPostRecord[] = [];
  for (let index = 0; index <= config.maxScrolls; index += 1) {
    await waitForCardsOrLogin(page, config.captureTimeoutMs);
    records.push(...(await extractCards(page, query, config)));

    if (index < config.maxScrolls) {
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(1200);
    }
  }

  return dedupeRecords(records);
}

async function waitForCardsOrLogin(page: Page, timeoutMs: number): Promise<void> {
  const cardSelector = "div.card-wrap[action-type='feed_list_item'], div.card-wrap";
  try {
    await page.waitForSelector(cardSelector, { timeout: timeoutMs });
    return;
  } catch {
    console.log("[weibo] no result card yet. If login is required, finish login in the opened browser.");
  }

  try {
    await page.waitForSelector(cardSelector, { timeout: 120_000 });
  } catch {
    console.warn("[weibo] still no result card after waiting. Export may be empty for this query.");
  }
}

async function extractCards(
  page: Page,
  query: string,
  config: WeiboMonitorConfig,
): Promise<WeiboPostRecord[]> {
  const relevanceKeywords = config.relevanceKeywords;
  const cardSelector = "div.card-wrap[action-type='feed_list_item'], div.card-wrap";
  const cards = page.locator(cardSelector);
  const count = await cards.count();
  const capturedAt = new Date().toISOString();
  const records: WeiboPostRecord[] = [];

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const cleanText = await getPostText(card);

    const authorName = await firstInnerText(card, ["a.name"]);
    const authorUrl = normalizeUrl(await firstAttribute(card, "a.name", "href"));
    const fromLinks = card.locator("p.from a, .from a");
    const fromCount = await fromLinks.count();
    const createTime = fromCount > 0 ? normalizeText(await fromLinks.nth(0).innerText().catch(() => "")) : "";
    const source = fromCount > 1 ? normalizeText(await fromLinks.nth(1).innerText().catch(() => "")) : "";
    const postUrl = normalizeUrl(fromCount > 0 ? await fromLinks.nth(0).getAttribute("href").catch(() => "") : "");
    const actionData = (await card.getAttribute("action-data").catch(() => "")) || "";
    const postId = actionData.match(/(?:mid|id)=([^&]+)/)?.[1] || postUrl.match(/\/(\w+)\?/)?.[1] || "";
    const engagementText =
      (await firstInnerText(card, [".card-act", "[node-type='feed_list_options']"])) || "";
    const imageUrls = Array.from(new Set(await collectImageUrls(card)));
    const matchedKeywords = relevanceKeywords.filter((keyword) => cleanText.includes(keyword));

    if (!cleanText && !authorName && !postUrl) {
      continue;
    }

    // Drop posts where "帽子" is clearly not a real hat: figurative "扣帽子",
    // slang like "帽子叔叔" (= police), 学士帽/巫婆帽/绿帽子, novel spam, etc.
    if (config.excludeKeywords.some((bad) => cleanText.includes(bad))) {
      continue;
    }

    // The downstream goal is "is there a hat in the picture", so text-only posts
    // (novels, ad copy, figurative "扣帽子" rants) can't contribute — drop them.
    if (config.requireImage && imageUrls.length === 0) {
      continue;
    }

    // When requireKeywordMatch is on, drop cards whose text hits none of the
    // relevance keywords so the export stays focused instead of dumping every card.
    if (config.requireKeywordMatch && relevanceKeywords.length > 0 && matchedKeywords.length === 0) {
      continue;
    }

    records.push({
      query,
      matchedKeywords: matchedKeywords.join(", "),
      postId,
      text: cleanText,
      authorName,
      createTime,
      source,
      engagementText,
      postUrl,
      authorUrl,
      imageUrls: imageUrls.join("\n"),
      capturedAt,
    });
  }

  return records;
}

async function getPostText(card: Locator): Promise<string> {
  // Long posts are collapsed behind "展开全文"; the full node is rendered but hidden,
  // so innerText returns "". Read textContent to get the complete body without clicking.
  const fullNode = card.locator("p.txt[node-type='feed_list_content_full']").first();
  if ((await fullNode.count()) > 0) {
    const full = normalizeText(
      (await fullNode.evaluate((el) => el.textContent || "").catch(() => "")) || "",
    );
    if (full) {
      return cleanPostText(full);
    }
  }

  const text = await firstInnerText(card, [
    "p.txt[node-type='feed_list_content']",
    ".content p.txt",
    ".card-feed",
  ]);
  return cleanPostText(text);
}

function cleanPostText(value: string): string {
  return value
    .replace(/\s*展开全文\s*[cd]?\s*$/i, "")
    .replace(/\s*收起\s*[cd]?\s*$/i, "")
    .replace(/\s*展开\s*[cd]?\s*$/i, "")
    .trim();
}

async function firstInnerText(root: Locator, selectors: string[]): Promise<string> {
  for (const selector of selectors) {
    const target = root.locator(selector).first();
    if ((await target.count()) === 0) {
      continue;
    }

    const text = normalizeText(await target.innerText().catch(() => ""));
    if (text) {
      return text;
    }
  }

  return "";
}

async function firstAttribute(root: Locator, selector: string, name: string): Promise<string> {
  const target = root.locator(selector).first();
  if ((await target.count()) === 0) {
    return "";
  }

  return (await target.getAttribute(name).catch(() => "")) || "";
}

async function collectImageUrls(root: Locator): Promise<string[]> {
  const images = root.locator("img[src]");
  const count = await images.count();
  const urls: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const value = normalizeUrl((await images.nth(index).getAttribute("src").catch(() => "")) || "");
    if (imageLooksUseful(value)) {
      urls.push(value);
    }
  }

  return urls;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeUrl(value: string | null | undefined): string {
  const text = value || "";
  if (text.startsWith("//")) {
    return `https:${text}`;
  }

  return text;
}

function imageLooksUseful(value: string): boolean {
  return Boolean(value) && /\/\/w[xw]\d+\.sinaimg\.cn\/(?:large|mw690|orj360|bmiddle|thumb\d+)/i.test(value);
}

function buildOutputPath(outputDir: string, keyword: string): string {
  const filename = `weibo-posts-${sanitizeFilename(keyword)}-${formatTimestamp(new Date())}.xlsx`;
  return path.join(outputDir, filename);
}

async function writeWeiboPostsXlsx(records: WeiboPostRecord[], outputPath: string): Promise<string> {
  await fs.ensureDir(path.dirname(outputPath));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "weibo_monitor_demo";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("weibo");
  worksheet.columns = [
    { header: "搜索词", key: "query", width: 24 },
    { header: "匹配关键词", key: "matchedKeywords", width: 28 },
    { header: "微博ID", key: "postId", width: 24 },
    { header: "正文", key: "text", width: 70 },
    { header: "作者", key: "authorName", width: 24 },
    { header: "发布时间", key: "createTime", width: 24 },
    { header: "来源", key: "source", width: 18 },
    { header: "互动信息", key: "engagementText", width: 36 },
    { header: "微博链接", key: "postUrl", width: 60 },
    { header: "作者链接", key: "authorUrl", width: 60 },
    { header: "图片链接", key: "imageUrls", width: 80 },
    { header: "抓取时间", key: "capturedAt", width: 28 },
  ];

  worksheet.addRows(records);
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  await workbook.xlsx.writeFile(outputPath);

  return outputPath;
}

function dedupeRecords(records: WeiboPostRecord[]): WeiboPostRecord[] {
  const seen = new Set<string>();
  const deduped: WeiboPostRecord[] = [];

  for (const record of records) {
    const key = record.postId || record.postUrl || `${record.authorName}:${record.text.slice(0, 80)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(record);
  }

  return deduped;
}

function readCliValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readCliValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }

  return values;
}

function resolveFromCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item).trim()).filter(Boolean);
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

// Weibo advanced-search time filter: custom:<start>:<end> with YYYY-MM-DD-HH parts.
function buildTimescope(recentDays: number): string {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - recentDays);

  const fmt = (date: Date, hour: number) => {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(hour)}`;
  };

  return `custom:${fmt(start, 0)}:${fmt(end, end.getHours())}`;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "keyword";
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

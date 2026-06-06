import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { ContentType, Platform, PublishTimeFilter, SearchSort } from "./types.js";

dotenv.config();

export interface AppConfig {
  platform: Platform;
  keyword: string;
  outputDir: string;
  userDataDir: string;
  headless: boolean;
  maxScrolls: number;
  captureTimeoutMs: number;
  maxAgeDays: number;
  contentType: ContentType;
  publishTime: PublishTimeFilter;
  sortBy: SearchSort;
  enrichDouyinDetailImages: boolean;
  enrichXhsDetailImages: boolean;
  detailMaxItems: number;
  detailImageLimit: number;
  detailMinDelayMs: number;
  detailMaxDelayMs: number;
  relevanceKeywords: string[];
  xhsVisualFilter: boolean;
  xhsVisualMaxImages: number;
  xhsVisualConcurrency: number;
  xhsVisualMaxItems: number;
  xhsVisualTimeoutMs: number;
  xhsVisualFewShot: boolean;
  xhsVisualFewShotPath: string;
  xhsVisualRulesPath: string;
  xhsVisualReferenceImages: boolean;
  xhsVisualReferenceGoodDir: string;
  xhsVisualReferenceBadDir: string;
  xhsVisualReferenceBorderlineDir: string;
  xhsVisualReferenceMaxImagesPerClass: number;
  dashscopeApiKey: string;
  dashscopeBaseUrl: string;
  dashscopeModel: string;
  userAgent: string;
  browserChannel: string;
  humanLike: boolean;
}

export type RuntimePlatform = Exclude<Platform, "all">;

interface LoadConfigOptions {
  defaultPlatform?: Platform;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const platform = parsePlatform(readCliValue("--platform") || process.env.PLATFORM, options.defaultPlatform ?? "all");
  const cliKeyword = readCliValue("--keyword");
  const keyword = cliKeyword || process.env.KEYWORD || "帽子";

  return {
    platform,
    keyword,
    outputDir: resolveFromCwd(process.env.OUTPUT_DIR || "output"),
    userDataDir: resolveUserDataDir(platform === "all" ? "douyin" : platform, process.env.USER_DATA_DIR),
    headless: parseBoolean(process.env.HEADLESS, false),
    maxScrolls: parsePositiveInt(process.env.MAX_SCROLLS, 8),
    captureTimeoutMs: parsePositiveInt(process.env.CAPTURE_TIMEOUT_MS, 30_000),
    maxAgeDays: parseNonNegativeInt(readCliValue("--max-age-days") || process.env.MAX_AGE_DAYS, 7),
    contentType: parseContentType(readCliValue("--content-type") || process.env.CONTENT_TYPE, "image"),
    publishTime: parsePublishTime(readCliValue("--publish-time") || process.env.PUBLISH_TIME, "week"),
    sortBy: parseSearchSort(readCliValue("--sort-by") || process.env.SORT_BY, "latest"),
    enrichDouyinDetailImages: parseBoolean(readCliValue("--enrich-douyin-detail-images") || process.env.ENRICH_DOUYIN_DETAIL_IMAGES, true),
    enrichXhsDetailImages: parseBoolean(readCliValue("--enrich-xhs-detail-images") || process.env.ENRICH_XHS_DETAIL_IMAGES, true),
    detailMaxItems: parseNonNegativeInt(readCliValue("--detail-max-items") || process.env.DETAIL_MAX_ITEMS, 30),
    detailImageLimit: parsePositiveInt(readCliValue("--detail-image-limit") || process.env.DETAIL_IMAGE_LIMIT, 6),
    detailMinDelayMs: parseNonNegativeInt(readCliValue("--detail-min-delay-ms") || process.env.DETAIL_MIN_DELAY_MS, 5_000),
    detailMaxDelayMs: parseNonNegativeInt(readCliValue("--detail-max-delay-ms") || process.env.DETAIL_MAX_DELAY_MS, 12_000),
    relevanceKeywords: parseRelevanceKeywords(process.env.RELEVANCE_KEYWORDS, keyword),
    xhsVisualFilter: parseBoolean(readCliValue("--xhs-visual-filter") || process.env.XHS_VISUAL_FILTER, true),
    xhsVisualMaxImages: parsePositiveInt(readCliValue("--xhs-visual-max-images") || process.env.XHS_VISUAL_MAX_IMAGES, 3),
    xhsVisualConcurrency: parsePositiveInt(readCliValue("--xhs-visual-concurrency") || process.env.XHS_VISUAL_CONCURRENCY, 2),
    xhsVisualMaxItems: parseNonNegativeInt(readCliValue("--xhs-visual-max-items") || process.env.XHS_VISUAL_MAX_ITEMS, 0),
    xhsVisualTimeoutMs: parsePositiveInt(readCliValue("--xhs-visual-timeout-ms") || process.env.XHS_VISUAL_TIMEOUT_MS, 90_000),
    xhsVisualFewShot: parseBoolean(readCliValue("--xhs-visual-fewshot") || process.env.XHS_VISUAL_FEWSHOT, true),
    xhsVisualFewShotPath: resolveFromCwd(readCliValue("--xhs-visual-fewshot-path") || process.env.XHS_VISUAL_FEWSHOT_PATH || "prompts/xhs-visual-fewshot.json"),
    xhsVisualRulesPath: resolveFromCwd(readCliValue("--xhs-visual-rules-path") || process.env.XHS_VISUAL_RULES_PATH || "references/xhs/visual_rules.md"),
    xhsVisualReferenceImages: parseBoolean(readCliValue("--xhs-visual-reference-images") || process.env.XHS_VISUAL_REFERENCE_IMAGES, false),
    xhsVisualReferenceGoodDir: resolveFromCwd(
      readCliValue("--xhs-visual-reference-good-dir") || process.env.XHS_VISUAL_REFERENCE_GOOD_DIR || "references/xhs/good",
    ),
    xhsVisualReferenceBadDir: resolveFromCwd(
      readCliValue("--xhs-visual-reference-bad-dir") || process.env.XHS_VISUAL_REFERENCE_BAD_DIR || "references/xhs/bad",
    ),
    xhsVisualReferenceBorderlineDir: resolveFromCwd(
      readCliValue("--xhs-visual-reference-borderline-dir") || process.env.XHS_VISUAL_REFERENCE_BORDERLINE_DIR || "references/xhs/borderline",
    ),
    xhsVisualReferenceMaxImagesPerClass: parsePositiveInt(
      readCliValue("--xhs-visual-reference-max-images-per-class") || process.env.XHS_VISUAL_REFERENCE_MAX_IMAGES_PER_CLASS,
      7,
    ),
    dashscopeApiKey: process.env.DASHSCOPE_API_KEY?.trim() || "",
    dashscopeBaseUrl: (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").trim(),
    dashscopeModel: (process.env.DASHSCOPE_MODEL || "qwen3-vl-flash").trim(),
    userAgent: process.env.USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    browserChannel: process.env.BROWSER_CHANNEL ?? "chrome",
    humanLike: parseBoolean(process.env.HUMAN_LIKE, true),
  };
}

function readCliValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function resolveFromCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function withPlatform(config: AppConfig, platform: RuntimePlatform): AppConfig {
  return {
    ...config,
    platform,
    userDataDir: resolveUserDataDir(platform, process.env.USER_DATA_DIR),
  };
}

function resolveUserDataDir(platform: RuntimePlatform, configured: string | undefined): string {
  const value = configured?.trim();
  if (!value) {
    return resolveFromCwd(`.user-data/${platform}`);
  }

  const normalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (platform === "xhs" && normalized === ".user-data/douyin") {
    return resolveFromCwd(".user-data/xhs");
  }

  return resolveFromCwd(value);
}

function parsePlatform(value: string | undefined, fallback: Platform): Platform {
  const normalized = value?.trim().toLowerCase();
  return normalized === "xhs" || normalized === "douyin" || normalized === "all" ? normalized : fallback;
}

function parseContentType(value: string | undefined, fallback: ContentType): ContentType {
  const normalized = value?.trim().toLowerCase();
  return normalized === "image" || normalized === "video" ? normalized : fallback;
}

function parsePublishTime(value: string | undefined, fallback: PublishTimeFilter): PublishTimeFilter {
  const normalized = value?.trim().toLowerCase();
  return normalized === "day" || normalized === "week" || normalized === "half-year" || normalized === "unlimited"
    ? normalized
    : fallback;
}

function parseSearchSort(value: string | undefined, fallback: SearchSort): SearchSort {
  const normalized = value?.trim().toLowerCase();
  return normalized === "latest" || normalized === "comprehensive" ? normalized : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "y"].includes(value.trim().toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseRelevanceKeywords(value: string | undefined, keyword: string): string[] {
  const configured = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    return configured;
  }

  if (keyword.includes("帽")) {
    return [
      keyword,
      "帽",
      "帽子",
      "鸭舌帽",
      "棒球帽",
      "遮阳帽",
      "渔夫帽",
      "贝雷帽",
      "毛线帽",
      "冷帽",
      "草帽",
      "礼帽",
      "针织帽",
      "MLB",
      "newera",
      "NewEra",
    ];
  }

  return [keyword];
}

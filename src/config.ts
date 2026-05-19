import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  keyword: string;
  searchUrlTemplate: string;
  outputDir: string;
  userDataDir: string;
  headless: boolean;
  maxScrolls: number;
  captureTimeoutMs: number;
}

export function loadConfig(): AppConfig {
  const cliKeyword = readCliValue("--keyword");
  const keyword = cliKeyword || process.env.KEYWORD || "帽子";
  const searchUrlTemplate = process.env.SEARCH_URL_TEMPLATE;

  if (!searchUrlTemplate) {
    throw new Error("Missing SEARCH_URL_TEMPLATE. Copy .env.example to .env and set the current Douyin search URL template.");
  }

  if (!searchUrlTemplate.includes("{keyword}")) {
    throw new Error("SEARCH_URL_TEMPLATE must include {keyword} as the keyword placeholder.");
  }

  return {
    keyword,
    searchUrlTemplate,
    outputDir: resolveFromCwd(process.env.OUTPUT_DIR || "output"),
    userDataDir: resolveFromCwd(process.env.USER_DATA_DIR || ".user-data/douyin"),
    headless: parseBoolean(process.env.HEADLESS, false),
    maxScrolls: parsePositiveInt(process.env.MAX_SCROLLS, 8),
    captureTimeoutMs: parsePositiveInt(process.env.CAPTURE_TIMEOUT_MS, 30_000),
  };
}

export function buildSearchUrl(config: AppConfig): string {
  return config.searchUrlTemplate.replace("{keyword}", encodeURIComponent(config.keyword));
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

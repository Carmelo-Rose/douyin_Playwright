import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  keyword: string;
  outputDir: string;
  userDataDir: string;
  headless: boolean;
  maxScrolls: number;
  captureTimeoutMs: number;
  maxAgeDays: number;
  userAgent: string;
  browserChannel: string;
  humanLike: boolean;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function loadConfig(): AppConfig {
  const cliKeyword = readCliValue("--keyword");
  const keyword = cliKeyword || process.env.KEYWORD || "帽子";

  return {
    keyword,
    outputDir: resolveFromCwd(process.env.OUTPUT_DIR || "output"),
    userDataDir: resolveFromCwd(process.env.USER_DATA_DIR || ".user-data/douyin"),
    headless: parseBoolean(process.env.HEADLESS, false),
    maxScrolls: parsePositiveInt(process.env.MAX_SCROLLS, 8),
    captureTimeoutMs: parsePositiveInt(process.env.CAPTURE_TIMEOUT_MS, 30_000),
    maxAgeDays: parseNonNegativeInt(process.env.MAX_AGE_DAYS, 7),
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

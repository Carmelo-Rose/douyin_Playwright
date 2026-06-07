/**
 * 主进程 ↔ renderer 之间共享的 IPC 频道名与载荷类型。
 * 主进程、preload、renderer 三处都引用本文件，保证类型一致。
 */
import type { AppConfig } from "../../src/config.js";

export type { AppConfig };

export const IPC = {
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  secretGet: "secret:getApiKey",
  secretSet: "secret:setApiKey",
  scrapeStart: "scrape:start",
  scrapeCancel: "scrape:cancel",
  scrapeLog: "scrape:log", // 主进程 → renderer 单向推送
  resultsList: "results:list",
  resultsRead: "results:read",
  resultsOpen: "results:open",
  resultsReveal: "results:reveal",
} as const;

export type ScrapeLogLevel = "info" | "error" | "status";

export interface ScrapeLogEvent {
  runId: string;
  level: ScrapeLogLevel;
  line: string;
  /** status 行识别出的状态标记（login/captcha/done），供 UI 弹提示 */
  status?: "awaiting-login" | "captcha" | "done";
}

export interface ScrapeStartResult {
  runId: string;
}

export interface ResultFileMeta {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ResultRow {
  [column: string]: string | number | null;
}

export interface ResultSheet {
  columns: string[];
  rows: ResultRow[];
}

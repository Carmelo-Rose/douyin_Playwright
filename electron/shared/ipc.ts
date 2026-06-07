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
  selectOutputDir: "settings:selectOutputDir",
  scrapeStart: "scrape:start",
  scrapeCancel: "scrape:cancel",
  scrapeLog: "scrape:log", // 主进程 → renderer 单向推送
  resultsList: "results:list",
  resultsRead: "results:read",
  resultsOpen: "results:open",
  resultsReveal: "results:reveal",
  // —— ML 工作台 ——
  mlGetSettings: "ml:getSettings",
  mlSetSettings: "ml:setSettings",
  mlDetectEnv: "ml:detectEnv",
  mlNewRun: "ml:newRun",
  mlSelectFolder: "ml:selectFolder",
  mlExtract: "ml:extract",
  mlPredict: "ml:predict",
  mlListSorted: "ml:listSorted",
  mlFlipImage: "ml:flipImage",
  mlMerge: "ml:merge",
  mlTrain: "ml:train",
  mlGetReport: "ml:getReport",
  mlCancel: "ml:cancel",
  mlLog: "ml:log", // 主进程 → renderer 单向推送
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

// —— ML 工作台 ——
export interface MlSettings {
  pythonPath: string; // 空=自动探测 python3/python
  backbone: string; // 默认 siglip2-l（与当前 1024 维模型一致）
  threshold: number; // 判 good 的概率阈值
  maxNotes: number; // xlsx 提取：前 N 条，0=全部
  imgsPerNote: number; // xlsx 提取：每条取前几张
}

export interface TrainReport {
  samples_dedup?: number;
  good_dedup?: number;
  bad_dedup?: number;
  feature_dim?: number;
  cv_random_leak_acc?: number;
  cv_groupkfold_acc?: number;
  cv_precision_good?: number;
  cv_recall_good?: number;
  cv_f1?: number;
  n_errors?: number;
  confusion?: { TP: number; TN: number; FP: number; FN: number };
  [k: string]: unknown;
}

export interface MlEnvReport {
  pythonPath: string;
  ok: boolean; // 解释器可用且依赖齐全
  pythonVersion: string;
  missing: string[]; // 缺失的依赖模块
  hasModel: boolean;
  modelDim: number | null; // train_report.feature_dim
  backboneDim: number | null; // 所选 backbone 期望维度
  dimMismatch: boolean; // modelDim ≠ backboneDim（predict 会崩）
  report: TrainReport | null;
  error?: string;
}

export interface MlRunPaths {
  runId: string;
  runDir: string; // predict --sort-to 目标（含 good/bad）
  toPredictDir: string; // xlsx 提图输出目录
}

export interface SortedImage {
  name: string;
  path: string; // 绝对路径
  url: string; // vpmedia:// 可直接 <img src>
  label: "good" | "bad";
  pGood: number; // 从文件名前缀解析的 P(good)，0..1；无前缀=-1
}

export interface MlJobResult {
  jobId: string;
}

export interface MlLogEvent {
  jobId: string;
  level: "info" | "error" | "status";
  line: string;
  done?: boolean;
  code?: number | null;
}

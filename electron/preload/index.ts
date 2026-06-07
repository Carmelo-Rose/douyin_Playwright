import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type AppConfig,
  type MlEnvReport,
  type MlJobResult,
  type MlLogEvent,
  type MlRunPaths,
  type MlSettings,
  type ResultFileMeta,
  type ResultSheet,
  type ScrapeLogEvent,
  type ScrapeStartResult,
  type SortedImage,
  type TrainReport,
} from "../shared/ipc.js";

export interface MlApi {
  getSettings(): Promise<MlSettings>;
  setSettings(partial: Partial<MlSettings>): Promise<boolean>;
  detectEnv(): Promise<MlEnvReport>;
  newRun(): Promise<MlRunPaths>;
  selectFolder(): Promise<string | null>;
  extract(p: { xlsx: string; out: string; maxNotes: number; imgsPerNote: number }): Promise<MlJobResult>;
  predict(p: { input: string; sortTo: string; threshold: number }): Promise<MlJobResult>;
  merge(p: { runDir: string }): Promise<MlJobResult>;
  train(): Promise<MlJobResult>;
  listSorted(runDir: string): Promise<SortedImage[]>;
  flipImage(p: { path: string; to: "good" | "bad" }): Promise<SortedImage | null>;
  getReport(): Promise<TrainReport | null>;
  cancel(jobId: string): Promise<boolean>;
  onLog(cb: (e: MlLogEvent) => void): () => void;
}

export interface VpApi {
  getSettings(): Promise<{ config: AppConfig; hasApiKey: boolean; outputDir: string }>;
  saveSettings(partial: Partial<AppConfig>): Promise<boolean>;
  setApiKey(key: string): Promise<boolean>;
  hasApiKey(): Promise<boolean>;
  selectOutputDir(): Promise<string | null>;
  startScrape(config: AppConfig): Promise<ScrapeStartResult>;
  cancelScrape(runId: string): Promise<boolean>;
  onScrapeLog(cb: (e: ScrapeLogEvent) => void): () => void;
  listResults(): Promise<ResultFileMeta[]>;
  readResult(filePath: string): Promise<ResultSheet>;
  openResult(filePath: string): Promise<string>;
  revealResult(filePath: string): Promise<void>;
  ml: MlApi;
}

const api: VpApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (partial) => ipcRenderer.invoke(IPC.settingsSet, partial),
  setApiKey: (key) => ipcRenderer.invoke(IPC.secretSet, key),
  hasApiKey: () => ipcRenderer.invoke(IPC.secretGet),
  selectOutputDir: () => ipcRenderer.invoke(IPC.selectOutputDir),
  startScrape: (config) => ipcRenderer.invoke(IPC.scrapeStart, config),
  cancelScrape: (runId) => ipcRenderer.invoke(IPC.scrapeCancel, runId),
  onScrapeLog: (cb) => {
    const listener = (_e: unknown, payload: ScrapeLogEvent) => cb(payload);
    ipcRenderer.on(IPC.scrapeLog, listener);
    return () => ipcRenderer.removeListener(IPC.scrapeLog, listener);
  },
  listResults: () => ipcRenderer.invoke(IPC.resultsList),
  readResult: (filePath) => ipcRenderer.invoke(IPC.resultsRead, filePath),
  openResult: (filePath) => ipcRenderer.invoke(IPC.resultsOpen, filePath),
  revealResult: (filePath) => ipcRenderer.invoke(IPC.resultsReveal, filePath),
  ml: {
    getSettings: () => ipcRenderer.invoke(IPC.mlGetSettings),
    setSettings: (partial) => ipcRenderer.invoke(IPC.mlSetSettings, partial),
    detectEnv: () => ipcRenderer.invoke(IPC.mlDetectEnv),
    newRun: () => ipcRenderer.invoke(IPC.mlNewRun),
    selectFolder: () => ipcRenderer.invoke(IPC.mlSelectFolder),
    extract: (p) => ipcRenderer.invoke(IPC.mlExtract, p),
    predict: (p) => ipcRenderer.invoke(IPC.mlPredict, p),
    merge: (p) => ipcRenderer.invoke(IPC.mlMerge, p),
    train: () => ipcRenderer.invoke(IPC.mlTrain),
    listSorted: (runDir) => ipcRenderer.invoke(IPC.mlListSorted, runDir),
    flipImage: (p) => ipcRenderer.invoke(IPC.mlFlipImage, p),
    getReport: () => ipcRenderer.invoke(IPC.mlGetReport),
    cancel: (jobId) => ipcRenderer.invoke(IPC.mlCancel, jobId),
    onLog: (cb) => {
      const listener = (_e: unknown, payload: MlLogEvent) => cb(payload);
      ipcRenderer.on(IPC.mlLog, listener);
      return () => ipcRenderer.removeListener(IPC.mlLog, listener);
    },
  },
};

contextBridge.exposeInMainWorld("vp", api);

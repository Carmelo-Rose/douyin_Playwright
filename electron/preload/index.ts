import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type AppConfig,
  type ResultFileMeta,
  type ResultSheet,
  type ScrapeLogEvent,
  type ScrapeStartResult,
} from "../shared/ipc.js";

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
};

contextBridge.exposeInMainWorld("vp", api);

import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    // playwright / exceljs / electron-store 等保持外部依赖（运行时从 node_modules 解析）
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          // 主进程入口
          index: resolve(__dirname, "electron/main/index.ts"),
          // 抓取子进程入口：被 fork 出来跑现有 src/* 抓取逻辑
          runner: resolve(__dirname, "scripts/scrape-runner.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/preload/index.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "renderer/index.html"),
        },
      },
    },
  },
});

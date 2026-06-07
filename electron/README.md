# 桌面客户端（Electron）

把抓取 + ML 项目包装成图形界面。v1 已覆盖**抓取**：填表单 → 运行 → 看实时日志 → 浏览结果。ML 闭环为 Phase 2。

## 技术栈

electron-vite + React + TypeScript + electron-builder + electron-store。

## 开发

```bash
npm install
npm run dev        # electron-vite 起开发模式（含 HMR）
```

## 构建 / 打包

```bash
npm run build:app  # 编译 main/preload/renderer 到 out/
npm run dist       # 上一步 + electron-builder 产出安装包（mac dmg / win nsis）到 release/
```

## 结构

| 路径 | 作用 |
|---|---|
| `electron/main/index.ts` | 主进程：窗口、IPC、子进程编排、设置(electron-store)、密钥(safeStorage) |
| `electron/preload/index.ts` | contextBridge 暴露 `window.vp` API |
| `electron/shared/ipc.ts` | 主进程/preload/renderer 共享的频道名与类型 |
| `scripts/scrape-runner.ts` | 被 fork 的抓取子进程，复用 `src/` 抓取逻辑（零改动） |
| `renderer/` | React UI：抓取设置 / 运行日志 / 结果浏览 |

## 关键设计

- **抓取走子进程**：主进程 `fork(out/main/runner.js)`，工作目录设为 `userData/workspace`，
  登录态落 `workspace/.user-data/<平台>`、产物落 `workspace/output`。stdout 逐行转发到 UI 日志面板。
- **配置**：UI 表单 ↔ `electron-store`；运行时由 `src/config.ts` 的 `resolveConfig(overrides)` 合并。
  现有 `npm run capture` CLI 路径不受影响。
- **密钥**：DashScope API Key 用 `safeStorage` 加密存系统钥匙串，运行时以环境变量注入子进程，不落明文。
- **登录/验证码**：对子进程日志做短语识别，在 UI 顶部弹提示，引导用户到 Playwright 弹出的 Chrome 窗口操作。

## 已知待办

- 登录/验证码识别基于日志短语匹配，较脆；后续可给 capture 函数加结构化 `onStatus` 回调。
- 打包后 asar 内 fork runner 需验证（必要时对 `out/main/runner.js` 及 playwright 做 asarUnpack）。
- Phase 2：ML 工作台（分拣/纠错/重训），复用本机 Python，调 `ml/*.py`。

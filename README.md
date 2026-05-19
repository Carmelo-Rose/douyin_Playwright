# Douyin Mall Product Capture Demo

本地自用的抖音商城商品搜索抓取 Demo。脚本会打开持久化 Playwright 浏览器，复用登录态，监听 XHR/fetch 响应提取商品数据；如果接口解析不到商品，会降级从页面 DOM 中提取可见商品卡片信息，并导出 XLSX。

## Setup

```bash
npm install
cp .env.example .env
```

编辑 `.env`：

- `KEYWORD`：默认搜索关键词，例如 `帽子`
- `SEARCH_URL_TEMPLATE`：当前可用的抖音搜索/商城搜索 URL，必须保留 `{keyword}` 占位符
- `HEADLESS=false`：首次运行建议保持 false，方便手动登录

## Run

```bash
npm run capture
```

临时覆盖关键词：

```bash
npm run capture -- --keyword 帽子
```

首次运行会打开浏览器窗口；如果需要登录，请在窗口里手动完成登录。登录态会保存在 `.user-data/douyin`，后续运行会复用。

抓取结果输出到 `output/`：

```text
douyin-products-<keyword>-<YYYYMMDD-HHmmss>.xlsx
```

## Checks

```bash
npm run typecheck
npm run build
```

## Notes

- 页面入口不要写死在代码里，抖音页面结构变化时优先更新 `.env` 的 `SEARCH_URL_TEMPLATE`。
- Network 解析依赖接口响应结构，DOM fallback 依赖页面可见商品卡片；两者都可能随页面改版调整。
- v1 只做本地自用 Demo，不包含反爬绕过、代理池或云端定时调度。

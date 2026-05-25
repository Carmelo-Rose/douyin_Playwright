# Douyin / Xiaohongshu Capture Demo

本地自用的抖音 / 小红书搜索抓取 Demo。脚本会用 Playwright 启动持久化 Chrome（复用登录态），监听 XHR/fetch 响应并导出 XLSX。抖音流程保持原有精选搜索 + 综合搜索；小红书先提供探针和初步笔记采集，后续可根据真实 dump 继续收紧字段。

## Setup

```bash
npm install
cp .env.example .env
```

编辑 `.env`（所有项都有默认值，可选）：

- `KEYWORD`：默认搜索关键词，例如 `帽子`
- `PLATFORM=all`：主抓取平台，支持 `all` / `douyin` / `xhs`；`all` 会先抓抖音再抓小红书
- `HEADLESS=false`：首次运行保持 false 以便手动登录
- `MAX_SCROLLS`、`CAPTURE_TIMEOUT_MS`：滚动次数 / 最后等待时长
- `MAX_AGE_DAYS=7`：只导出最近 7 天发布的视频；设为 `0` 可关闭发布时间过滤
- `RELEVANCE_KEYWORDS`：相关性过滤词，多个词用英文逗号分隔；留空时会根据 `KEYWORD` 自动生成基础关键词
- `USER_AGENT`、`BROWSER_CHANNEL=chrome`、`HUMAN_LIKE=true`：反检测 / 人类化（详见 .env.example）
- `USER_DATA_DIR`：留空时默认 `.user-data/<PLATFORM>`；抖音和小红书登录态分开保存
- `SEARCH_URL_TEMPLATE`：已废弃，留着不影响运行

## Run

```bash
npm run capture
```

默认按 `PLATFORM=all` 串行抓取：先抖音，再小红书。

临时覆盖关键词：

```bash
npm run capture -- --keyword 帽子
```

只跑单个平台：

```bash
npm run capture -- --platform douyin --keyword 帽子
npm run capture -- --platform xhs --keyword 帽子
```

**首次运行**会停在抖音首页等你手动扫码登录，登录成功后脚本自动继续。登录态保存在 `.user-data/douyin`，后续运行直接跳过登录。

小红书探针：

```bash
npm run probe:xhs -- --keyword 帽子
```

小红书正式采集入口：

```bash
npm run capture -- --platform xhs --keyword 帽子
```

小红书登录态保存在 `.user-data/xhs`。

如果中途弹滑块验证码，控制台会提示，请在浏览器手动滑完，脚本自动继续。

输出在 `output/`：

```text
douyin-videos-<keyword>-<YYYYMMDD-HHmmss>.xlsx
xhs-notes-<keyword>-<YYYYMMDD-HHmmss>.xlsx
```

12 列：视频ID / 来源 / 标题描述 / 作者 / 发布时间 / 点赞 / 评论 / 分享 / 收藏 / 分享链接 / 封面 / 抓取时间。

**注意**：「播放数」当前搜索接口通常不返回可用值，已不在表格里展示。「分享链接」按 `https://www.douyin.com/video/<awemeId>` 合成，可直接点击。

## Debug

```powershell
$env:DEBUG_CAPTURE="true"; npm run capture *> output/控制台日志.txt
```

DEBUG 模式会：
- 打印每条命中的 XHR URL
- 把命中白名单的响应 JSON 原文 dump 到 `output/debug-douyin-*.json` 或 `output/debug-xhs-*.json`，方便分析接口结构

## 单视频播放数探测

播放数先不接入主抓取流程，可以用独立入口测试某个视频详情页：

```bash
npm run probe:play-count -- --aweme-id 7639981756393854137
```

也可以传视频链接，脚本会先提取其中的 `aweme_id`，再转成更稳定的 `modal_id` 详情入口：

```bash
npm run probe:play-count -- --url https://www.douyin.com/video/7639981756393854137
```

脚本会复用 `.user-data/douyin` 登录态，默认打开 `https://www.douyin.com/jingxuan?modal_id=<awemeId>` 详情弹层，优先从详情页 XHR/Fetch 响应里找当前 `aweme_id` 对应的 `play_count` / `view_count` 类字段，再用页面内嵌数据和可见文本做兜底。结果会打印到控制台，并保存到：

```text
output/play-count-probe-<awemeId>-<YYYYMMDD-HHmmss>.json
```

如果 `best_play_count: not found` 或候选值只有 0，说明当前详情页也没有暴露可用播放数，需要再尝试移动端接口、创作者页或榜单类数据源。

## Checks

```bash
npm run typecheck
npm run build
```

## Notes

- 主入口 `src/index.ts` 只负责按 `PLATFORM` / `--platform` 分发；平台差异放在 `src/platforms/douyin/` 和 `src/platforms/xhs/`。
- 抓取路径 1：goto `https://www.douyin.com/jingxuan` → 找搜索框输入关键词 → 回车 → 等 SPA 路由到 `/jingxuan/search/<keyword>` → 滚动收集 XHR。
- 抓取路径 2：goto `https://www.douyin.com/root/search/<keyword>?aid=31f360ee-d884-44a8-ab0b-34086c05f4fa&type=general` → 滚动收集 XHR。
- 滚动前会尝试点页面筛选：`最新发布` / `一周内` / `视频`；如果页面筛选控件变了，会继续抓取并依赖 `MAX_AGE_DAYS` 兜底。
- 接口：`https://www.douyin.com/aweme/v1/web/general/search/single/`（精选搜索）。
- 视频候选识别：响应里寻找带 `aweme_id` + `desc` + (`statistics` 或 `author`) 的对象。子卡片（嵌套在主结果里的关联视频）因为缺 `desc` 会被丢掉，只保留字段完整的主卡视频。
- 两个来源最终按 `aweme_id` 合并去重；同一个视频被两个入口抓到时，`来源` 会合并为 `jingxuan,root_search`。
- 近 7 天过滤是在已抓到的视频里按 `create_time` 过滤，不完全依赖页面筛选；如果结果太少，可以提高 `MAX_SCROLLS`。
- 导出前会再做关键词相关性过滤，避免搜索推荐流把无关视频混进表格。
- 小红书 v1 先按 `search/homefeed/feed/note` 相关接口做候选 JSON 识别；如果导出字段为空，先跑 `npm run probe:xhs` 查看 `output/debug-xhs-*.json` 再调整字段映射。
- v1 只做本地自用 Demo，不包含反爬绕过、代理池或云端定时调度。配置里的反检测项（stealth + 人类化滚动）只是基础降低风控概率，不保证 100% 不弹验证。

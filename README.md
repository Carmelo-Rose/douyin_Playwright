# Douyin / Xiaohongshu Capture Demo

本地自用的抖音 / 小红书搜索抓取 Demo。脚本会用 Playwright 启动持久化 Chrome（复用登录态），监听 XHR/fetch 响应并导出 XLSX。抖音流程保持原有精选搜索 + 综合搜索；小红书先提供探针和初步笔记采集，后续可根据真实 dump 继续收紧字段。

除命令行抓取外，仓库还包含一个 Electron 桌面应用（「ML 工作台」），把识图分拣、人工纠错、合并重训的主动学习闭环整合到图形界面，详见下文 [ML 工作台](#ml-工作台桌面应用)。

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
- `CONTENT_TYPE=image`：内容形式，默认抓“图文”；需要切回视频可设为 `video`，也可用 `--content-type video` 临时覆盖
- `PUBLISH_TIME=week`：页面发布时间筛选，支持 `day` / `week` / `half-year` / `unlimited`
- `SORT_BY=latest`：小红书排序，支持 `latest` / `comprehensive`
- `ENRICH_DOUYIN_DETAIL_IMAGES=true` / `ENRICH_XHS_DETAIL_IMAGES=true`：图文会逐条打开详情页补抓多张图片；默认最多处理 30 条、每条最多 6 张、每条之间随机等待 5-12 秒，遇到验证码会停止补图并保留封面
- `MAX_AGE_DAYS=7`：只导出最近 7 天发布的内容；设为 `0` 可关闭发布时间过滤
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

临时切回视频内容：

```bash
npm run capture -- --keyword 帽子 --content-type video
```

临时控制详情补图数量和节奏：

```bash
npm run capture -- --platform douyin --keyword 帽子 --detail-max-items 20 --detail-image-limit 6 --detail-min-delay-ms 5000 --detail-max-delay-ms 12000
```

抓取页面筛选为“半年内”，并在导出前保留最近 180 天：

```bash
npm run capture -- --platform douyin --keyword 帽子 --publish-time half-year --max-age-days 180
```

小红书仅使用“帽子关键词 + 图文”，综合排序且不限发布时间：

```bash
npm run capture -- --platform xhs --keyword 帽子 --sort-by comprehensive --content-type image --publish-time unlimited --max-age-days 0 --xhs-visual-filter false
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

小红书视觉筛选（DashScope）：在 `.env` 填 `DASHSCOPE_API_KEY` 后默认开启。导出的 `notes` sheet 保留全量记录并新增视觉判断列，`qualified` sheet 只汇总“是 / 疑似”的链接。建议先小批量验证：

```bash
npm run capture -- --platform xhs --keyword 帽子 --detail-max-items 10 --detail-image-limit 3 --xhs-visual-max-items 10
```

视觉筛选默认会读取 `prompts/xhs-visual-fewshot.json` 里的 few-shot 参考样板，用来校准“成人真人戴帽且帽子清楚”与商品图、货架图、手工图、儿童图等噪声边界。可在 `.env` 里用 `XHS_VISUAL_FEWSHOT=false` 关闭，或用 `XHS_VISUAL_FEWSHOT_PATH=...` 指向自定义样板文件。

如果要用固定参考图校准，把 6-7 张合适图放到 `references/xhs/good/`，6-7 张不合适图放到 `references/xhs/bad/`，边界图可放到 `references/xhs/borderline/`。默认不发送参考图，避免每条识别都变慢变贵；需要校准时临时打开：

```bash
npm run capture -- --platform xhs --keyword 帽子 --xhs-visual-reference-images true --xhs-visual-max-items 10
```

固定文字规则写在 `references/xhs/visual_rules.md`，后续可以根据你的参考图和误判样本继续补充。

小红书登录态保存在 `.user-data/xhs`。

如果中途弹滑块验证码，控制台会提示，请在浏览器手动滑完，脚本自动继续。

输出在 `output/`：

```text
douyin-videos-<keyword>-<YYYYMMDD-HHmmss>.xlsx
xhs-notes-<keyword>-<YYYYMMDD-HHmmss>.xlsx
```

抖音表格字段包括：视频ID / 来源 / 标题描述 / 作者 / 发布时间 / 点赞 / 评论 / 分享 / 收藏 / 分享链接 / 图片1-图片6 / 图片链接 / 详情补图状态 / 封面链接 / 抓取时间。

小红书表格字段包括：笔记ID / 来源 / 标题 / 正文 / 作者 / 作者ID / 发布时间 / 点赞 / 评论 / 收藏 / 笔记链接 / 链接状态 / 图片1-图片6 / 图片链接 / 详情补图状态 / 封面链接 / 抓取时间。

**注意**：「播放数」当前搜索接口通常不返回可用值，已不在表格里展示。「分享链接」按 `https://www.douyin.com/video/<awemeId>` 合成，可直接点击。

## Debug

```powershell
$env:DEBUG_CAPTURE="true"; npm run capture *> output/控制台日志.txt
```

DEBUG 模式会：
- 打印每条命中的 XHR URL
- 把命中白名单的响应 JSON 原文 dump 到 `output/debug-douyin-*.json` 或 `output/debug-xhs-*.json`，方便分析接口结构

## 微博观察 Demo

`social-monitor/` 是独立观察脚本目录，不属于原 `npm run capture` 主流程，也不会影响抖音 / 小红书现有采集逻辑。第一版先做微博关键词搜索样本抓取，后续再基于导出的正文配图接入看图判断。

运行默认配置：

```powershell
npx tsx social-monitor/weibo-demo.ts
```

临时只跑一个搜索词：

```powershell
npx tsx social-monitor/weibo-demo.ts --query "明星 帽子"
```

关键词和滚动次数在 `social-monitor/config.weibo.json` 里改。当前默认观察词包括：

```text
明星 帽子
明星 戴帽子
明星 机场 帽子
明星 同款 帽子
```

微博登录态单独保存在 `.user-data/weibo-monitor`。首次运行如果页面要求登录，在打开的浏览器里手动登录即可。

输出在 `output/`：

```text
weibo-posts-<关键词>-<YYYYMMDD-HHmmss>.xlsx
```

字段包括：搜索词 / 匹配关键词 / 微博ID / 正文 / 作者 / 发布时间 / 来源 / 互动信息 / 微博链接 / 作者链接 / 图片链接 / 抓取时间。

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

## ML 工作台（桌面应用）

`electron/` + `renderer/` 是一个 Electron 桌面应用，把抓取、结果浏览和 **ML 识图分拣** 整合到图形界面。ML 部分对接 `ml/` 下的 Python 管线（识图 / 合并 / 重训），无需手敲命令。

```bash
npm run dev      # 开发模式（热更新）
npm run start    # 生产模式（先打包再启动）
```

> `npm run dev` 启动时会等 Vite devserver 就绪再加载窗口，避免白屏。

打开后切到「ML 工作台」标签，工作流分五步：

1. **① 运行环境**：检测 Python 与依赖、模型维度是否与当前 backbone 匹配。当前正式 backbone 为 `clip-b32`（512 维），系经同口径消融确定（SigLIP2 打平、美学分无增量，详见 [`ml/backbone_compare.md`](ml/backbone_compare.md)）。
2. **② 待判断图片**：从抓取结果 xlsx 提取图片，或直接选本地文件夹。
3. **③ 识图分拣**：调用 `ml/predict.py`，按 `P(good)` 阈值把图分拣到 `good/` 和 `bad/`。首次运行需加载模型权重，冷启动较慢。
4. **④ 纠错**：人工复核分拣结果。每张缩略图：
   - **鼠标移上去** 出现三个小按钮：移到另一侧（good ↔ bad）、🔍 放大预览、✕ 删除（软删除到 `_trash/`，顶部 5 秒内可撤销）。
   - **橙色框** = 边界图（`P(good)` 在 0.4~0.6 之间），最值得人工纠。**蓝色脉冲** = 刚移动/恢复的图。
   - good/bad 两栏各自独立滚动、分批加载，纠错时页面不跳顶、不被撑长。
5. **⑤ 合并纠错 → 重训**：
   - **合并进训练集**（`ml/merge_feedback.py`）：把本批纠错结果**追加复制**到 `ml/data/labeled/good|bad`，原有数据保留，重名自动加 `_fb{N}` 后缀，`_trash/` 被忽略。此步只搬文件，**不更新模型**。
   - **重新训练**（`ml/train_singleimage.py`）：用 `ml/data/labeled/` 的**全量数据**（旧 + 新）从头重新拟合模型，覆盖旧模型文件。数据累加、模型重练，并非只用本批或在旧模型上增量微调。
   - 训练报告（分组 CV 准确率 / 精确率 / 召回 / F1 / 误判数）显示在该区底部。

> 主动学习闭环：识图 → 纠错 → 合并 → 重训。重点纠那些边界图（信息量最大），多攒几轮再统一重训即可。
> ML 子系统的命令行用法见 [`ml/README.md`](ml/README.md)。

## Checks

```bash
npm run typecheck
npm run build
```

## Notes

- 主入口 `src/index.ts` 只负责按 `PLATFORM` / `--platform` 分发；平台差异放在 `src/platforms/douyin/` 和 `src/platforms/xhs/`。
- 抓取路径 1：goto `https://www.douyin.com/jingxuan` → 找搜索框输入关键词 → 回车 → 等 SPA 路由到 `/jingxuan/search/<keyword>` → 滚动收集 XHR。
- 抓取路径 2：goto `https://www.douyin.com/root/search/<keyword>?aid=31f360ee-d884-44a8-ab0b-34086c05f4fa&type=general` → 滚动收集 XHR。
- 滚动前会尝试点页面筛选：`最新发布` / 发布时间 / 内容形式。发布时间可用 `--publish-time day|week|half-year|unlimited` 控制，内容形式可用 `--content-type image|video` 控制。如果页面筛选控件变了，会继续抓取并依赖 `MAX_AGE_DAYS` 兜底。
- 接口：`https://www.douyin.com/aweme/v1/web/general/search/single/`（精选搜索）。
- 视频候选识别：响应里寻找带 `aweme_id` + `desc` + (`statistics` 或 `author`) 的对象。子卡片（嵌套在主结果里的关联视频）因为缺 `desc` 会被丢掉，只保留字段完整的主卡视频。
- 两个来源最终按 `aweme_id` 合并去重；同一个视频被两个入口抓到时，`来源` 会合并为 `jingxuan,root_search`。
- 近 7 天过滤是在已抓到的内容里按 `create_time` 过滤，不完全依赖页面筛选；如果结果太少，可以提高 `MAX_SCROLLS`。
- 导出前会再做关键词相关性过滤，避免搜索推荐流把无关内容混进表格。
- 小红书 v1 先按 `search/homefeed/feed/note` 相关接口做候选 JSON 识别；如果导出字段为空，先跑 `npm run probe:xhs` 查看 `output/debug-xhs-*.json` 再调整字段映射。
- v1 只做本地自用 Demo，不包含反爬绕过、代理池或云端定时调度。配置里的反检测项（stealth + 人类化滚动）只是基础降低风控概率，不保证 100% 不弹验证。

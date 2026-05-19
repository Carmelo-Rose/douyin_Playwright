# 抖音播放数探测报告

生成时间：2026-05-19  
项目路径：`D:\data\accio\douyin_Playwright`

## 结论

当前已经验证的抖音 Web、分享页、作者页、移动分享页数据源，都不能拿到真实播放数。

这些接口/页面通常保留 `play_count` 或 `playCount` 字段，但实际返回值是 `0`，不是解析代码漏字段。也就是说，目前的问题不是字段提取逻辑，而是公开 Web 数据源没有下发真实播放量。

现阶段不建议把“播放数”接入主导出流程；否则会导出一列大量 `0`，容易误导后续分析。

## 当前项目状态

主流程是本地 Playwright 抖音搜索视频抓取 Demo：

- 入口：`npm run capture`
- 主代码：`src/index.ts`
- 网络解析：`src/networkCapture.ts`
- 导出：`src/exportXlsx.ts`
- 输出目录：`output/`

已经新增一个独立播放数探测入口，不影响主流程：

- 文件：`src/playCountProbe.ts`
- 命令：

```bash
npm run probe:play-count -- --aweme-id 7639981756393854137
```

也可以传 URL：

```bash
npm run probe:play-count -- --url https://www.douyin.com/video/7639981756393854137
```

脚本会把普通 `/video/<id>` 链接转成更稳定的详情弹层入口：

```text
https://www.douyin.com/jingxuan?modal_id=<aweme_id>
```

输出 JSON 示例：

```text
output/play-count-probe-7639981756393854137-20260519-173337.json
```

## 样本视频

主要测试样本：

```text
aweme_id: 7639981756393854137
作者: 自然回响录
sec_uid: MS4wLjABAAAAOq9Ri_9lfAp1AjJoQrLMjFAjvunBxsT6eUOEGqQyqTM
```

额外验证样本：

```text
7639953654853782819
7641313236075253028
```

这些样本来自历史导出文件：

```text
output/douyin-videos-帽子-20260519-171409.xlsx
output/douyin-videos-帽子-20260519-172622.xlsx
```

## 已测试数据源

### 1. Web 详情弹层

入口：

```text
https://www.douyin.com/jingxuan?modal_id=<aweme_id>
```

结果：

```text
best_play_count: not found
候选字段：playCount = 0
路径：$.app.videoDetail.stats
```

结论：详情弹层能打开，也能读到统计对象，但播放数为 0。

### 2. PC 分享页

入口：

```text
https://www.iesdouyin.com/share/video/<aweme_id>/
```

触发接口：

```text
https://www.douyin.com/aweme/v1/web/aweme/detail/
```

结果：

```json
{
  "comment_count": 395,
  "digg_count": 14329,
  "play_count": 0,
  "share_count": 8334,
  "collect_count": 1572
}
```

结论：`aweme/detail` 有字段，但 `play_count` 是 0。

### 3. 作者主页作品列表

入口：

```text
https://www.douyin.com/user/<sec_uid>
```

触发接口：

```text
https://www.douyin.com/aweme/v1/web/aweme/post/
```

结果：

```json
{
  "recommend_count": 535,
  "comment_count": 395,
  "digg_count": 14329,
  "admire_count": 0,
  "play_count": 0,
  "share_count": 8334,
  "collect_count": 1572
}
```

结论：作者作品列表能找到目标视频，但 `play_count` 仍然是 0。

### 4. 作者主页加详情弹层

入口：

```text
https://www.douyin.com/user/<sec_uid>?modal_id=<aweme_id>
```

结果和作者主页作品列表一致：

```text
statistics.play_count = 0
```

结论：没有额外拿到真实播放数。

### 5. 移动端分享页

测试方式：

- iPhone viewport
- 手机 User-Agent
- 访问 `iesdouyin.com/share/video/<aweme_id>/`
- 也试过 `douyin.com/share/video/<aweme_id>/` 和 `m.douyin.com/share/video/<aweme_id>/`

页面可见文本示例：

```text
1.4万+ 300+
```

这两个数字分别对应点赞数和评论数，不是播放数。

SSR 脚本里的统计对象：

```json
{
  "aweme_id": "7639981756393854137",
  "comment_count": 395,
  "digg_count": 14333,
  "play_count": 0,
  "share_count": 8335,
  "collect_count": 1572
}
```

另外两个样本也验证过，移动分享页都是：

```text
play_count: 0
```

结论：移动分享页也没有真实播放数。

### 6. 旧 iteminfo 接口

入口：

```text
https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=<aweme_id>
https://www.douyin.com/web/api/v2/aweme/iteminfo/?item_ids=<aweme_id>
```

结果：

```json
{
  "status_code": 11110,
  "status_msg": "encrypt_data_miss"
}
```

结论：这个旧接口需要加密参数，不能直接用。

### 7. 直连 iesdouyin Web 接口

示例：

```text
https://www.iesdouyin.com/aweme/v1/web/aweme/detail/
https://www.iesdouyin.com/aweme/v1/web/aweme/post/
```

结果：

```text
403 blocked
```

结论：不能作为稳定数据源。

## 重要观察

1. 点赞、评论、分享、收藏数都能正常拿到，并且会随时间增长。
2. `play_count` 字段不是不存在，而是被服务端置为 `0`。
3. 手机分享页可见的 `1.4万+`、`300+` 等数字不是播放数，而是点赞/评论等互动数据。
4. `/video/<aweme_id>` 详情页在 Playwright 真实 Chrome 下可能关闭或替换当前 Page，不如 `jingxuan?modal_id=<aweme_id>` 稳定。
5. 公开 Web 接口和 SSR 数据都没有暴露真实播放数。

## 不建议重复投入的方向

以下方向已经验证过，除非抖音接口变动，否则短期内不建议重复实现：

- 从搜索接口 `statistics.play_count` 读取播放数。
- 从 Web 详情页 `aweme/detail` 读取播放数。
- 从作者主页作品列表 `aweme/post` 读取播放数。
- 从移动分享页 SSR 数据读取播放数。
- 把页面可见的点赞/评论数字误判为播放数。

## 可能继续尝试的方向

如果继续攻播放数，建议只考虑下面几类新数据源：

### A. 抖音 App 私有接口

可能性最高，但成本也最高。

难点：

- 需要 App 接口签名。
- 需要设备参数。
- 可能需要抓包、逆向、或复用已有签名服务。
- 风控和封禁风险明显高于 Web。

适合 Claude Code 继续研究的问题：

```text
有没有可复用的 Douyin/TikTok app signing 方案？
是否能在本地生成合法参数？
是否能只查询单个 aweme_id 的统计数据？
```

### B. 创作者后台数据

只适合拿自己账号作品的数据，不适合全网视频。

优点：

- 数据真实性较高。

限制：

- 一般只能访问当前登录账号自己的作品。
- 不适合这个项目当前的“搜索全网视频”目标。

### C. 第三方数据平台或榜单源

可能提供播放量或估算播放量。

限制：

- 准确性不一定可控。
- 可能收费。
- 可能需要账号/API Key。

### D. 特定场景页面

例如活动榜单、热门榜单、创作者服务页、任务平台页面。

需要验证：

- 页面是否显示播放量。
- 显示的是总播放、近 7 天播放，还是估算热度。
- 是否能和 `aweme_id` 稳定对应。

## 建议给 Claude Code 的任务说明

可以直接把下面这段发给 Claude Code：

```text
当前项目在 D:\data\accio\douyin_Playwright。

目标：继续研究抖音视频播放数 play_count 是否有可用数据源，但不要改主抓取流程，先做独立探测。

已有结论：
1. 搜索接口、Web 详情页、作者页作品列表、移动分享页都只返回 play_count=0。
2. 点赞、评论、分享、收藏都正常，只有播放数不给真实值。
3. src/playCountProbe.ts 已经实现了单视频探测入口。
4. 不要再重复测试 aweme/v1/web/aweme/detail、aweme/v1/web/aweme/post、移动分享页 SSR，除非你能证明请求参数或入口不同。

建议下一步：
1. 研究是否存在可行的 App 私有接口或签名方案。
2. 或找榜单/创作者/第三方数据源是否显示真实播放数。
3. 任何新方案先做单独脚本验证，输入 aweme_id，输出原始 JSON 和候选字段，不要接入主 Excel。

样本 aweme_id：
7639981756393854137
7639953654853782819
7641313236075253028
```

## 当前推荐决策

短期产品功能上，建议继续保留：

- 点赞数
- 评论数
- 收藏数
- 分享数
- 发布时间
- 作者
- 分享链接

暂时不要上线：

- 播放数

如果必须提供播放相关指标，可以考虑改名为：

```text
互动热度 = 点赞 + 评论 + 收藏 + 分享
```

但不要称为播放数。

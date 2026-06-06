# 个性化视觉审美管线 (visual-pipeline)

针对"VLM 客观过滤 + 图像 Embedding + 个性化分类器/排序器 + 主动学习 + 笔记级聚合"方案的实现。

本目录是独立的 Python ML 子系统，与主项目的 TS 抓取链路解耦，通过 xlsx/json 文件交换数据。

## 阶段一：最小验证（已完成）

目标：用 38 条人工标注，验证"图像 embedding + 个性化分类器"能否学到人工审美，
特别是能否把上一轮 VLM 漏判的 13 条审美不合适项分出来。这是 go/no-go 决策实验。

### 流程

```bash
# 1. 从标注 xlsx 提取数据集（图片 + 人工标签 + VLM 原判断）
python ml/extract_dataset.py [可选:xlsx路径]

# 2. 抽 CLIP 图像 embedding 并聚合到笔记级
python ml/embed_images.py

# 3. 留一法验证个性化分类器
python ml/validate.py
```

### 结论（2026-06-06）

| 指标 | 结果 |
|---|---|
| 样本 | 38 条（合适 21 / 不合适 17） |
| 特征 | open_clip ViT-B-32, 1024 维（mean+max 笔记级聚合） |
| LOO 准确率 | 0.816 |
| 合适项精确率 / 召回率 | 0.818 / 0.857 |
| **VLM 漏判挽救** | **10/13**（纯 VLM 基线为 0/13） |

**判读：方向成立。** 仅 38 条样本、最简单的逻辑回归，在留一法下就把 VLM 完全漏判的
13 条审美问题救回了 10 条。说明 CLIP embedding 确实编码到了人工在意的审美维度，
"个性化分类器"路线可行。剩余 3 条仍漏（row 4/27/31）是后续扩样本和换排序器要攻克的。

### 技术决策记录

- **embedding 用本地 open_clip 而非 DashScope API**：当前 `DASHSCOPE_BASE_URL` 是第三方
  Anthropic 兼容中转（mimo-v2.5），不提供 multimodal-embedding，故用本地 CLIP。
  这也正好是最终生产管线要用的同款特征。
- **图片来源用 xlsx 内嵌图片**：CDN 链接已 403 过期；通过解析 drawing1.xml 锚定关系
  精确还原每条笔记的图片。
- **笔记级聚合**：一条笔记多张图，取 mean + max 拼接（让分类器自学哪种有用）。

## 后续阶段（待办）

- [ ] 扩大标注量到几百条（分类器稳定起步线）
- [ ] 分类器 -> pairwise 排序器（标"A vs B"比打分更稳）
- [ ] 主动学习闭环：只挑模型最没把握的图给人标
- [ ] 笔记级聚合规则用数据校准（mean/max/topk 对比）
- [ ] 接入主 TS 管线：VLM 客观过滤后调用本子系统

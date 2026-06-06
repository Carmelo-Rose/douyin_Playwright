# 个性化视觉审美管线 (visual-pipeline)

针对"VLM 客观过滤 + 图像 Embedding + 个性化分类器 + 主动学习"方案的实现。

本目录是独立的 Python ML 子系统，与主项目的 TS 抓取链路解耦，通过 xlsx / 图片文件夹交换数据。

---

## 当前可用：单图审美分类器

判断单位是**单张图**，对齐用户"一张张挑图"的真实判断逻辑（一条笔记有 2-3 张合格图就保留）。

### 日常命令

```bash
# 1. 训练 / 重新训练（加了新标注数据后跑）
python ml/train_singleimage.py

# 2. 识图判断：对一个文件夹里所有图打分
python ml/predict.py --input "图片文件夹路径"

# 导出结果到 csv（按最像好图排序）
python ml/predict.py --input "图片文件夹路径" --csv result.csv

# 调严格度（默认 0.5，调高更挑）
python ml/predict.py --input "图片文件夹路径" --threshold 0.6

# 把图按判断结果分拣到 good/bad 子文件夹（方便肉眼复核）
python ml/predict.py --input "图片文件夹路径" --sort-to "输出文件夹"
```

- `predict.py` 输出：每张图 good/bad + P(good) 置信度，按置信度排序。
- `--threshold` 只改"判 good 的及格线"，不改打分本身；第一轮用默认 0.5 即可。
- `--sort-to`：把图**复制**（原图不动）到 `输出文件夹/good` 和 `输出文件夹/bad`，
  文件名加 P(good) 百分比前缀（如 `087_xxx.webp`），文件夹内按名称排序即可看最像/最不像。

### 从表格提取图片（待判断的新数据）

新数据在 xlsx 表格里时，先提取成图片文件夹再 predict：

```bash
python ml/extract_images_only.py --input "output/xxx.xlsx" --out ml/data/to_predict --max-notes 30 --imgs-per-note 2
```

---

## 数据组织

```
ml/data/labeled/
├── good/     # 符合的单张图（训练用）
└── bad/      # 不符合的单张图（训练用）
ml/data/to_predict/   # 待判断的新图（predict 用）
ml/model/
├── aesthetic_clf.joblib   # 训练好的模型
└── train_report.json      # 训练报告（含误判清单）
```

⚠️ `ml/data/labeled/` 是标注资产（260MB+），因体积大不入 git，请自行备份。

---

## 当前模型效果（2026-06-06）

| 指标 | 结果 |
|---|---|
| 样本 | 245 张单图（good 124 / bad 121） |
| 特征 | open_clip ViT-B-32, 512 维 |
| 5 折交叉验证准确率 | **0.82** |
| 精确率(good) / 召回率(good) | 0.812 / 0.839 |
| F1 | 0.825 |

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `clip_utils.py` | 共享 CLIP 特征模块（带内容哈希缓存） |
| `train_singleimage.py` | 单图训练 + 交叉验证 + 保存模型 |
| `predict.py` | 识图命令：文件夹/单图 → good/bad + 置信度 |
| `extract_images_only.py` | 从 xlsx 提取图片到文件夹（待判断新数据） |
| `extract_dataset.py` | （阶段一遗留）从标红 xlsx 提取笔记级数据集 |
| `embed_images.py` | （阶段一遗留）笔记级 embedding 聚合 |
| `validate.py` | （阶段一遗留）笔记级留一法验证 |

---

## 演进历史

- **阶段一（已废弃方向）**：笔记级标注（整条标红）。用 38 条做留一法验证，
  VLM 漏判的 13 条救回 10 条，证明"个性化分类器"方向成立。
  后发现用户真实判断是**单图级**（一张张挑），故转向单图方案。
- **当前**：单图级标注 + 分类器，245 张数据，交叉验证 0.82。

## 后续阶段（待办）

- [ ] 扩大标注量到 300+（模型更稳，攻克硬骨头）
- [ ] 让用户用新图实测体感，按误判针对性补标注
- [ ] 分类器 → pairwise 排序器（标"A vs B"比打分更稳）
- [ ] 主动学习闭环：只挑模型最没把握的图给人标
- [ ] 接入主 TS 管线 / 支持直接对表格识图并写回结果

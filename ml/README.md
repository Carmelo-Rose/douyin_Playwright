# 个性化视觉审美管线 (visual-pipeline)

针对"VLM 客观过滤 + 图像 Embedding + 个性化分类器 + 主动学习"方案的实现。

本目录是独立的 Python ML 子系统，与主项目的 TS 抓取链路解耦，通过 xlsx / 图片文件夹交换数据。
判断单位是**单张图**，对齐"一张张挑图"的判断逻辑（一条笔记有 2-3 张合格图就保留）。

---

## 快速开始（推荐：用 run.ps1，自动用对的 Python）

> ⚠️ 系统有多个 Python，直接敲 `python` 可能用到**没装依赖**的那个，会报 `ModuleNotFoundError`。
> `run.ps1` 会自动定位装好依赖的 Accio 内置 Python，**优先用它**。

在项目根目录 `D:\data\accio\douyin_Playwright` 下，PowerShell 运行：

```powershell
# 识图判断 + 分拣到 good/bad 文件夹（最常用）
.\ml\run.ps1 predict -Input "C:\...\待判断图片文件夹" -SortTo "C:\...\结果文件夹"

# 合并纠错数据进训练集
.\ml\run.ps1 merge -From "C:\...\结果文件夹"

# 重新训练
.\ml\run.ps1 train

# 从 xlsx 表格提取图片（待判断新数据）
.\ml\run.ps1 extract -Input "output\xxx.xlsx" -Out "ml\data\to_predict" -MaxNotes 30
```

可选参数：`-Threshold 0.6`（调严格度）、`-Csv result.csv`（导出csv）、`-ImgsPerNote 2`（每条笔记取前几张）。

---

## 完整工作流：主动学习闭环（越用越准）

```
1. 识图分拣   → 2. 你纠错   → 3. 合并   → 4. 重训   → 模型更像你 → 回到1
```

```powershell
# 1. 对新图判断并分拣
.\ml\run.ps1 predict -Input "新图文件夹" -SortTo "结果文件夹"

# 2. 你在 结果文件夹\good 和 结果文件夹\bad 里纠错
#    把判错的图剪切到正确的文件夹（判对的不动）

# 3. 合并纠错后的数据进训练集
.\ml\run.ps1 merge -From "结果文件夹"

# 4. 重新训练
.\ml\run.ps1 train
```

- 分拣后文件名带 P(good) 百分比前缀（如 `087_xxx.webp`），文件夹内按名称排序看最像/最不像。
- 边界图（前缀 40~60）模型最没把握，纠错收益最大；90+ 和 10- 通常没错可略过。
- `--sort-to` 是**复制**（原图不动），放心用。

---

## 直接用 python 跑（需自行确保用对 Python）

```bash
python ml/predict.py --input "图片文件夹" --sort-to "结果文件夹" [--threshold 0.6] [--csv out.csv]
python ml/merge_feedback.py --from "结果文件夹"
python ml/train_singleimage.py
python ml/extract_images_only.py --input "output/xxx.xlsx" --out ml/data/to_predict --max-notes 30
```

---

## 数据组织

```
ml/data/labeled/
├── good/     # 符合的单张图（训练用）
└── bad/      # 不符合的单张图（训练用）
ml/model/
├── aesthetic_clf.joblib   # 训练好的模型
└── train_report.json      # 训练报告（含误判清单）
```

⚠️ `ml/data/labeled/` 是标注资产（数百 MB），因体积大不入 git，请自行备份。

---

## 当前模型效果

| 版本 | 样本 | 交叉验证准确率 | 精确率(good) | 召回率(good) |
|---|---|---|---|---|
| 第一版 | 245（good124/bad121） | 0.82 | 0.812 | 0.839 |
| **第二版** | **1005（good266/bad739）** | **0.894** | 0.787 | 0.82 |

特征：open_clip ViT-B-32, 512 维。第二版经过一轮主动学习闭环（纠错89张误判后重训）。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `run.ps1` | PowerShell 启动脚本（自动用对的 Python） |
| `clip_utils.py` | 共享 CLIP 特征模块（带内容哈希缓存） |
| `train_singleimage.py` | 单图训练 + 交叉验证 + 保存模型 |
| `predict.py` | 识图命令：文件夹/单图 → good/bad + 置信度 + 分拣 |
| `merge_feedback.py` | 把纠错后的结果合并进训练集 |
| `extract_images_only.py` | 从 xlsx 提取图片到文件夹（待判断新数据） |
| `extract_dataset.py` `embed_images.py` `validate.py` | （阶段一遗留）笔记级方案，已不用 |

---

## 演进历史

- **阶段一（已废弃方向）**：笔记级标注（整条标红）。38 条留一法验证，VLM 漏判 13 条救回 10 条，
  证明"个性化分类器"方向成立。后发现真实判断是**单图级**，转向单图方案。
- **第一版**：单图 245 张，交叉验证 0.82。
- **第二版**：跑通主动学习闭环，1005 张，准确率 0.894。

## 后续阶段（待办）

- [ ] 继续转闭环，每轮纠错提升精度
- [ ] 数据再平衡（当前 good:bad ≈ 1:2.8，可多补 good）
- [ ] 分类器 → pairwise 排序器（标"A vs B"比打分更稳）
- [ ] 接入主 TS 管线 / 支持直接对表格识图并写回结果

# 个性化视觉审美管线 (visual-pipeline)

针对"VLM 客观过滤 + 图像 Embedding + 个性化分类器 + 主动学习"方案的实现。

本目录是独立的 Python ML 子系统，与主项目的 TS 抓取链路解耦，通过 xlsx / 图片文件夹交换数据。
判断单位是**单张图**，对齐"一张张挑图"的判断逻辑（一条笔记有 2-3 张合格图就保留）。

> 💡 这套管线既能用本文档的命令行操作，也能在 Electron 桌面应用的「ML 工作台」里图形化跑完整闭环（识图 → 纠错 → 合并 → 重训），见根目录 [README.md](../README.md#ml-工作台桌面应用)。GUI 的纠错区支持 hover 移动 / 放大 / 可撤销删除，命令行则靠手动剪切文件，两者最终都落到 `ml/data/labeled/`。

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

| 版本 | backbone（维度） | 样本(去重后) | 随机CV acc | 分组CV acc（真实） | 精确率(good) | 召回率(good) | F1 |
|---|---|---|---|---|---|---|---|
| 第一版 | ViT-B-32（512） | 245（good124/bad121） | 0.82 | — | 0.812 | 0.839 | — |
| 第二版 | ViT-B-32（512） | 1005（good266/bad739） | 0.894 | — | 0.787 | 0.820 | — |
| 第三版 | ViT-B-32（512） | 1924→1910（good401/bad1509） | 0.945 | 0.944 | 0.852 | 0.888 | 0.869 |
| **第四版** | **ViT-B-32 / clip-b32（512）** | **2729→2703（good809/bad1894）** | **0.851** | **0.850** | **0.736** | **0.779** | **0.757** |

- **第四版 backbone = clip-b32**，这是经**同口径消融**后的定论（不是因为 SigLIP2 差，而是打平时选更快、维度更小、与第三版历史可比的）。详见 [`backbone_compare.md`](backbone_compare.md)。
- 消融结论（1756 张同样本、`--no-dedup` 同口径、GroupKFold）：
  - **SigLIP2-L vs ViT-B-32 实质打平**：0.836 vs 0.831，差 0.005 在噪声范围内。之前"SigLIP2 掉 3 点"是旧数据 dedup 删除数不同造成的假象。
  - **美学分（aes-laion）无有效增量**：单独 0.690 有信号，但拼进 clip-b32 仅 +0.003、FP 没降，已放弃接入（信号被 CLIP 特征冗余覆盖）。
- 第四版线上模型（开 dedup 重训，截至 2026-06-08 持续闭环到 2703 张）混淆矩阵：TP=630 TN=1668 FP=226 FN=179，误判 405 张。随机CV(0.851)≈分组CV(0.850)，无泄漏，数字真实。
- 第三/四版换数据集后分数不可直接横比；当前 good:bad ≈ 1:2.3。**注意：FP 绝对数随数据集增大会自然上升，压 FP 看的是精确率**——经多轮补难负样本闭环，精确率已从 0.724（1753 张时）升到 **0.736（2703 张时）**，召回率同步 0.751→0.779，方向正确。下一步重心仍是**持续补难负样本压 FP**，而非继续调 backbone。
- ⚠️ backbone 必须与已训练模型一致（维度 + 特征空间），否则识图结果会错。当前模型记录的 backbone 写在 `ml/model/train_report.json` 的 `backbone` 字段，GUI「① 运行环境」会自动校验。

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
- **第三版**：第二轮闭环，合并919张纠错标注，1924张（去重后1910），分组CV准确率 **0.944**，F1=0.869。同步修复 GroupKFold generator 二次耗尽 bug 及 extract_images_only 列号自动检测。
- **第四版**：继续闭环到 1756 张（good582/bad1174，比例改善到 ~1:2），并做了一轮**同口径 backbone/美学分消融**：SigLIP2-L 与 ViT-B-32 实质打平、美学分无增量，最终**定 backbone = clip-b32**（求速度+历史可比）。开 dedup 正式重训分组CV 0.823，F1=0.737。同期把整套闭环搬进 Electron「ML 工作台」GUI（识图 / 纠错 / 合并 / 重训一键完成），纠错区支持 hover 移动·放大·可撤销删除。backbone 选型自此收尾，重心转向补难负样本压 FP。
  - **2026-06-08 续跑闭环**：又补了两批棒球帽/帽子新图（识图→纠错→merge→重训），数据集长到 **2703 张（good809/bad1894 ≈ 1:2.3）**，分组CV **0.850**、精确率 0.736、召回率 0.779、F1 0.757。验证了"压 FP 要靠足量补难负样本"——小批（108 张）无变化，大批（~950 张）精确率与召回率同步抬升。另外 pairwise 试水（`train_pairwise.py`）确认：在现有 good/bad 上换排序范式仅 +0.005，暂不切换。

## 后续阶段（待办）

- [ ] **【当前重心】补难负样本压 FP**：精确率已从 0.724 升到 0.736（2703 张），仍偏低（模型说 good 的约 1/4 实为 bad），继续针对性补"看着像 good 但其实 bad"的图，靠闭环纠错收紧边界
- [ ] 继续转闭环，每轮纠错提升精度
- [ ] 分类器 → pairwise 排序器（标"A vs B"比打分更稳）
- [ ] 接入主 TS 管线 / 支持直接对表格识图并写回结果
- [x] ~~backbone 选型~~：经同口径消融定 clip-b32，SigLIP2 打平、美学分无增量，已收尾（见 backbone_compare.md）

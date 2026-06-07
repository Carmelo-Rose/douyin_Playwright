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
| **第四版** | **clip-b32（512）** | 1756（good582/bad1174） | 0.824 | **0.831** | 0.734 | 0.771 | 0.752 |

> 第四版上表为 **消融(no-dedup)口径**；**开 dedup 正式重训后请用 `train_report.json` 的真实数字更新本行**。

- **第四版 backbone 经同口径消融选定 `clip-b32`**（详见 `ml/backbone_compare.md`）。在当前 1756 样本、`--no-dedup` 同口径下对比四个配置：
  - `siglip2-l`(0.836) 与 `clip-b32`(0.831) **实质打平**（差 0.005，在噪声范围内）；之前 1924 旧数据上 SigLIP2 "掉 3 个点" 是**数据集差异造成的假象**，同口径下两者等价。
  - 美学分(`clip-b32+aes-laion`) 增量仅 **+0.003** 且未降 FP，**不值得加**（LAION 通用美学与"个人口味"相关性低，且画质信号已被 CLIP 隐含）。
  - 综合选 **clip-b32**：与 SigLIP2 准确率等价，但维度小一半、冷启动快得多。
- 注：换 backbone 后特征空间不同，各版本分数不可直接横比；第四版 good:bad ≈ 1:2，**FP 偏多（精确率 0.73），下一步重心是补"难负样本"（看着行但其实不合格）压 FP，而非纠结 backbone**。
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
- **第四版**：换 backbone 到 **SigLIP2-L（1024 维）** 并继续闭环，1756 张（去重后1728，good567/bad1161），分组CV准确率 **0.838**，F1=0.760。同期把整套闭环搬进 Electron「ML 工作台」GUI（识图 / 纠错 / 合并 / 重训一键完成），纠错区支持 hover 移动·放大·可撤销删除。

## 后续阶段（待办）

- [ ] 继续转闭环，每轮纠错提升精度
- [ ] 数据再平衡（第四版 good:bad ≈ 1:2，FP 偏多，可多补难负样本/good）
- [ ] 分类器 → pairwise 排序器（标"A vs B"比打分更稳）
- [ ] 接入主 TS 管线 / 支持直接对表格识图并写回结果

"""
最小验证实验：用 38 条标注的图像 embedding，验证"个性化分类器"能否
学到人工审美，特别是能否把上次 VLM 漏判的 13 条审美不合适项分出来。

实验设计（38 条样本极少，用留一法 LOO 交叉验证求稳）：
1. Logistic Regression on CLIP embedding，留一法评估整体准确率/精确率/召回率。
2. 重点关注"VLM 漏判项"：模型判合格(是) 但人工标红(label=0) 的那批，
   看个性化分类器在 LOO 下能把多少个正确预测为"不合适"。
3. 与纯 VLM 基线对比：VLM 把这些全判成了合格(全错)。

结论判读：
- 如果分类器在 LOO 下能救回相当一部分漏判 -> embedding 编码到了审美信息，方向成立。
- 如果几乎救不回 -> CLIP embedding 没编码到你在意的审美维度，需考虑 VLM 微调(方案3)。
"""
import json
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import LeaveOneOut
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "ml" / "data"

YES = "\u662f"  # 视觉合格="是"


def main():
    data = np.load(DATA_DIR / "embeddings.npz", allow_pickle=True)
    X, y = data["X"], data["y"]
    rows = data["rows"]
    titles = data["titles"]
    model_qual = data["model_qualified"]
    n = len(y)
    print(f"[info] samples={n} pos(合适)={int((y==1).sum())} neg(不合适)={int((y==0).sum())} dim={X.shape[1]}")

    # VLM 漏判项：模型判"是"但人工 label=0
    vlm_miss_idx = [i for i in range(n) if str(model_qual[i]) == YES and y[i] == 0]
    print(f"[info] VLM 漏判项(模型判合格但人工标红)={len(vlm_miss_idx)} 条")
    print(f"       纯VLM基线：这 {len(vlm_miss_idx)} 条全部判错(都当成了合格)\n")

    # 留一法交叉验证
    loo = LeaveOneOut()
    preds = np.zeros(n, dtype=int)
    probs = np.zeros(n, dtype=float)
    for train_idx, test_idx in loo.split(X):
        scaler = StandardScaler().fit(X[train_idx])
        Xtr = scaler.transform(X[train_idx])
        Xte = scaler.transform(X[test_idx])
        clf = LogisticRegression(max_iter=2000, C=1.0, class_weight="balanced")
        clf.fit(Xtr, y[train_idx])
        preds[test_idx] = clf.predict(Xte)
        probs[test_idx] = clf.predict_proba(Xte)[:, 1]  # P(合适)

    tp = int(((preds == 1) & (y == 1)).sum())
    tn = int(((preds == 0) & (y == 0)).sum())
    fp = int(((preds == 1) & (y == 0)).sum())
    fn = int(((preds == 0) & (y == 1)).sum())
    acc = (tp + tn) / n
    prec = tp / (tp + fp) if (tp + fp) else 0
    rec = tp / (tp + fn) if (tp + fn) else 0
    print("=== 个性化分类器 LOO 整体表现 ===")
    print(f"准确率 acc={acc:.3f}  精确率(合适)={prec:.3f}  召回率(合适)={rec:.3f}")
    print(f"混淆: TP={tp} TN={tn} FP={fp} FN={fn}\n")

    # 核心：VLM 漏判项里，分类器救回了几个
    saved = [i for i in vlm_miss_idx if preds[i] == 0]
    print("=== 核心结论：VLM 漏判项的挽救情况 ===")
    print(f"分类器正确判为'不合适'的漏判项：{len(saved)}/{len(vlm_miss_idx)}")
    for i in vlm_miss_idx:
        mark = "✓救回" if preds[i] == 0 else "✗仍漏"
        print(f"  row={rows[i]:>2} {mark} P(合适)={probs[i]:.2f} | {titles[i][:22]}")

    # 写结论文件
    result = {
        "samples": n,
        "pos": int((y == 1).sum()),
        "neg": int((y == 0).sum()),
        "loo_acc": round(acc, 3),
        "loo_precision_pos": round(prec, 3),
        "loo_recall_pos": round(rec, 3),
        "confusion": {"TP": tp, "TN": tn, "FP": fp, "FN": fn},
        "vlm_miss_total": len(vlm_miss_idx),
        "vlm_miss_saved": len(saved),
        "saved_rows": [int(rows[i]) for i in saved],
    }
    out = DATA_DIR / "validation_result.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[done] result -> {out}")


if __name__ == "__main__":
    main()

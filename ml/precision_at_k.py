"""部署口径评估：在分组 CV 的 out-of-fold 概率上，算 0.75 阈值精确率与 Precision@K。

对齐线上用法（按分数排序取头部 / 用 0.75 阈值过滤），而不是 0.5 准确率。
特征复用 ml/cache 缓存，秒级。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict

from train_singleimage import (
    build_features,
    collect_samples,
    dedup_near_duplicates,
    make_model,
)


def main():
    samples = collect_samples()
    X, y, paths, groups = build_features(samples)
    X, y, paths, groups, _ = dedup_near_duplicates(X, y, paths, groups)

    sgkf = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=42)
    splits = list(sgkf.split(X, y, groups))
    probs = cross_val_predict(make_model(), X, y, cv=splits, method="predict_proba")[:, 1]

    order = np.argsort(-probs)  # 分数从高到低
    y_sorted = y[order]
    print(f"[info] 去重后样本 {len(y)}  good={int(y.sum())} bad={int((y==0).sum())}\n")

    print("=== Precision@K（头部 K 张里真 good 的占比，对齐'取头部'用法）===")
    for k in (50, 100, 200, 300, 500):
        if k > len(y):
            break
        p = y_sorted[:k].mean()
        print(f"  P@{k:<4d} = {p:.3f}  ({int(y_sorted[:k].sum())}/{k})")

    print("\n=== 阈值口径（对齐线上 0.75 过滤）===")
    for thr in (0.5, 0.6, 0.7, 0.75, 0.8):
        sel = probs >= thr
        n_sel = int(sel.sum())
        if n_sel == 0:
            print(f"  thr={thr}: 选中0张"); continue
        prec = y[sel].mean()
        rec = y[sel].sum() / y.sum()
        print(f"  thr={thr}: 选中{n_sel:4d}张  精确率={prec:.3f}  召回={rec:.3f}")


if __name__ == "__main__":
    main()

"""
零成本 pairwise 基线验证(第 4 步试水)。

用现有 good/bad 自动构造偏好对(每个 good 优于每个 bad),训一个线性 pairwise 打分器,
对比二分类基线的排序质量(AUC)。回答:换 pairwise 范式在当前数据上比二分类强多少。
**不动主流程 / 线上模型,纯独立实验。**

范式:Bradley-Terry 线性版。对每个偏好对 (g=good, b=bad),特征差 d=x_g-x_b,
学 P(g>b)=sigmoid(w·d);对称加入 (d,1) 和 (-d,0),无截距 LR。打分 s(x)=w·x,按分排序。

评估:ROC-AUC ≡ pairwise accuracy(随机 good 分 > 随机 bad 分的概率),与二分类基线直接可比。
防泄漏:按笔记(note_group_key)做 StratifiedGroupKFold,同笔记同 fold,构对只在 fold 内。

跑法(Windows,clip-b32 缓存已存在,秒级):
  $env:EMBED_BACKBONE = "clip-b32"; python ml\train_pairwise.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.preprocessing import StandardScaler

from clip_utils import feature_tag
from train_singleimage import build_features, collect_samples, make_model

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "ml" / "model"
RNG = np.random.default_rng(42)
PAIRS_PER_GOOD = 8            # 每个 good 随机配几个 bad
MAX_PAIRS_PER_FOLD = 30000   # 每 fold 偏好对上限(对称前),防爆内存


def build_pairs(Xs, y, max_pairs):
    """在(已 scaler 的)特征上构偏好对,返回特征差矩阵 D（label 恒为 g>b）。
    每个 good 随机配 PAIRS_PER_GOOD 个 bad。"""
    good_idx = np.where(y == 1)[0]
    bad_idx = np.where(y == 0)[0]
    if len(good_idx) == 0 or len(bad_idx) == 0:
        return np.zeros((0, Xs.shape[1]), dtype=np.float32)
    diffs = []
    k = min(PAIRS_PER_GOOD, len(bad_idx))
    for gi in good_idx:
        for bi in RNG.choice(bad_idx, size=k, replace=False):
            diffs.append(Xs[gi] - Xs[bi])
    D = np.asarray(diffs, dtype=np.float32)
    if len(D) > max_pairs:
        D = D[RNG.choice(len(D), size=max_pairs, replace=False)]
    return D


def fit_pairwise(D):
    """对称构造 (D,1)+(-D,0),无截距 LR 学打分权重 w。"""
    X_pair = np.vstack([D, -D])
    y_pair = np.concatenate([np.ones(len(D)), np.zeros(len(D))])
    lr = LogisticRegression(max_iter=2000, C=1.0, fit_intercept=False)
    lr.fit(X_pair, y_pair)
    return lr.coef_.ravel()


def main():
    samples = collect_samples()
    n_good = sum(1 for _, l in samples if l == 1)
    n_bad = len(samples) - n_good
    print(f"[info] backbone={feature_tag()} samples={len(samples)} good={n_good} bad={n_bad}")
    if n_good < 5 or n_bad < 5:
        print("[err] good/bad 太少")
        return

    print("[info] building features (CLIP embedding, 走现有缓存)...")
    X, y, paths, groups = build_features(samples)
    n_groups = len(set(groups.tolist()))
    n_splits = min(5, n_groups)
    print(f"[info] X={X.shape} groups={n_groups} -> {n_splits}-fold StratifiedGroupKFold")

    sgkf = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=42)
    pw_aucs, clf_aucs = [], []
    for fold, (tr, va) in enumerate(sgkf.split(X, y, groups), 1):
        ytr, yva = y[tr], y[va]
        if len(np.unique(yva)) < 2:
            print(f"  [fold {fold}] val 缺类,跳过")
            continue

        # --- pairwise 打分器:scaler 只在 train 上 fit,再构对 ---
        scaler = StandardScaler().fit(X[tr])
        Xtr_s, Xva_s = scaler.transform(X[tr]), scaler.transform(X[va])
        D = build_pairs(Xtr_s, ytr, MAX_PAIRS_PER_FOLD)
        w = fit_pairwise(D)
        s_va = Xva_s @ w                      # 每张 val 图的偏好分
        pw_auc = roc_auc_score(yva, s_va)

        # --- 二分类基线(同 fold,make_model 自带 scaler,用原始 X)---
        clf = make_model()
        clf.fit(X[tr], ytr)
        proba = clf.predict_proba(X[va])[:, 1]
        clf_auc = roc_auc_score(yva, proba)

        pw_aucs.append(pw_auc)
        clf_aucs.append(clf_auc)
        print(f"  [fold {fold}] pairs={len(D)} pairwise_AUC={pw_auc:.3f}  二分类_AUC={clf_auc:.3f}")

    if not pw_aucs:
        print("[err] 没有有效 fold")
        return

    pw_mean, clf_mean = float(np.mean(pw_aucs)), float(np.mean(clf_aucs))
    delta = pw_mean - clf_mean
    print("\n=== pairwise 基线 vs 二分类(AUC ≡ pairwise accuracy)===")
    print(f"pairwise 平均 AUC = {pw_mean:.3f}")
    print(f"二分类  平均 AUC = {clf_mean:.3f}")
    print(f"差值(pairwise - 二分类) = {delta:+.3f}")
    if delta >= 0.02:
        verdict = "pairwise 明显更强 → 第4步有肉,值得投入成对标注精修"
    elif delta <= -0.02:
        verdict = "pairwise 反而更差 → 当前数据下别转,继续二分类补数据"
    else:
        verdict = "基本持平 → 换范式本身在 good/bad 上不涨;增量得靠新的成对标注信息(笔记内排序/程度)"
    print(f">>> 判读:{verdict}")

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    report = {
        "backbone": feature_tag(),
        "n_samples": len(samples),
        "n_good": n_good,
        "n_bad": n_bad,
        "n_groups": n_groups,
        "n_splits": n_splits,
        "pairs_per_good": PAIRS_PER_GOOD,
        "pairwise_auc_folds": [round(a, 4) for a in pw_aucs],
        "clf_auc_folds": [round(a, 4) for a in clf_aucs],
        "pairwise_auc_mean": round(pw_mean, 4),
        "clf_auc_mean": round(clf_mean, 4),
        "delta": round(delta, 4),
        "verdict": verdict,
    }
    out = MODEL_DIR / "pairwise_report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[done] report -> {out}")


if __name__ == "__main__":
    main()

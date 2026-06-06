"""
单图审美分类器训练。

数据：ml/data/labeled/good (符合) + ml/data/labeled/bad (不符合)，单图级标签。
对齐用户判断逻辑：用户一张张挑图，单图是判断的原子单位。

流程：
1. 收集 good/bad 全部图片路径
2. 抽 CLIP embedding（带缓存：图片内容哈希 -> 特征，避免重复抽取）
3. 交叉验证评估（StratifiedKFold）
4. 用全部数据训练最终模型并保存

产物：
- ml/cache/embed_cache.npz   特征缓存
- ml/model/aesthetic_clf.joblib   训练好的模型（含 scaler + 分类器）
- ml/model/train_report.json      训练报告
"""
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import (
    StratifiedGroupKFold,
    StratifiedKFold,
    cross_val_predict,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from clip_utils import embed_image

ROOT = Path(__file__).resolve().parent.parent
LABELED_DIR = ROOT / "ml" / "data" / "labeled"
CACHE_PATH = ROOT / "ml" / "cache" / "embed_cache.npz"
MODEL_DIR = ROOT / "ml" / "model"
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
DEDUP_COSINE = 0.95  # 同组内特征余弦 >= 此值视为近似重复图

# 文件名形如：{标题}_{序号}_{博主}_来自小红书网页版.jpg
# 同一笔记 = 标题 + 博主 相同，仅中间序号不同。
_NOTE_RE = re.compile(r"^(?P<title>.+?)_(?P<idx>\d+)_(?P<author>.+?)_来自小红书")


def note_group_key(path: Path) -> str:
    """从文件名提取笔记分组键（标题+博主）。

    无法解析的文件名退化为自身 stem（视为独立组），保证不会误把
    不相干的图归到一起。这样 StratifiedGroupKFold 至少不会比随机切分更差。
    """
    m = _NOTE_RE.match(path.name)
    if m:
        return f"{m.group('title')}|{m.group('author')}"
    return path.stem  # 退化：每张独立成组


def collect_samples():
    samples = []  # (path, label) label: 1=good, 0=bad
    for label, sub in [(1, "good"), (0, "bad")]:
        d = LABELED_DIR / sub
        if not d.exists():
            continue
        for p in sorted(d.iterdir()):
            if p.suffix.lower() in EXTS:
                samples.append((p, label))
    return samples


def file_key(path: Path) -> str:
    """用文件内容哈希做缓存键，文件改名不影响缓存命中。"""
    h = hashlib.md5()
    h.update(path.read_bytes())
    return h.hexdigest()


def load_cache():
    if CACHE_PATH.exists():
        data = np.load(CACHE_PATH, allow_pickle=True)
        return dict(zip(data["keys"].tolist(), data["vecs"]))
    return {}


def save_cache(cache: dict):
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    keys = np.array(list(cache.keys()), dtype=object)
    vecs = np.stack(list(cache.values()), axis=0) if cache else np.zeros((0, 512))
    np.savez(CACHE_PATH, keys=keys, vecs=vecs)


def build_features(samples):
    cache = load_cache()
    X, y, paths, groups = [], [], [], []
    new = 0
    for i, (path, label) in enumerate(samples, 1):
        key = file_key(path)
        if key in cache:
            vec = cache[key]
        else:
            vec = embed_image(path)
            cache[key] = vec
            new += 1
        X.append(vec)
        y.append(label)
        paths.append(str(path.relative_to(ROOT)))
        groups.append(note_group_key(path))
        if i % 25 == 0 or i == len(samples):
            print(f"  [feat] {i}/{len(samples)} (new embedded: {new})")
    save_cache(cache)
    return np.stack(X), np.array(y), paths, np.array(groups)


def dedup_near_duplicates(X, y, paths, groups, cos_thr=DEDUP_COSINE):
    """同一笔记组内做近似图去重：余弦 >= 阈值的只保留一张。

    特征已 L2 归一化（见 clip_utils.embed_image），点积即余弦。
    仅在组内比较，避免跨笔记误删；保留遇到的第一张。
    返回去重后的 (X, y, paths, groups) 与被删数量。
    """
    keep = np.ones(len(y), dtype=bool)
    by_group = defaultdict(list)
    for idx, g in enumerate(groups):
        by_group[g].append(idx)

    for g, idxs in by_group.items():
        if len(idxs) < 2:
            continue
        kept_idxs = []
        for idx in idxs:
            v = X[idx]
            is_dup = False
            for kj in kept_idxs:
                if float(np.dot(v, X[kj])) >= cos_thr:
                    is_dup = True
                    break
            if is_dup:
                keep[idx] = False
            else:
                kept_idxs.append(idx)

    removed = int((~keep).sum())
    Xd = X[keep]
    yd = y[keep]
    pd = [p for p, k in zip(paths, keep) if k]
    gd = groups[keep]
    return Xd, yd, pd, gd, removed


def cv_metrics(model_factory, X, y, cv_iter):
    """跑一次交叉验证，返回 (preds, probs, 指标 dict)。"""
    preds = cross_val_predict(model_factory(), X, y, cv=cv_iter)
    probs = cross_val_predict(
        model_factory(), X, y, cv=cv_iter, method="predict_proba"
    )[:, 1]
    tp = int(((preds == 1) & (y == 1)).sum())
    tn = int(((preds == 0) & (y == 0)).sum())
    fp = int(((preds == 1) & (y == 0)).sum())
    fn = int(((preds == 0) & (y == 1)).sum())
    acc = (tp + tn) / len(y)
    prec = tp / (tp + fp) if (tp + fp) else 0
    rec = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0
    m = {
        "acc": acc, "prec": prec, "rec": rec, "f1": f1,
        "TP": tp, "TN": tn, "FP": fp, "FN": fn,
    }
    return preds, probs, m


def make_model():
    return Pipeline([
        ("scaler", StandardScaler()),
        ("clf", LogisticRegression(max_iter=2000, C=1.0, class_weight="balanced")),
    ])


def main():
    samples = collect_samples()
    n_good = sum(1 for _, l in samples if l == 1)
    n_bad = len(samples) - n_good
    print(f"[info] samples={len(samples)} good={n_good} bad={n_bad}")
    if len(samples) < 10:
        print("[err] too few samples")
        return

    print("[info] building features (CLIP embedding)...")
    X, y, paths, groups = build_features(samples)
    print(f"[info] X={X.shape}  unique_groups={len(set(groups.tolist()))}")

    # ---- 近似图去重（同笔记组内，余弦 >= 0.95 视为重复）----
    Xd, yd, paths_d, groups_d, removed = dedup_near_duplicates(X, y, paths, groups)
    n_groups_d = len(set(groups_d.tolist()))
    print(
        f"[info] dedup: 删除近似重复 {removed} 张 -> 剩 {len(yd)} 张, "
        f"good={int((yd==1).sum())} bad={int((yd==0).sum())}, groups={n_groups_d}"
    )

    # ---- 对照1：旧的随机 StratifiedKFold（会泄漏 -> 虚高基线）----
    # 在「未去重」数据上跑，复现 README 里 0.894 的口径，便于对比。
    print("\n[info] [对照] 随机 StratifiedKFold（含泄漏，虚高基线）...")
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    _, _, m_leak = cv_metrics(make_model, X, y, skf)
    print(
        f"  虚高: acc={m_leak['acc']:.3f} prec={m_leak['prec']:.3f} "
        f"rec={m_leak['rec']:.3f} f1={m_leak['f1']:.3f}"
    )

    # ---- 真实基线：StratifiedGroupKFold（按笔记分组 + 类别分层，去重后数据）----
    # n_splits 不能超过组数；同时确保每折都能切分。
    n_splits = min(5, n_groups_d)
    if n_splits < 2:
        print("[warn] 分组数过少，StratifiedGroupKFold 退化，请检查文件名解析")
        n_splits = 2
    print(
        f"\n[info] [真实] StratifiedGroupKFold（按笔记分组+分层, "
        f"{n_splits}-fold, 去重后）..."
    )
    gkf = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=42)
    preds, probs, m_real = cv_metrics(
        make_model, Xd, yd, gkf.split(Xd, yd, groups_d)
    )

    print("\n=== 单图分类器交叉验证（真实基线 / StratifiedGroupKFold）===")
    print(
        f"准确率={m_real['acc']:.3f}  精确率(good)={m_real['prec']:.3f}  "
        f"召回率(good)={m_real['rec']:.3f}  F1={m_real['f1']:.3f}"
    )
    print(
        f"混淆: TP={m_real['TP']} TN={m_real['TN']} "
        f"FP={m_real['FP']} FN={m_real['FN']}"
    )
    print(
        f"\n>>> 对比: 随机CV acc={m_leak['acc']:.3f} (虚高)  →  "
        f"分组CV acc={m_real['acc']:.3f} (真实)  "
        f"差值={m_leak['acc']-m_real['acc']:+.3f}"
    )

    # 误判清单（基于真实基线 StratifiedGroupKFold，去重后样本）
    errors = []
    for i in range(len(yd)):
        if preds[i] != yd[i]:
            errors.append({
                "path": paths_d[i],
                "true": "good" if yd[i] == 1 else "bad",
                "pred": "good" if preds[i] == 1 else "bad",
                "prob_good": round(float(probs[i]), 3),
            })

    # 用去重后的全部数据训练最终模型（去掉冗余近似图，泛化更稳）
    print("\n[info] training final model on dedup data...")
    final = make_model()
    final.fit(Xd, yd)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    import joblib
    model_path = MODEL_DIR / "aesthetic_clf.joblib"
    joblib.dump(final, model_path)
    print(f"[done] model saved -> {model_path}")

    report = {
        "samples_raw": len(samples),
        "samples_dedup": int(len(yd)),
        "removed_near_duplicates": removed,
        "good_raw": n_good,
        "bad_raw": n_bad,
        "good_dedup": int((yd == 1).sum()),
        "bad_dedup": int((yd == 0).sum()),
        "n_note_groups": n_groups_d,
        "feature_dim": int(X.shape[1]),
        "cv_random_leak_acc": round(m_leak["acc"], 3),
        "cv_groupkfold_acc": round(m_real["acc"], 3),
        "cv_acc": round(m_real["acc"], 3),
        "cv_precision_good": round(m_real["prec"], 3),
        "cv_recall_good": round(m_real["rec"], 3),
        "cv_f1": round(m_real["f1"], 3),
        "confusion": {
            "TP": m_real["TP"], "TN": m_real["TN"],
            "FP": m_real["FP"], "FN": m_real["FN"],
        },
        "n_errors": len(errors),
        "errors": errors,
    }
    report_path = MODEL_DIR / "train_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[done] report saved -> {report_path}  (误判 {len(errors)} 张)")


if __name__ == "__main__":
    main()

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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from clip_utils import embed_image

ROOT = Path(__file__).resolve().parent.parent
LABELED_DIR = ROOT / "ml" / "data" / "labeled"
CACHE_PATH = ROOT / "ml" / "cache" / "embed_cache.npz"
MODEL_DIR = ROOT / "ml" / "model"
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


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
    X, y, paths = [], [], []
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
        if i % 25 == 0 or i == len(samples):
            print(f"  [feat] {i}/{len(samples)} (new embedded: {new})")
    save_cache(cache)
    return np.stack(X), np.array(y), paths


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
    X, y, paths = build_features(samples)
    print(f"[info] X={X.shape}")

    # 交叉验证
    print("[info] cross-validation (5-fold)...")
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    preds = cross_val_predict(make_model(), X, y, cv=skf)
    probs = cross_val_predict(make_model(), X, y, cv=skf, method="predict_proba")[:, 1]

    tp = int(((preds == 1) & (y == 1)).sum())
    tn = int(((preds == 0) & (y == 0)).sum())
    fp = int(((preds == 1) & (y == 0)).sum())
    fn = int(((preds == 0) & (y == 1)).sum())
    acc = (tp + tn) / len(y)
    prec = tp / (tp + fp) if (tp + fp) else 0
    rec = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0
    print("\n=== 单图分类器交叉验证 ===")
    print(f"准确率={acc:.3f}  精确率(good)={prec:.3f}  召回率(good)={rec:.3f}  F1={f1:.3f}")
    print(f"混淆: TP={tp} TN={tn} FP={fp} FN={fn}")

    # 误判清单（供人工复盘）
    errors = []
    for i in range(len(y)):
        if preds[i] != y[i]:
            errors.append({
                "path": paths[i],
                "true": "good" if y[i] == 1 else "bad",
                "pred": "good" if preds[i] == 1 else "bad",
                "prob_good": round(float(probs[i]), 3),
            })

    # 用全部数据训练最终模型
    print("\n[info] training final model on all data...")
    final = make_model()
    final.fit(X, y)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    import joblib
    model_path = MODEL_DIR / "aesthetic_clf.joblib"
    joblib.dump(final, model_path)
    print(f"[done] model saved -> {model_path}")

    report = {
        "samples": len(samples),
        "good": n_good,
        "bad": n_bad,
        "feature_dim": int(X.shape[1]),
        "cv_acc": round(acc, 3),
        "cv_precision_good": round(prec, 3),
        "cv_recall_good": round(rec, 3),
        "cv_f1": round(f1, 3),
        "confusion": {"TP": tp, "TN": tn, "FP": fp, "FN": fn},
        "n_errors": len(errors),
        "errors": errors,
    }
    report_path = MODEL_DIR / "train_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[done] report saved -> {report_path}  (误判 {len(errors)} 张)")


if __name__ == "__main__":
    main()

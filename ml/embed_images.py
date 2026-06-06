"""
对 ml/data/images 下的图片抽取 CLIP 图像 embedding，并聚合到笔记级。

策略：
- 用 open_clip 的 ViT-B-32 (CPU)，离线可复用，是最终生产管线的同款特征。
- 每条笔记有多张图 -> 抽每张图的 embedding，再做笔记级聚合（默认 mean + max 拼接）。
- 输出 ml/data/embeddings.npz: X (note特征矩阵), y (标签), rows, titles, model_qualified

笔记级聚合是本项目特有问题：一条笔记多张图，需要把多张图特征合成一条。
这里同时保留 mean 和 max 两种聚合，拼成一个向量，让分类器自己学哪种更有用。
"""
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "ml" / "data"
CACHE_DIR = ROOT / "ml" / "cache"


def load_model():
    import open_clip
    model, _, preprocess = open_clip.create_model_and_transforms(
        "ViT-B-32", pretrained="laion2b_s34b_b79k", cache_dir=str(CACHE_DIR)
    )
    model.eval()
    return model, preprocess


def embed_image(model, preprocess, img_path: Path) -> np.ndarray:
    img = Image.open(img_path).convert("RGB")
    tensor = preprocess(img).unsqueeze(0)
    with torch.no_grad():
        feat = model.encode_image(tensor)
        feat = feat / feat.norm(dim=-1, keepdim=True)
    return feat.squeeze(0).cpu().numpy().astype(np.float32)


def aggregate(feats: list[np.ndarray]) -> np.ndarray:
    """多张图特征 -> 笔记级特征：mean 与 max 拼接。"""
    arr = np.stack(feats, axis=0)
    mean_v = arr.mean(axis=0)
    max_v = arr.max(axis=0)
    return np.concatenate([mean_v, max_v], axis=0)


def main():
    ds_path = DATA_DIR / "dataset.jsonl"
    records = [json.loads(l) for l in ds_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    print(f"[info] {len(records)} notes loaded")

    print("[info] loading open_clip ViT-B-32 (first run downloads weights)...")
    model, preprocess = load_model()
    print("[info] model ready")

    X, y, rows, titles, model_qual = [], [], [], [], []
    for rec in records:
        feats = []
        for rel in rec["images"]:
            p = DATA_DIR / rel
            if p.exists():
                try:
                    feats.append(embed_image(model, preprocess, p))
                except Exception as e:
                    print(f"[warn] embed fail {p.name}: {e}")
        if not feats:
            print(f"[warn] note row={rec['row']} has no usable image, skip")
            continue
        X.append(aggregate(feats))
        y.append(rec["label"])
        rows.append(rec["row"])
        titles.append(rec["title"])
        model_qual.append(rec.get("model_qualified"))
        print(f"[ok] row={rec['row']:>2} label={rec['label']} imgs={len(feats)} {rec['title'][:18]}")

    X = np.stack(X, axis=0)
    y = np.array(y, dtype=np.int64)
    out = DATA_DIR / "embeddings.npz"
    np.savez(
        out,
        X=X,
        y=y,
        rows=np.array(rows),
        titles=np.array(titles, dtype=object),
        model_qualified=np.array(model_qual, dtype=object),
    )
    print(f"[done] X={X.shape} y={y.shape} -> {out}")


if __name__ == "__main__":
    main()

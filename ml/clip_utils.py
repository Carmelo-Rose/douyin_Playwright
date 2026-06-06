"""
共享工具：CLIP 图像 embedding。训练与预测共用，保证特征一致。
"""
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "ml" / "cache"

MODEL_NAME = "ViT-B-32"
PRETRAINED = "laion2b_s34b_b79k"


@lru_cache(maxsize=1)
def load_model():
    import open_clip
    model, _, preprocess = open_clip.create_model_and_transforms(
        MODEL_NAME, pretrained=PRETRAINED, cache_dir=str(CACHE_DIR)
    )
    model.eval()
    return model, preprocess


def embed_image(img_path) -> np.ndarray:
    """单张图 -> 归一化 CLIP 特征向量 (512维)。"""
    model, preprocess = load_model()
    img = Image.open(img_path).convert("RGB")
    tensor = preprocess(img).unsqueeze(0)
    with torch.no_grad():
        feat = model.encode_image(tensor)
        feat = feat / feat.norm(dim=-1, keepdim=True)
    return feat.squeeze(0).cpu().numpy().astype(np.float32)


def embed_images(paths, log_every: int = 25) -> np.ndarray:
    """批量抽特征，返回 (N, dim)。"""
    feats = []
    total = len(paths)
    for i, p in enumerate(paths, 1):
        feats.append(embed_image(p))
        if log_every and (i % log_every == 0 or i == total):
            print(f"  [embed] {i}/{total}")
    return np.stack(feats, axis=0)

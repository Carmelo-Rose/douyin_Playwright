"""
共享工具：图像 embedding。训练与预测共用，保证特征一致。
支持多 backbone 并可拼接：CLIP / SigLIP2 / DINOv2。

切换：环境变量 EMBED_BACKBONE，默认 "siglip2-l"。
  - "clip-b32"     : open_clip ViT-B-32 (512维，旧基线)
  - "siglip2-l"    : open_clip ViT-L-16-SigLIP2-384 / webli (1024维，当前默认)
  - "dinov2-l"     : DINOv2 ViT-L/14 (1024维)
  - "siglip2-l+dinov2-l" : 用 + 拼接两者 (2048维)

⚠️ 换 backbone 必须区分缓存——缓存键带 feature_tag()（见 train_singleimage.py）。
   旧 ViT-B-32 是 512 维，SigLIP2-L 是 1024 维，缓存不隔离会读到错维度向量。
自动用 GPU（torch.cuda.is_available()）。
"""
import os
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
import torchvision.transforms as T
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "ml" / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# 可选: "clip-b32" | "siglip2-l" | "dinov2-l" | "siglip2-l+dinov2-l"
# strip 清洗：防止环境变量末尾带空格（cmd `set X=Y &&` 常见坑）
BACKBONE = os.environ.get("EMBED_BACKBONE", "siglip2-l").strip()
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


@lru_cache(maxsize=1)
def _load_clip_b32():
    import open_clip
    model, _, preprocess = open_clip.create_model_and_transforms(
        "ViT-B-32", pretrained="laion2b_s34b_b79k", cache_dir=str(CACHE_DIR))
    model.eval().to(DEVICE)
    return model, preprocess


@lru_cache(maxsize=1)
def _load_siglip2_l():
    import open_clip
    # 真 SigLIP2 ViT-L/16 @384，open_clip 3.3.0 已收录。
    model, _, preprocess = open_clip.create_model_and_transforms(
        "ViT-L-16-SigLIP2-384", pretrained="webli", cache_dir=str(CACHE_DIR))
    model.eval().to(DEVICE)
    return model, preprocess


@lru_cache(maxsize=1)
def _load_dinov2_l():
    model = torch.hub.load("facebookresearch/dinov2", "dinov2_vitl14")
    model.eval().to(DEVICE)
    preprocess = T.Compose([
        T.Resize(256, interpolation=T.InterpolationMode.BICUBIC),
        T.CenterCrop(224),
        T.ToTensor(),
        T.Normalize(mean=(0.485, 0.456, 0.406), std=(0.229, 0.224, 0.225)),
    ])
    return model, preprocess


def _embed_open_clip(loader, img):
    model, preprocess = loader()
    t = preprocess(img).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        f = model.encode_image(t)
        f = f / f.norm(dim=-1, keepdim=True)
    return f.squeeze(0).cpu().numpy().astype(np.float32)


def _embed_dinov2(img):
    model, preprocess = _load_dinov2_l()
    t = preprocess(img).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        f = model(t)  # CLS token (1, 1024)
        f = f / f.norm(dim=-1, keepdim=True)
    return f.squeeze(0).cpu().numpy().astype(np.float32)


_PARTS = {
    "clip-b32": lambda img: _embed_open_clip(_load_clip_b32, img),
    "siglip2-l": lambda img: _embed_open_clip(_load_siglip2_l, img),
    "dinov2-l": _embed_dinov2,
}


def feature_tag() -> str:
    """特征命名空间，用于缓存键，换 backbone 自动失效旧缓存。"""
    return BACKBONE


def embed_image(img_path) -> np.ndarray:
    """单张图 -> 归一化特征向量（按 BACKBONE 拼接，各部分各自 L2 归一化）。"""
    img = Image.open(img_path).convert("RGB")
    parts = [_PARTS[name.strip()](img) for name in BACKBONE.split("+")]
    return (np.concatenate(parts, 0) if len(parts) > 1 else parts[0]).astype(np.float32)


def embed_images(paths, log_every: int = 25) -> np.ndarray:
    """批量抽特征，返回 (N, dim)。"""
    feats = []
    total = len(paths)
    for i, p in enumerate(paths, 1):
        feats.append(embed_image(p))
        if log_every and (i % log_every == 0 or i == total):
            print(f"  [embed] {i}/{total}")
    return np.stack(feats, axis=0)

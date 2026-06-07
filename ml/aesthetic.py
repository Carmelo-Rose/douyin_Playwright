"""
LAION Aesthetic Predictor V2 —— 美学专用分（额外特征）。

把"画质/构图美感"打成一个标量分（约 1~10），作为个性化分类器的额外 1 维特征，
补 CLIP 语义 backbone 不擅长的审美维度。

口径（必须严格匹配 predictor 训练时，否则分数失真）：
  特征来源 = OpenAI CLIP ViT-L/14 的 image embedding（768 维）→ L2 归一化 → MLP → 标量分。
  MLP 权重 = sac+logos+ava1-l14-linearMSE.pth（christophschuhmann/improved-aesthetic-predictor）。

集成方式：在 clip_utils._PARTS 注册成 "aes-laion" 特征源，靠 EMBED_BACKBONE 的 + 拼接，
例如 EMBED_BACKBONE="clip-b32+aes-laion"。美学分**不做 L2 归一化**（单标量归一无意义，
尺度交给训练时的 StandardScaler）。

缓存：本模块独立缓存美学分（键=图片解码后像素的 md5），与 backbone 无关，跨配置只抽一次。
  先 `python ml/aesthetic.py --precompute` 把全量标注的美学分抽进缓存（只加载 CLIP ViT-L/14，
  避免和 backbone 大模型同时占显存），之后各配置训练时纯读缓存。

备选：aesthetic-predictor-v2.5（基于 SigLIP，更准但多一套 transformers 依赖）。本文件默认 V2。
"""
import argparse
import hashlib
import sys
import urllib.request
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "ml" / "cache"
WEIGHTS_DIR = ROOT / "ml" / "weights"
AES_CACHE_PATH = CACHE_DIR / "aes_cache.npz"
LABELED_DIR = ROOT / "ml" / "data" / "labeled"
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# LAION Aesthetic Predictor V2 权重（基于 OpenAI CLIP ViT-L/14，768 维输入）
_WEIGHT_NAME = "sac+logos+ava1-l14-linearMSE.pth"
_WEIGHT_URL = (
    "https://github.com/christophschuhmann/improved-aesthetic-predictor/"
    "raw/main/sac%2Blogos%2Bava1-l14-linearMSE.pth"
)


class _MLP(nn.Module):
    """LAION Aesthetic V2 的 MLP 头：768 -> 1024 -> 128 -> 64 -> 16 -> 1。"""

    def __init__(self, input_size: int = 768):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Linear(input_size, 1024),
            nn.Dropout(0.2),
            nn.Linear(1024, 128),
            nn.Dropout(0.2),
            nn.Linear(128, 64),
            nn.Dropout(0.1),
            nn.Linear(64, 16),
            nn.Linear(16, 1),
        )

    def forward(self, x):
        return self.layers(x)


def _ensure_weights() -> Path:
    """权重不存在则下载一次。"""
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    path = WEIGHTS_DIR / _WEIGHT_NAME
    if not path.exists():
        print(f"[aes] 下载 LAION 美学权重 -> {path}")
        urllib.request.urlretrieve(_WEIGHT_URL, path)
    return path


@lru_cache(maxsize=1)
def _load_predictor():
    """加载 CLIP ViT-L/14（openai）+ 美学 MLP 头。"""
    import open_clip

    clip_model, _, preprocess = open_clip.create_model_and_transforms(
        "ViT-L-14", pretrained="openai", cache_dir=str(CACHE_DIR)
    )
    clip_model.eval().to(DEVICE)

    mlp = _MLP(768)
    state = torch.load(_ensure_weights(), map_location="cpu")
    mlp.load_state_dict(state)
    mlp.eval().to(DEVICE)
    return clip_model, preprocess, mlp


# ----- 美学分缓存（键=图片解码像素 md5，跨 backbone 配置复用）-----
def _load_cache() -> dict:
    if AES_CACHE_PATH.exists():
        data = np.load(AES_CACHE_PATH, allow_pickle=True)
        return dict(zip(data["keys"].tolist(), data["vals"].tolist()))
    return {}


_CACHE = _load_cache()
_DIRTY = False


def save_cache():
    """把内存缓存写盘。"""
    global _DIRTY
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    keys = np.array(list(_CACHE.keys()), dtype=object)
    vals = np.array(list(_CACHE.values()), dtype=np.float32)
    np.savez(AES_CACHE_PATH, keys=keys, vals=vals)
    _DIRTY = False


def _img_key(img: Image.Image) -> str:
    """对解码后的 RGB 像素取 md5，保证同一张图（无论路径/格式）命中同一缓存。"""
    return hashlib.md5(img.tobytes()).hexdigest()


def aesthetic_score(img: Image.Image) -> float:
    """单张 PIL 图 -> 美学分标量。命中缓存直接返回，否则计算并存入内存缓存。"""
    global _DIRTY
    if img.mode != "RGB":
        img = img.convert("RGB")
    key = _img_key(img)
    cached = _CACHE.get(key)
    if cached is not None:
        return float(cached)

    clip_model, preprocess, mlp = _load_predictor()
    t = preprocess(img).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        feat = clip_model.encode_image(t)
        feat = feat / feat.norm(dim=-1, keepdim=True)  # L2 归一化，匹配训练口径
        score = mlp(feat.float()).squeeze().item()

    _CACHE[key] = np.float32(score)
    _DIRTY = True
    return float(score)


def precompute():
    """遍历 labeled good/bad，把全量美学分抽进缓存并存盘（只加载 CLIP ViT-L/14）。"""
    paths = []
    for sub in ("good", "bad"):
        d = LABELED_DIR / sub
        if d.exists():
            paths += [p for p in sorted(d.iterdir()) if p.suffix.lower() in EXTS]
    if not paths:
        print(f"[aes] 未找到标注图片: {LABELED_DIR}")
        return

    print(f"[aes] 预抽美学分: {len(paths)} 张 (device={DEVICE})")
    new = 0
    for i, p in enumerate(paths, 1):
        try:
            img = Image.open(p).convert("RGB")
        except Exception as e:
            print(f"[aes][warn] 跳过 {p.name}: {e}")
            continue
        before = len(_CACHE)
        aesthetic_score(img)
        new += len(_CACHE) - before
        if i % 50 == 0 or i == len(paths):
            print(f"  [aes] {i}/{len(paths)} (new: {new})")
    save_cache()
    print(f"[aes][done] 缓存 -> {AES_CACHE_PATH} (共 {len(_CACHE)} 条)")


def main():
    ap = argparse.ArgumentParser(description="LAION Aesthetic V2 美学分工具")
    ap.add_argument("--precompute", action="store_true",
                    help="遍历 labeled 抽全量美学分进缓存（推荐先跑这个）")
    args = ap.parse_args()
    if args.precompute:
        precompute()
    else:
        ap.print_help()


if __name__ == "__main__":
    main()

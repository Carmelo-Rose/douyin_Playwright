"""
单图审美预测命令 —— 日常可用的识图工具。

加载训练好的模型，对一批图片输出 good/bad 判断和置信度。

用法：
  # 预测一个文件夹下的所有图片
  python ml/predict.py --input path/to/images

  # 预测单张图
  python ml/predict.py --input path/to/one.webp

  # 自定义阈值（默认 0.5，调高更严格）
  python ml/predict.py --input path/to/images --threshold 0.6

  # 结果导出 csv
  python ml/predict.py --input path/to/images --csv result.csv

输出：每张图的 预测(good/bad) + P(good) 置信度，按置信度排序。
"""
import argparse
import csv
import shutil
import sys
from pathlib import Path

# 强制 stdout 用 UTF-8，避免 Windows GBK 控制台打印中文/emoji 报错
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))

import joblib

from clip_utils import embed_image

ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = ROOT / "ml" / "model" / "aesthetic_clf.joblib"
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def collect_images(input_path: Path):
    if input_path.is_file():
        return [input_path] if input_path.suffix.lower() in EXTS else []
    return [p for p in sorted(input_path.rglob("*")) if p.suffix.lower() in EXTS]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="图片文件或文件夹")
    ap.add_argument("--threshold", type=float, default=0.5, help="判 good 的概率阈值，默认0.5")
    ap.add_argument("--csv", default="", help="可选：导出结果到 csv")
    ap.add_argument("--sort-to", default="", help="可选：把图按判断结果复制到 <目录>/good 和 <目录>/bad")
    args = ap.parse_args()

    if not MODEL_PATH.exists():
        print(f"[err] 模型不存在，请先训练：python ml/train_singleimage.py")
        sys.exit(1)

    input_path = Path(args.input)
    if not input_path.is_absolute():
        input_path = Path.cwd() / input_path
    images = collect_images(input_path)
    if not images:
        print(f"[err] 没找到图片: {input_path}")
        sys.exit(1)

    print(f"[info] 加载模型 {MODEL_PATH.name}")
    model = joblib.load(MODEL_PATH)
    print(f"[info] 预测 {len(images)} 张图片 (阈值={args.threshold})...\n")

    rows = []
    for i, p in enumerate(images, 1):
        try:
            vec = embed_image(p).reshape(1, -1)
            prob_good = float(model.predict_proba(vec)[0, 1])
        except Exception as e:
            print(f"[warn] 跳过 {p.name}: {e}")
            continue
        verdict = "good" if prob_good >= args.threshold else "bad"
        rows.append((p.name, verdict, prob_good, str(p)))
        if i % 25 == 0:
            print(f"  [进度] {i}/{len(images)}")

    # 按 P(good) 降序：最像好图的排最前
    rows.sort(key=lambda r: r[2], reverse=True)

    n_good = sum(1 for r in rows if r[1] == "good")
    print(f"\n=== 预测结果 (good={n_good}, bad={len(rows)-n_good}) ===")
    for name, verdict, prob, _ in rows:
        mark = "[GOOD]" if verdict == "good" else "[BAD] "
        print(f"{mark} P(good)={prob:.2f}  {name[:50]}")

    if args.csv:
        csv_path = Path(args.csv)
        with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["文件名", "预测", "P(good)", "路径"])
            for name, verdict, prob, full in rows:
                w.writerow([name, verdict, f"{prob:.4f}", full])
        print(f"\n[done] 已导出 -> {csv_path}")

    if args.sort_to:
        sort_dir = Path(args.sort_to)
        if not sort_dir.is_absolute():
            sort_dir = Path.cwd() / sort_dir
        good_dir = sort_dir / "good"
        bad_dir = sort_dir / "bad"
        good_dir.mkdir(parents=True, exist_ok=True)
        bad_dir.mkdir(parents=True, exist_ok=True)
        copied = 0
        for name, verdict, prob, full in rows:
            dest_dir = good_dir if verdict == "good" else bad_dir
            # 文件名加置信度前缀，便于在文件夹里按"最像/最不像"排序查看
            pct = int(round(prob * 100))
            dest_name = f"{pct:03d}_{name}"
            try:
                shutil.copy2(full, dest_dir / dest_name)
                copied += 1
            except Exception as e:
                print(f"[warn] 复制失败 {name}: {e}")
        print(f"\n[done] 已分拣 {copied} 张 -> {sort_dir}")
        print(f"       good/ ({n_good} 张)  bad/ ({len(rows)-n_good} 张)")
        print(f"       文件名前缀=P(good)百分比，文件夹内可按名称排序看最像/最不像")


if __name__ == "__main__":
    main()

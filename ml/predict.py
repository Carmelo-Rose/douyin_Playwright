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
import sys
from pathlib import Path

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
        mark = "✅" if verdict == "good" else "❌"
        print(f"{mark} P(good)={prob:.2f}  {name[:50]}")

    if args.csv:
        csv_path = Path(args.csv)
        with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["文件名", "预测", "P(good)", "路径"])
            for name, verdict, prob, full in rows:
                w.writerow([name, verdict, f"{prob:.4f}", full])
        print(f"\n[done] 已导出 -> {csv_path}")


if __name__ == "__main__":
    main()

"""
把纠错后的预测结果合并进训练集，用于二次训练（主动学习闭环）。

用法：
  python ml/merge_feedback.py --from "C:/.../predict_result"

行为：
- from/good 的图 -> ml/data/labeled/good
- from/bad  的图 -> ml/data/labeled/bad
- 去掉文件名的百分比前缀（如 087_xxx.webp -> xxx.webp）
- 重名时加后缀避免覆盖
- 复制（不移动），原结果文件夹保留
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
LABELED = ROOT / "ml" / "data" / "labeled"
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
PREFIX_RE = re.compile(r"^\d{1,3}_")  # 去掉 087_ 这类前缀


def merge_dir(src: Path, dst: Path) -> int:
    dst.mkdir(parents=True, exist_ok=True)
    existing = {p.name for p in dst.iterdir() if p.is_file()}
    count = 0
    for p in sorted(src.iterdir()):
        if p.suffix.lower() not in EXTS:
            continue
        clean = PREFIX_RE.sub("", p.name)
        target = clean
        # 防重名
        if target in existing:
            stem, ext = Path(clean).stem, Path(clean).suffix
            i = 1
            while f"{stem}_fb{i}{ext}" in existing:
                i += 1
            target = f"{stem}_fb{i}{ext}"
        shutil.copy2(p, dst / target)
        existing.add(target)
        count += 1
    return count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True, help="纠错后的 predict_result 文件夹")
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_absolute():
        src = Path.cwd() / src
    src_good, src_bad = src / "good", src / "bad"
    if not src_good.exists() or not src_bad.exists():
        print(f"[err] 找不到 good/bad 子文件夹: {src}")
        sys.exit(1)

    before_good = len(list((LABELED / "good").glob("*"))) if (LABELED / "good").exists() else 0
    before_bad = len(list((LABELED / "bad").glob("*"))) if (LABELED / "bad").exists() else 0

    n_good = merge_dir(src_good, LABELED / "good")
    n_bad = merge_dir(src_bad, LABELED / "bad")

    after_good = len(list((LABELED / "good").glob("*")))
    after_bad = len(list((LABELED / "bad").glob("*")))

    print(f"[done] 合并完成")
    print(f"  good: {before_good} + {n_good} -> {after_good}")
    print(f"  bad : {before_bad} + {n_bad} -> {after_bad}")
    print(f"  训练集总计: {after_good + after_bad} 张")
    print(f"\n下一步: python ml/train_singleimage.py")


if __name__ == "__main__":
    main()

"""
对 ml/data/labeled/good 和 bad 目录按文件内容（MD5）去重。

策略：
  - 目录内重复：保留文件名数字最小的，删其余
  - 跨目录重复（good+bad 同图，标注冲突）：默认保留 good，从 bad 删除；
    可用 --conflict=bad 反转，或 --conflict=report 仅打印不删

用法：
  python scripts/dedup_labeled.py [--dry-run] [--conflict good|bad|report]
"""
import argparse
import hashlib
import os
import sys
from collections import defaultdict
from pathlib import Path

LABELED_ROOT = Path("ml/data/labeled")
DIRS = {"good": LABELED_ROOT / "good", "bad": LABELED_ROOT / "bad"}


def md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def numeric_key(fn: str) -> int:
    """从文件名提取数字用于排序，非数字文件名排后面。"""
    stem = Path(fn).stem
    return int(stem) if stem.isdigit() else 10**9


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只打印，不实际删除")
    parser.add_argument(
        "--conflict",
        choices=["good", "bad", "report"],
        default="good",
        help="跨目录冲突时保留哪边（默认 good）",
    )
    args = parser.parse_args()
    dry = args.dry_run

    if dry:
        print("[DRY-RUN 模式，不实际删除]\n")

    # 收集所有文件的 hash
    hash_map: dict[str, list[tuple[str, Path]]] = defaultdict(list)
    for label, d in DIRS.items():
        for fn in sorted(os.listdir(d), key=numeric_key):
            fp = d / fn
            h = md5(fp)
            hash_map[h].append((label, fp))

    to_delete: list[tuple[str, Path]] = []  # (reason, path)

    for h, entries in hash_map.items():
        if len(entries) == 1:
            continue

        labels = [e[0] for e in entries]
        unique_labels = set(labels)

        if len(unique_labels) == 1:
            # 同目录内重复：保留第一个（文件名最小），删其余
            keep = entries[0]
            for e in entries[1:]:
                to_delete.append((f"目录内重复（保留 {keep[1].name}）", e[1]))
        else:
            # 跨目录冲突
            if args.conflict == "report":
                print(f"[CONFLICT] 同图跨目录标注冲突，hash={h[:8]}:")
                for label, fp in entries:
                    print(f"    {label}: {fp.name}")
                continue

            keep_label = args.conflict
            del_label = "bad" if keep_label == "good" else "good"
            for label, fp in entries:
                if label == del_label:
                    to_delete.append((f"跨目录冲突（保留 {keep_label}/{[e[1].name for e in entries if e[0]==keep_label][0]}）", fp))

    # 汇总
    inner_good = [(r, p) for r, p in to_delete if "目录内" in r and "good" in str(p)]
    inner_bad  = [(r, p) for r, p in to_delete if "目录内" in r and "bad"  in str(p)]
    cross      = [(r, p) for r, p in to_delete if "跨目录" in r]

    print(f"待删除：{len(to_delete)} 个文件")
    print(f"  good 内部重复: {len(inner_good)} 个")
    print(f"  bad  内部重复: {len(inner_bad)}  个")
    print(f"  跨目录冲突:    {len(cross)} 个\n")

    for reason, fp in to_delete:
        tag = "[DEL]" if not dry else "[DRY]"
        print(f"  {tag} {fp.relative_to(LABELED_ROOT)}  ← {reason}")
        if not dry:
            fp.unlink()

    if not dry:
        print(f"\n[OK] 已删除 {len(to_delete)} 个重复文件")
        # 最终统计
        for label, d in DIRS.items():
            remaining = len(os.listdir(d))
            print(f"     {label}: {remaining} 张")
    else:
        print(f"\n[DRY-RUN] 实际运行请去掉 --dry-run 参数")


if __name__ == "__main__":
    main()

"""
从 output/*.xlsx 的「图片链接」列提取所有图片 URL，下载到 ml/data/images/，
下载完成后按 MD5 内容去重（保留文件名数字最小的）。

用法：python scripts/download_images.py [--workers 8] [--out ml/data/images]
"""
import argparse
import glob
import hashlib
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd
import requests

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://www.xiaohongshu.com/",
})


def collect_urls(xlsx_files: list[str]) -> list[tuple[str, str]]:
    """返回 [(url, source_file), ...] URL 级别去重。"""
    seen: set[str] = set()
    result: list[tuple[str, str]] = []
    for f in xlsx_files:
        try:
            df = pd.read_excel(f)
        except Exception as e:
            print(f"[WARN] 跳过 {f}: {e}")
            continue
        if "图片链接" not in df.columns:
            continue
        for val in df["图片链接"].dropna():
            for u in str(val).split("\n"):
                u = u.strip()
                if u.startswith("http") and u not in seen:
                    seen.add(u)
                    result.append((u, os.path.basename(f)))
    return result


def url_to_filename(url: str, idx: int) -> str:
    """根据 URL 生成文件名，尽量保留原始扩展名。"""
    path = urlparse(url).path
    ext = os.path.splitext(path)[-1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        ext = ".webp"
    return f"{idx:05d}{ext}"


def download_one(url: str, dest: Path, retries: int = 2) -> tuple[bool, str]:
    for attempt in range(retries + 1):
        try:
            resp = SESSION.get(url, timeout=20, stream=True)
            resp.raise_for_status()
            content = resp.content
            if len(content) < 1024:
                return False, f"too small ({len(content)} bytes)"
            dest.write_bytes(content)
            return True, ""
        except Exception as e:
            if attempt < retries:
                time.sleep(1 + attempt)
            else:
                return False, str(e)
    return False, "unknown"


def md5_file(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def dedup_by_content(out_dir: Path) -> int:
    """按 MD5 去重，保留最早编号的文件，返回删除数量。"""
    from collections import defaultdict
    hash_map: dict[str, list[Path]] = defaultdict(list)
    for fp in sorted(out_dir.iterdir()):
        if fp.is_file():
            hash_map[md5_file(fp)].append(fp)

    deleted = 0
    for paths in hash_map.values():
        if len(paths) > 1:
            # 保留文件名最小的（sorted 已按名称排好）
            for dup in paths[1:]:
                dup.unlink()
                deleted += 1
    return deleted


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="ml/data/images", help="图片输出目录")
    parser.add_argument("--workers", type=int, default=8, help="并发下载线程数")
    parser.add_argument("--input-dir", default="output", help="xlsx 所在目录")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    xlsx_files = [f for f in sorted(glob.glob(os.path.join(args.input_dir, "*.xlsx")))
                  if "merged" not in f]
    if not xlsx_files:
        print("[ERROR] 未找到 xlsx 文件")
        sys.exit(1)

    print(f"扫描 {len(xlsx_files)} 个文件…")
    url_list = collect_urls(xlsx_files)
    print(f"去重后待下载: {len(url_list)} 张\n")

    # 已存在的文件跳过（支持断点续传）
    existing = {f.name for f in out_dir.iterdir() if f.is_file()}
    tasks: list[tuple[int, str]] = []
    for i, (url, _) in enumerate(url_list):
        fname = url_to_filename(url, i)
        if fname not in existing:
            tasks.append((i, url))

    print(f"已存在 {len(existing)} 张，本次下载 {len(tasks)} 张")
    if not tasks:
        print("全部已下载，跳过。")
    else:
        ok = fail = 0
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(download_one, url, out_dir / url_to_filename(url, i)): (i, url)
                for i, url in tasks
            }
            for future in as_completed(futures):
                success, err = future.result()
                if success:
                    ok += 1
                else:
                    fail += 1
                    i, url = futures[future]
                    print(f"  [FAIL] {url[:80]}… {err}")
                if (ok + fail) % 100 == 0:
                    print(f"  进度: {ok+fail}/{len(tasks)} (成功{ok} 失败{fail})")

        print(f"\n下载完成: 成功 {ok}，失败 {fail}")

    # 内容去重
    print("\n按内容 MD5 去重…")
    deleted = dedup_by_content(out_dir)
    remaining = sum(1 for f in out_dir.iterdir() if f.is_file())
    print(f"删除重复: {deleted} 张")
    print(f"最终图片数: {remaining} 张")
    print(f"输出目录: {out_dir.resolve()}")


if __name__ == "__main__":
    main()

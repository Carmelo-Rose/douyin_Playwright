"""
从 xlsx 表格提取内嵌图片到文件夹（不需要标签，用于待判断的新数据）。

用法：
  python ml/extract_images_only.py --input "output/xxx.xlsx" --out ml/data/to_predict --max-notes 30

输出：每张图命名为 row{行号}_img{序号}.{ext}，便于回溯是哪条笔记。
"""
import argparse
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

COL_IMG_FIRST = 13  # 图片1 (1-based)
COL_IMG_LAST = 18   # 图片6


def parse_drawing_anchors(zf: zipfile.ZipFile):
    xml = zf.read("xl/drawings/drawing1.xml").decode("utf-8")
    rels = zf.read("xl/drawings/_rels/drawing1.xml.rels").decode("utf-8")
    rid_to_media = {}
    for rid, target in re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels):
        rid_to_media[rid] = target.replace("../", "xl/")
    anchors = {}
    for block in re.findall(r"<xdr:oneCellAnchor[^>]*>[\s\S]*?</xdr:oneCellAnchor>", xml):
        row = re.search(r"<xdr:row>(\d+)</xdr:row>", block)
        col = re.search(r"<xdr:col>(\d+)</xdr:col>", block)
        rid = re.search(r'r:embed="(rId\d+)"', block)
        if row and col and rid:
            media = rid_to_media.get(rid.group(1))
            if media:
                anchors[(int(row.group(1)), int(col.group(1)))] = media
    return anchors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", default="ml/data/to_predict")
    ap.add_argument("--max-notes", type=int, default=0, help="只提取前N条笔记，0=全部")
    ap.add_argument("--imgs-per-note", type=int, default=2, help="每条笔记取前几张图，默认2(对齐判断习惯)")
    args = ap.parse_args()

    xlsx = Path(args.input)
    if not xlsx.is_absolute():
        xlsx = Path.cwd() / xlsx
    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = Path.cwd() / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    zf = zipfile.ZipFile(xlsx)
    anchors = parse_drawing_anchors(zf)
    rows = sorted({r for (r, c) in anchors.keys()})
    if args.max_notes > 0:
        rows = rows[: args.max_notes]

    saved = 0
    for row0 in rows:
        cnt = 0
        for col0 in range(COL_IMG_FIRST - 1, COL_IMG_LAST):
            if cnt >= args.imgs_per_note:
                break
            media = anchors.get((row0, col0))
            if not media:
                continue
            ext = Path(media).suffix or ".webp"
            out_name = f"row{row0 + 1:03d}_img{cnt + 1}{ext}"
            try:
                (out_dir / out_name).write_bytes(zf.read(media))
                saved += 1
                cnt += 1
            except KeyError:
                pass

    print(f"[done] 提取 {saved} 张图 (笔记 {len(rows)} 条, 每条前 {args.imgs_per_note} 张) -> {out_dir}")


if __name__ == "__main__":
    main()

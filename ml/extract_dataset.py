"""
从人工标注的 xlsx 中提取数据集：图片 + 标签 + 视觉模型判断。

数据来源：output/xhs-notes-*.xlsx
- 内嵌图片通过 drawing XML 锚定关系还原到每一行（每条笔记）
- 人工标注：标红行(填充色 FFC00000) = 不合适(label=0)，未标红 = 合适(label=1)
- 同时记录视觉模型原判断（视觉合格列），用于后续对比模型 vs 人工

输出：
- ml/data/images/<noteIdx>_<imgIdx>.<ext>   每条笔记的图片
- ml/data/dataset.jsonl                       每条笔记一行：行号、标签、模型判断、图片路径列表、标题
"""
import json
import re
import sys
import zipfile
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_XLSX = ROOT / "output" / "xhs-notes-帽子-20260605-093632(1).xlsx"
OUT_DIR = ROOT / "ml" / "data"
IMG_DIR = OUT_DIR / "images"

RED_FILL = "FFC00000"  # 人工标红 = 不合适

# notes sheet 列号（1-based）
COL_TITLE = 3
COL_VISUAL_QUALIFIED = 21
COL_VISUAL_SCORE = 22
COL_IMG_FIRST = 13  # 图片1
COL_IMG_LAST = 18   # 图片6


def is_red_row(ws, row: int) -> bool:
    for col in range(1, 28):
        fill = ws.cell(row, col).fill
        if fill and fill.patternType == "solid":
            fg = fill.fgColor
            if getattr(fg, "type", None) == "rgb" and str(fg.rgb) == RED_FILL:
                return True
    return False


def parse_drawing_anchors(zf: zipfile.ZipFile):
    """返回 {(row0, col0): media_filename}，row0/col0 为 0-based。"""
    xml = zf.read("xl/drawings/drawing1.xml").decode("utf-8")
    rels = zf.read("xl/drawings/_rels/drawing1.xml.rels").decode("utf-8")
    rid_to_media = {}
    for rid, target in re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels):
        media = target.replace("../", "xl/")
        rid_to_media[rid] = media

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
    xlsx_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx_path.exists():
        print(f"[err] xlsx not found: {xlsx_path}")
        sys.exit(1)

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[info] reading {xlsx_path}")

    wb = openpyxl.load_workbook(xlsx_path)
    ws = wb["notes"]

    zf = zipfile.ZipFile(xlsx_path)
    anchors = parse_drawing_anchors(zf)
    print(f"[info] parsed {len(anchors)} image anchors")

    records = []
    saved_imgs = 0
    for row in range(2, ws.max_row + 1):
        row0 = row - 1  # drawing 用 0-based
        label = 0 if is_red_row(ws, row) else 1
        title = str(ws.cell(row, COL_TITLE).value or "")[:40]
        model_qualified = ws.cell(row, COL_VISUAL_QUALIFIED).value
        model_score = ws.cell(row, COL_VISUAL_SCORE).value

        img_paths = []
        for col in range(COL_IMG_FIRST - 1, COL_IMG_LAST):  # 0-based 列 12..17
            media = anchors.get((row0, col))
            if not media:
                continue
            ext = Path(media).suffix or ".webp"
            out_name = f"note{row:02d}_img{col - (COL_IMG_FIRST - 1) + 1}{ext}"
            out_path = IMG_DIR / out_name
            try:
                out_path.write_bytes(zf.read(media))
                img_paths.append(f"images/{out_name}")
                saved_imgs += 1
            except KeyError:
                pass

        records.append({
            "row": row,
            "label": label,
            "label_text": "合适" if label == 1 else "不合适(人工标红)",
            "model_qualified": model_qualified,
            "model_score": model_score,
            "title": title,
            "images": img_paths,
        })

    out_jsonl = OUT_DIR / "dataset.jsonl"
    with out_jsonl.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    n_pos = sum(1 for r in records if r["label"] == 1)
    n_neg = len(records) - n_pos
    print(f"[done] notes={len(records)} (合适={n_pos}, 不合适={n_neg}), images_saved={saved_imgs}")
    print(f"[done] dataset -> {out_jsonl}")
    print(f"[done] images  -> {IMG_DIR}")


if __name__ == "__main__":
    main()

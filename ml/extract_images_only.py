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

COL_IMG_FIRST = 13  # 图片1 (1-based) — 仅作 fallback，优先自动检测
COL_IMG_LAST = 18   # 图片6


def find_notes_sheet_drawing(zf: zipfile.ZipFile) -> str | None:
    """
    通过 workbook.xml.rels + sheet1/sheet2/... rels，找到名为 'notes' 的
    sheet 对应的 drawing 文件路径（xl/drawings/drawingN.xml）。
    如果找不到则回退到 drawing1.xml。
    """
    names = zf.namelist()

    # 1. 找 workbook.xml，定位各 sheet 的 rId -> 文件路径
    wb_rels_path = "xl/_rels/workbook.xml.rels"
    if wb_rels_path not in names:
        return None
    wb_rels = zf.read(wb_rels_path).decode("utf-8")
    # sheet rId -> xl/worksheets/sheetN.xml
    sheet_rid_to_path: dict[str, str] = {}
    for rid, target in re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', wb_rels):
        if "worksheets/" in target:
            sheet_rid_to_path[rid] = target if target.startswith("xl/") else f"xl/{target}"

    # 2. 找 workbook.xml，拿 sheet name -> rId
    wb_path = "xl/workbook.xml"
    if wb_path not in names:
        return None
    wb_xml = zf.read(wb_path).decode("utf-8")
    notes_sheet_path: str | None = None
    for m in re.finditer(r'<sheet\s[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"', wb_xml):
        sheet_name, rid = m.group(1), m.group(2)
        if sheet_name.lower() == "notes":
            notes_sheet_path = sheet_rid_to_path.get(rid)
            break

    if not notes_sheet_path or notes_sheet_path not in names:
        return None

    # 3. 通过 sheetN.xml.rels 找 drawing 路径
    sheet_file = notes_sheet_path.split("/")[-1]        # sheetN.xml
    sheet_rels_path = f"xl/worksheets/_rels/{sheet_file}.rels"
    if sheet_rels_path not in names:
        return None
    sheet_rels = zf.read(sheet_rels_path).decode("utf-8")
    for target in re.findall(r'Type="[^"]*drawing[^"]*"[^>]*Target="([^"]+)"', sheet_rels):
        drawing_path = target if target.startswith("xl/") else f"xl/{target.lstrip('../')}"
        drawing_path = re.sub(r"xl/+", "xl/", drawing_path)
        if drawing_path in names:
            return drawing_path
    # fallback: any drawing target
    for target in re.findall(r'Target="(\.\./drawings/drawing\d+\.xml)"', sheet_rels):
        drawing_path = "xl/" + target.lstrip("../")
        if drawing_path in names:
            return drawing_path

    return None


def parse_drawing_anchors(zf: zipfile.ZipFile):
    drawing_path = find_notes_sheet_drawing(zf)
    if not drawing_path:
        # 回退到 drawing1.xml
        drawing_path = "xl/drawings/drawing1.xml"

    rels_path = drawing_path.replace("xl/drawings/", "xl/drawings/_rels/") + ".rels"
    names = zf.namelist()
    if drawing_path not in names:
        print(f"[warn] drawing 文件不存在: {drawing_path}，尝试所有 drawing 文件")
        # 最后兜底：合并所有 drawing 文件的 anchors
        anchors: dict[tuple[int, int], str] = {}
        for name in names:
            if re.match(r"xl/drawings/drawing\d+\.xml$", name):
                anchors.update(_parse_single_drawing(zf, name))
        return anchors

    print(f"[info] 使用 drawing 文件: {drawing_path}")
    return _parse_single_drawing(zf, drawing_path)


def _parse_single_drawing(zf: zipfile.ZipFile, drawing_path: str) -> dict[tuple[int, int], str]:
    rels_path = drawing_path.replace("xl/drawings/", "xl/drawings/_rels/") + ".rels"
    names = zf.namelist()
    rid_to_media: dict[str, str] = {}
    if rels_path in names:
        rels = zf.read(rels_path).decode("utf-8")
        for rid, target in re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels):
            rid_to_media[rid] = target.replace("../", "xl/")

    xml = zf.read(drawing_path).decode("utf-8")
    anchors: dict[tuple[int, int], str] = {}
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

    # 自动检测图片列范围：取所有 anchor 中出现的列号，找连续最大块
    all_cols = sorted({c for (r, c) in anchors.keys()})
    if all_cols:
        # 找出现次数最多的列号簇（连续列），作为图片列范围
        col_first = all_cols[0]
        col_last = all_cols[-1]
        print(f"[info] 检测到图片列范围: {col_first}-{col_last} (0-based，共 {col_last - col_first + 1} 列)")
    else:
        col_first = COL_IMG_FIRST - 1
        col_last = COL_IMG_LAST - 1
        print(f"[warn] 未检测到图片，使用默认列范围: {col_first}-{col_last} (0-based)")

    rows = sorted({r for (r, c) in anchors.keys()})
    if args.max_notes > 0:
        rows = rows[: args.max_notes]

    saved = 0
    for row0 in rows:
        cnt = 0
        for col0 in range(col_first, col_last + 1):
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

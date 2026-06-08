"""FP 错例聚类：找出模型最常把哪几类 bad 误判成 good。

读 ml/model/train_report.json 的 errors（true=bad & pred=good 即 FP），
抽 CLIP 特征 -> KMeans 聚类 -> 每簇复制代表图到输出目录，并打印簇规模。
"""
import argparse, json, shutil, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
from sklearn.cluster import KMeans
from clip_utils import embed_image

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "ml" / "model" / "train_report.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top-k", type=int, default=4, help="聚成几簇")
    ap.add_argument("--out", default="ml/data/fp_clusters", help="代表图输出目录")
    ap.add_argument("--per-cluster", type=int, default=12, help="每簇复制几张代表图")
    args = ap.parse_args()

    if not REPORT.exists():
        print(f"[err] 找不到 {REPORT}，请先训练生成 train_report.json")
        sys.exit(1)

    report = json.loads(REPORT.read_text(encoding="utf-8"))
    fps = [e for e in report.get("errors", []) if e["true"] == "bad" and e["pred"] == "good"]
    print(f"[info] FP（bad 被判 good）共 {len(fps)} 张")
    if len(fps) < args.top_k:
        print("[err] FP 太少，无需聚类")
        return

    paths, vecs = [], []
    for i, e in enumerate(fps, 1):
        p = ROOT / e["path"]
        if not p.exists():
            print(f"[warn] 跳过缺失文件: {e['path']}")
            continue
        paths.append((p, float(e.get("prob_good", 0))))
        vecs.append(embed_image(p))
        if i % 25 == 0 or i == len(fps):
            print(f"  [embed] {i}/{len(fps)}")

    X = np.stack(vecs)
    km = KMeans(n_clusters=args.top_k, n_init=10, random_state=42).fit(X)
    labels = km.labels_

    out = ROOT / args.out
    print(f"\n=== FP 聚类结果（k={args.top_k}）===")
    for c in range(args.top_k):
        idx = np.where(labels == c)[0]
        # 离簇心最近的当代表
        center = km.cluster_centers_[c]
        order = sorted(idx, key=lambda j: np.linalg.norm(X[j] - center))
        print(f"簇 {c}: {len(idx)} 张  (占 FP 的 {len(idx)/len(labels)*100:.0f}%)")
        cdir = out / f"cluster_{c}"
        cdir.mkdir(parents=True, exist_ok=True)
        for rank, j in enumerate(order[: args.per_cluster]):
            p, prob = paths[j]
            pct = int(round(prob * 100))
            shutil.copy2(p, cdir / f"{pct:03d}_{rank:02d}_{p.name}")
    print(f"\n[done] 代表图已复制 -> {out}")
    print("       逐簇打开看：模型把『哪一类 bad』最常误当 good，就定向补那一类难负样本。")


if __name__ == "__main__":
    main()

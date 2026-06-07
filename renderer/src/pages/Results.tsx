import { useEffect, useState } from "react";
import type { ResultFileMeta, ResultSheet } from "../../../electron/shared/ipc";

export default function Results({ outputDir }: { outputDir: string }) {
  const [files, setFiles] = useState<ResultFileMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [sheet, setSheet] = useState<ResultSheet | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = () => window.vp.listResults().then(setFiles);
  useEffect(() => { refresh(); }, []);

  async function openFile(meta: ResultFileMeta) {
    setActive(meta.path);
    setLoading(true);
    setSheet(await window.vp.readResult(meta.path));
    setLoading(false);
  }

  return (
    <div className="page">
      <div className="row">
        <button className="ghost" onClick={refresh}>刷新</button>
        <span className="muted">{outputDir}</span>
      </div>

      {files.length === 0 && <p className="muted">还没有导出文件。跑一次抓取后回来这里查看。</p>}

      {files.map((f) => (
        <div key={f.path} className={`file-item ${active === f.path ? "active" : ""}`} onClick={() => openFile(f)}>
          <span>{f.name}</span>
          <span className="muted">
            {(f.size / 1024).toFixed(0)} KB · {new Date(f.mtimeMs).toLocaleString()}
            <button className="ghost" style={{ marginLeft: 8 }} onClick={(e) => { e.stopPropagation(); window.vp.openResult(f.path); }}>打开</button>
            <button className="ghost" style={{ marginLeft: 6 }} onClick={(e) => { e.stopPropagation(); window.vp.revealResult(f.path); }}>定位</button>
          </span>
        </div>
      ))}

      {loading && <p className="muted">读取中…</p>}
      {sheet && !loading && (
        <div style={{ marginTop: 12, overflow: "auto", maxHeight: "calc(100vh - 320px)" }}>
          <p className="muted">前 {sheet.rows.length} 行（最多预览 500 行）</p>
          <table>
            <thead><tr>{sheet.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {sheet.rows.map((row, i) => (
                <tr key={i}>{sheet.columns.map((c) => <td key={c} title={String(row[c] ?? "")}>{String(row[c] ?? "")}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

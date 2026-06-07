import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  MlEnvReport,
  MlLogEvent,
  MlRunPaths,
  MlSettings,
  ResultFileMeta,
  SortedImage,
  TrainReport,
} from "../../../electron/shared/ipc";
import LogPanel, { type LogLine } from "../components/LogPanel";

type Step = "extract" | "predict" | "merge" | "train";

export default function MlWorkbench() {
  const [env, setEnv] = useState<MlEnvReport | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [settings, setSettings] = useState<MlSettings | null>(null);
  const [run, setRun] = useState<MlRunPaths | null>(null);

  const [sourceTab, setSourceTab] = useState<"xlsx" | "folder">("xlsx");
  const [xlsxFiles, setXlsxFiles] = useState<ResultFileMeta[]>([]);
  const [selectedXlsx, setSelectedXlsx] = useState("");
  const [folder, setFolder] = useState("");
  const [imagesDir, setImagesDir] = useState(""); // predict 的输入目录

  const [logs, setLogs] = useState<MlLogEvent[]>([]);
  const [busy, setBusy] = useState<Step | null>(null);
  const [sorted, setSorted] = useState<SortedImage[]>([]);
  const [report, setReport] = useState<TrainReport | null>(null);

  const jobIdRef = useRef<string | null>(null);
  const stepRef = useRef<Step | null>(null);
  const runRef = useRef<MlRunPaths | null>(null);

  // 纠错操作后保持两栏各自的内部滚动位置，避免点击后回到栏顶
  const pendingGridScroll = useRef<number[] | null>(null);

  const keepScroll = useCallback(() => {
    const grids = document.querySelectorAll<HTMLDivElement>(".mlgrid");
    pendingGridScroll.current = Array.from(grids).map((g) => g.scrollTop);
  }, []);

  useLayoutEffect(() => {
    const saved = pendingGridScroll.current;
    if (!saved) return;
    pendingGridScroll.current = null;
    const grids = document.querySelectorAll<HTMLDivElement>(".mlgrid");
    grids.forEach((g, i) => {
      if (saved[i] != null) g.scrollTop = saved[i];
    });
  });

  // ④ 纠错区交互状态
  const PAGE_SIZE = 60;
  const [shownGood, setShownGood] = useState(PAGE_SIZE);
  const [shownBad, setShownBad] = useState(PAGE_SIZE);
  const [lightbox, setLightbox] = useState<SortedImage | null>(null);
  const [flashPaths, setFlashPaths] = useState<Record<string, number>>({});
  const [trash, setTrash] = useState<{ img: SortedImage; trashPath: string } | null>(null);
  const trashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 高亮一张刚移动/恢复的图 ~1.5s
  const flash = useCallback((path: string) => {
    setFlashPaths((prev) => ({ ...prev, [path]: Date.now() }));
    setTimeout(() => {
      setFlashPaths((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    }, 1600);
  }, []);

  // ESC 关闭大图预览
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && setLightbox(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // 初始化
  useEffect(() => {
    window.vp.ml.getSettings().then(setSettings);
    window.vp.listResults().then(setXlsxFiles);
    window.vp.ml.getReport().then(setReport);
    detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 日志订阅 + 步骤完成后的后续动作
  useEffect(() => {
    return window.vp.ml.onLog((e) => {
      if (e.jobId !== jobIdRef.current) return;
      setLogs((prev) => [...prev, e]);
      if (e.done) {
        const step = stepRef.current;
        setBusy(null);
        jobIdRef.current = null;
        if (e.code === 0 && step === "predict" && runRef.current) {
          window.vp.ml.listSorted(runRef.current.runDir).then((list) => {
            setSorted(list);
            setShownGood(PAGE_SIZE);
            setShownBad(PAGE_SIZE);
          });
        } else if (e.code === 0 && step === "train") {
          window.vp.ml.getReport().then(setReport);
          detect();
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detect = useCallback(async () => {
    setDetecting(true);
    setEnv(await window.vp.ml.detectEnv());
    setDetecting(false);
  }, []);

  async function ensureRun(): Promise<MlRunPaths> {
    if (runRef.current) return runRef.current;
    const r = await window.vp.ml.newRun();
    runRef.current = r;
    setRun(r);
    return r;
  }

  function patchSettings(p: Partial<MlSettings>) {
    setSettings((s) => (s ? { ...s, ...p } : s));
    window.vp.ml.setSettings(p);
  }

  async function startJob(step: Step, starter: () => Promise<{ jobId: string }>) {
    setLogs([]);
    setBusy(step);
    stepRef.current = step;
    const { jobId } = await starter();
    jobIdRef.current = jobId;
  }

  const onExtract = async () => {
    if (!selectedXlsx) return;
    const r = await ensureRun();
    setImagesDir(r.toPredictDir);
    await startJob("extract", () =>
      window.vp.ml.extract({
        xlsx: selectedXlsx,
        out: r.toPredictDir,
        maxNotes: settings?.maxNotes ?? 0,
        imgsPerNote: settings?.imgsPerNote ?? 2,
      }),
    );
  };

  const onSelectFolder = async () => {
    const dir = await window.vp.ml.selectFolder();
    if (dir) {
      setFolder(dir);
      setImagesDir(dir);
    }
  };

  const onPredict = async () => {
    const r = await ensureRun();
    const input = sourceTab === "folder" ? folder : imagesDir || r.toPredictDir;
    if (!input) return;
    await startJob("predict", () =>
      window.vp.ml.predict({ input, sortTo: r.runDir, threshold: settings?.threshold ?? 0.5 }),
    );
  };

  const onFlip = async (img: SortedImage) => {
    const to = img.label === "good" ? "bad" : "good";
    const updated = await window.vp.ml.flipImage({ path: img.path, to });
    if (updated) {
      keepScroll();
      // 替换数组中对应项，保持原有顺序 → 列表不整体重排，滚动位置不跳
      setSorted((prev) => prev.map((s) => (s.path === img.path ? updated : s)));
      flash(updated.path);
    }
  };

  const onRemove = async (img: SortedImage) => {
    const res = await window.vp.ml.removeImage({ path: img.path });
    if (!res) return;
    keepScroll();
    setSorted((prev) => prev.filter((s) => s.path !== img.path));
    if (trashTimer.current) clearTimeout(trashTimer.current);
    setTrash({ img, trashPath: res.trashPath });
    trashTimer.current = setTimeout(() => setTrash(null), 5000);
  };

  const onUndoRemove = async () => {
    if (!trash) return;
    if (trashTimer.current) clearTimeout(trashTimer.current);
    const restored = await window.vp.ml.restoreImage({ trashPath: trash.trashPath });
    if (restored) {
      keepScroll();
      setSorted((prev) => [...prev, restored]);
      flash(restored.path);
    }
    setTrash(null);
  };

  const onMerge = async () => {
    const r = runRef.current;
    if (!r) return;
    await startJob("merge", () => window.vp.ml.merge({ runDir: r.runDir }));
  };

  const onTrain = async () => {
    await startJob("train", () => window.vp.ml.train());
  };

  const cancel = () => {
    if (jobIdRef.current) window.vp.ml.cancel(jobIdRef.current);
  };

  const logLines: LogLine[] = logs.map((l) => ({ level: l.level, line: l.line }));
  const good = sorted.filter((s) => s.label === "good");
  const bad = sorted.filter((s) => s.label === "bad");

  return (
    <div className="page">
      {/* ① 环境 */}
      <fieldset>
        <legend>① 运行环境</legend>
        {env && !env.ok && (
          <div className="banner captcha">
            ⚠️ Python 环境未就绪：
            {env.error ? `无法运行 ${env.pythonPath}（${env.error}）` : `缺少依赖：${env.missing.join(", ")}`}
          </div>
        )}
        {env && env.ok && env.dimMismatch && (
          <div className="banner captcha">
            ⚠️ backbone 维度({env.backboneDim})与已训练模型({env.modelDim})不一致，识图会报错。请把 backbone 改回与模型匹配的值。
          </div>
        )}
        {env && env.ok && !env.dimMismatch && env.backboneMismatch && (
          <div className="banner captcha">
            ⚠️ 当前 backbone「{settings?.backbone}」与模型训练时用的「{env.modelBackbone}」不一致。两者维度相同但特征空间不同，识图结果会是错的。请改回「{env.modelBackbone}」，或用当前 backbone 重训。
          </div>
        )}
        {env && env.ok && env.hasModel && !env.modelBackbone && (
          <p className="muted">提示：现有模型未记录训练 backbone，客户端只能比对维度、无法校验 backbone 身份。重训一次即可启用该校验。</p>
        )}
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>Python 路径（留空自动探测 python3/python）</label>
            <input
              value={settings?.pythonPath ?? ""}
              placeholder={env?.pythonPath || "python3"}
              onChange={(e) => patchSettings({ pythonPath: e.target.value })}
            />
          </div>
          <div className="field">
            <label>backbone</label>
            <select value={settings?.backbone ?? "siglip2-l"} onChange={(e) => patchSettings({ backbone: e.target.value })}>
              <option value="siglip2-l">siglip2-l（1024，当前模型）</option>
              <option value="clip-b32">clip-b32（512，旧）</option>
              <option value="dinov2-l">dinov2-l（1024）</option>
              <option value="siglip2-l+dinov2-l">siglip2-l+dinov2-l（2048）</option>
            </select>
          </div>
          <button className="ghost" disabled={detecting} onClick={detect}>{detecting ? "检测中…" : "检测环境"}</button>
        </div>
        {env && (
          <p className="muted">
            {env.ok ? `✅ 就绪 · Python ${env.pythonVersion}` : "❌ 未就绪"} ·{" "}
            {env.hasModel ? `模型 ${env.modelDim} 维` : "无模型"}
            {env.report?.cv_groupkfold_acc != null && ` · 分组CV acc ${env.report.cv_groupkfold_acc}`}
          </p>
        )}
      </fieldset>

      {/* ② 数据源 */}
      <fieldset>
        <legend>② 待判断图片</legend>
        <div className="row">
          <button className={`tab ${sourceTab === "xlsx" ? "active" : ""}`} onClick={() => setSourceTab("xlsx")}>从抓取结果 xlsx 提取</button>
          <button className={`tab ${sourceTab === "folder" ? "active" : ""}`} onClick={() => setSourceTab("folder")}>选本地文件夹</button>
        </div>
        {sourceTab === "xlsx" ? (
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>选择 xlsx</label>
              <select value={selectedXlsx} onChange={(e) => setSelectedXlsx(e.target.value)}>
                <option value="">— 选择 —</option>
                {xlsxFiles.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
              </select>
            </div>
            <div className="field"><label>前 N 条（0=全部）</label>
              <input type="number" value={settings?.maxNotes ?? 0} onChange={(e) => patchSettings({ maxNotes: Number(e.target.value) })} /></div>
            <div className="field"><label>每条取前几张</label>
              <input type="number" value={settings?.imgsPerNote ?? 2} onChange={(e) => patchSettings({ imgsPerNote: Number(e.target.value) })} /></div>
            <button className="ghost" disabled={!selectedXlsx || busy != null} onClick={onExtract}>提取图片</button>
          </div>
        ) : (
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>本地图片文件夹（输入）</label>
              <input value={folder} readOnly placeholder="点右侧选择…" />
            </div>
            <button className="ghost" onClick={onSelectFolder}>选择文件夹…</button>
          </div>
        )}
        {imagesDir && <p className="muted">输入目录：{imagesDir}</p>}
        {run && (
          <p className="muted">
            识图结果将分拣到：<strong>{run.runDir}</strong> 下的 <code>good/</code> 和 <code>bad/</code> 子目录
          </p>
        )}
        {!run && (folder || imagesDir) && (
          <p className="muted">点「开始识图」后自动创建带时间戳的输出目录，结果分入 good/ 和 bad/</p>
        )}
      </fieldset>

      {/* ③ 识图分拣 */}
      <fieldset>
        <legend>③ 识图分拣</legend>
        <div className="row">
          <div className="field">
            <label>阈值 P(good) ≥ {(settings?.threshold ?? 0.5).toFixed(2)}</label>
            <input type="range" min={0} max={1} step={0.05} value={settings?.threshold ?? 0.5}
              onChange={(e) => patchSettings({ threshold: Number(e.target.value) })} />
          </div>
          <button className="primary" disabled={busy != null || !env?.ok} onClick={onPredict}>
            {busy === "predict" ? "识别中…" : "开始识图"}
          </button>
          {busy && <button className="ghost" onClick={cancel}>取消</button>}
          <span className="muted">首次运行会下载/加载模型权重，冷启动较慢，请看下方日志。</span>
        </div>
        <LogPanel lines={logLines} height={180} />
      </fieldset>

      {/* ④ 纠错 */}
      {sorted.length > 0 && (
        <fieldset>
          <legend>④ 纠错（鼠标移到图片上：移到另一侧 / 放大 / 删除；边界图最值得纠）</legend>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            {([["good", good, shownGood, setShownGood], ["bad", bad, shownBad, setShownBad]] as const).map(
              ([label, items, shown, setShown]) => (
                <div key={label} style={{ flex: 1, minWidth: 0 }}>
                  <p className="muted">{label === "good" ? "✅ good" : "🚫 bad"}（{items.length}）</p>
                  <div className="mlgrid" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {items.slice(0, shown).map((img) => {
                      const boundary = img.pGood >= 0.4 && img.pGood <= 0.6;
                      const flashing = flashPaths[img.path] != null;
                      return (
                        <div
                          key={img.path}
                          className={`mlcell${flashing ? " flash" : ""}${boundary ? " boundary" : ""}`}
                          title={`P(good)=${img.pGood >= 0 ? img.pGood.toFixed(2) : "?"}`}
                          style={{
                            width: 88, position: "relative",
                            borderRadius: 6, overflow: "hidden", background: "#fff",
                          }}
                        >
                          <img src={img.url} style={{ width: "100%", height: 88, objectFit: "cover", display: "block" }} />
                          <div style={{ fontSize: 11, textAlign: "center", padding: "2px 0" }}>
                            {img.pGood >= 0 ? `${Math.round(img.pGood * 100)}%` : "?"}
                          </div>
                          <div className="mlcell-actions">
                            <button
                              title={label === "good" ? "移到 bad →" : "← 移到 good"}
                              onClick={() => onFlip(img)}
                            >
                              {label === "good" ? "→" : "←"}
                            </button>
                            <button title="放大查看" onClick={() => setLightbox(img)}>🔍</button>
                            <button title="删除（可撤销）" onClick={() => onRemove(img)}>✕</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {items.length > shown && (
                    <button
                      className="ghost"
                      style={{ marginTop: 8 }}
                      onClick={() => setShown((n) => n + PAGE_SIZE)}
                    >
                      加载更多（还剩 {items.length - shown}）
                    </button>
                  )}
                </div>
              ),
            )}
          </div>
        </fieldset>
      )}

      {/* 删除撤销浮条 */}
      {trash && (
        <div className="ml-undo">
          已删除 <code>{trash.img.name}</code>
          <button onClick={onUndoRemove}>撤销</button>
        </div>
      )}

      {/* 大图预览 */}
      {lightbox && (
        <div className="ml-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox.url} onClick={(e) => e.stopPropagation()} />
          <div className="ml-lightbox-meta">
            {lightbox.name} · P(good)={lightbox.pGood >= 0 ? lightbox.pGood.toFixed(2) : "?"} · {lightbox.label}
          </div>
        </div>
      )}

      {/* ⑤ 合并 + 重训 */}
      <fieldset>
        <legend>⑤ 合并纠错 → 重训</legend>
        <div className="row">
          <button className="ghost" disabled={busy != null || !run} onClick={onMerge}>{busy === "merge" ? "合并中…" : "合并进训练集"}</button>
          <button className="primary" disabled={busy != null || !env?.ok} onClick={onTrain}>{busy === "train" ? "训练中…" : "重新训练"}</button>
        </div>
        {report && (
          <p className="muted">
            最近训练：样本 {report.samples_dedup}（good {report.good_dedup} / bad {report.bad_dedup}）·{" "}
            分组CV acc <b>{report.cv_groupkfold_acc}</b> · 精确率 {report.cv_precision_good} · 召回 {report.cv_recall_good} ·{" "}
            F1 {report.cv_f1} · 误判 {report.n_errors}
            {report.confusion && ` · 混淆 TP${report.confusion.TP}/TN${report.confusion.TN}/FP${report.confusion.FP}/FN${report.confusion.FN}`}
          </p>
        )}
      </fieldset>
    </div>
  );
}

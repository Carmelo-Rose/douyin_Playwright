import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig, ScrapeLogEvent } from "../../electron/shared/ipc";
import ScrapeForm from "./pages/ScrapeForm";
import RunConsole from "./pages/RunConsole";
import Results from "./pages/Results";
import MlWorkbench from "./pages/MlWorkbench";

type Tab = "scrape" | "run" | "results" | "ml";

export default function App() {
  const [tab, setTab] = useState<Tab>("scrape");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [outputDir, setOutputDir] = useState("");

  const [logs, setLogs] = useState<ScrapeLogEvent[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [banner, setBanner] = useState<ScrapeLogEvent["status"] | null>(null);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    window.vp.getSettings().then((s) => {
      setConfig(s.config);
      setHasApiKey(s.hasApiKey);
      setOutputDir(s.outputDir);
    });
  }, []);

  useEffect(() => {
    return window.vp.onScrapeLog((e) => {
      if (e.runId !== runIdRef.current) return;
      setLogs((prev) => [...prev, e]);
      if (e.status) setBanner(e.status);
      if (e.status === "done") setRunning(false);
    });
  }, []);

  const start = useCallback(async (cfg: AppConfig) => {
    await window.vp.saveSettings(cfg);
    setLogs([]);
    setBanner(null);
    const { runId: id } = await window.vp.startScrape(cfg);
    runIdRef.current = id;
    setRunId(id);
    setRunning(true);
    setTab("run");
  }, []);

  const cancel = useCallback(async () => {
    const id = runIdRef.current;
    if (id) await window.vp.cancelScrape(id);
    setRunning(false);
  }, []);

  if (!config) return <div className="page">加载设置中…</div>;

  return (
    <div className="app">
      <div className="tabs">
        <button className={`tab ${tab === "scrape" ? "active" : ""}`} onClick={() => setTab("scrape")}>抓取设置</button>
        <button className={`tab ${tab === "run" ? "active" : ""}`} onClick={() => setTab("run")}>运行日志</button>
        <button className={`tab ${tab === "results" ? "active" : ""}`} onClick={() => setTab("results")}>结果浏览</button>
        <button className={`tab ${tab === "ml" ? "active" : ""}`} onClick={() => setTab("ml")}>ML 工作台</button>
      </div>

      {tab === "scrape" && (
        <ScrapeForm
          config={config}
          setConfig={setConfig}
          hasApiKey={hasApiKey}
          onApiKeyChange={async (k) => {
            await window.vp.setApiKey(k);
            setHasApiKey(await window.vp.hasApiKey());
          }}
          defaultOutputDir={outputDir}
          running={running}
          onStart={start}
        />
      )}
      {tab === "run" && (
        <RunConsole logs={logs} running={running} banner={banner} onCancel={cancel} outputDir={outputDir} />
      )}
      {tab === "results" && <Results outputDir={outputDir} />}
      {tab === "ml" && <MlWorkbench />}
    </div>
  );
}

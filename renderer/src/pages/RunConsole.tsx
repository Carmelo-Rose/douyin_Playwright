import { useEffect, useRef } from "react";
import type { ScrapeLogEvent } from "../../../electron/shared/ipc";

interface Props {
  logs: ScrapeLogEvent[];
  running: boolean;
  banner: ScrapeLogEvent["status"] | null;
  onCancel: () => void;
  outputDir: string;
}

const BANNER_TEXT: Record<NonNullable<ScrapeLogEvent["status"]>, string> = {
  "awaiting-login": "⚠️ 需要登录：请到弹出的 Chrome 窗口扫码登录，完成后会自动继续。",
  captcha: "⚠️ 出现验证码：请到 Chrome 窗口手动完成滑块验证，脚本会自动继续。",
  done: "✅ 本次抓取已结束，可到「结果浏览」查看导出文件。",
};

export default function RunConsole({ logs, running, banner, onCancel, outputDir }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView(); }, [logs]);

  return (
    <div className="page">
      {banner && <div className={`banner ${banner === "awaiting-login" ? "login" : banner}`}>{BANNER_TEXT[banner]}</div>}
      <div className="row">
        <button className="ghost" disabled={!running} onClick={onCancel}>取消</button>
        <span className="muted">输出目录：{outputDir}</span>
      </div>
      <div className="console">
        {logs.length === 0 && <div className="muted">尚无日志。点「开始抓取」后这里会实时显示进度。</div>}
        {logs.map((l, i) => (
          <div key={i} className={l.level === "error" ? "err" : l.level === "status" ? "status" : ""}>{l.line}</div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";

export interface LogLine {
  level: "info" | "error" | "status";
  line: string;
}

export default function LogPanel({ lines, height }: { lines: LogLine[]; height?: number }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView();
  }, [lines]);

  return (
    <div className="console" style={height ? { height } : undefined}>
      {lines.length === 0 && <div className="muted">暂无日志。</div>}
      {lines.map((l, i) => (
        <div key={i} className={l.level === "error" ? "err" : l.level === "status" ? "status" : ""}>
          {l.line}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

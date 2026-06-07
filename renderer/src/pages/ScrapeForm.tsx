import { useState } from "react";
import type { AppConfig } from "../../../electron/shared/ipc";

interface Props {
  config: AppConfig;
  setConfig: (c: AppConfig) => void;
  hasApiKey: boolean;
  onApiKeyChange: (key: string) => void;
  running: boolean;
  onStart: (config: AppConfig) => void;
}

export default function ScrapeForm({ config, setConfig, hasApiKey, onApiKeyChange, running, onStart }: Props) {
  const [apiKeyInput, setApiKeyInput] = useState("");

  function set<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setConfig({ ...config, [key]: value });
  }

  const num = (key: keyof AppConfig) => ({
    type: "number" as const,
    value: config[key] as number,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, Number(e.target.value) as AppConfig[typeof key]),
  });

  const bool = (key: keyof AppConfig) => ({
    type: "checkbox" as const,
    checked: config[key] as boolean,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.checked as AppConfig[typeof key]),
  });

  return (
    <div className="page">
      <fieldset>
        <legend>基础</legend>
        <div className="row">
          <div className="field">
            <label>平台</label>
            <select value={config.platform} onChange={(e) => set("platform", e.target.value as AppConfig["platform"])}>
              <option value="all">全部（抖音→小红书）</option>
              <option value="douyin">抖音</option>
              <option value="xhs">小红书</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>关键词</label>
            <input value={config.keyword} onChange={(e) => set("keyword", e.target.value)} />
          </div>
          <div className="field">
            <label>内容形式</label>
            <select value={config.contentType} onChange={(e) => set("contentType", e.target.value as AppConfig["contentType"])}>
              <option value="image">图文</option>
              <option value="video">视频</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>发布时间筛选</label>
            <select value={config.publishTime} onChange={(e) => set("publishTime", e.target.value as AppConfig["publishTime"])}>
              <option value="day">一天内</option>
              <option value="week">一周内</option>
              <option value="half-year">半年内</option>
              <option value="unlimited">不限</option>
            </select>
          </div>
          <div className="field">
            <label>小红书排序</label>
            <select value={config.sortBy} onChange={(e) => set("sortBy", e.target.value as AppConfig["sortBy"])}>
              <option value="latest">最新</option>
              <option value="comprehensive">综合</option>
            </select>
          </div>
          <div className="field">
            <label>仅导出最近N天（0=不限）</label>
            <input {...num("maxAgeDays")} />
          </div>
          <div className="field">
            <label>最大滚动次数</label>
            <input {...num("maxScrolls")} />
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>详情补图</legend>
        <div className="row">
          <label><input {...bool("enrichDouyinDetailImages")} /> 抖音补图</label>
          <label><input {...bool("enrichXhsDetailImages")} /> 小红书补图</label>
          <div className="field"><label>每次最多处理条数</label><input {...num("detailMaxItems")} /></div>
          <div className="field"><label>每条最多图片数</label><input {...num("detailImageLimit")} /></div>
          <div className="field"><label>最小间隔(ms)</label><input {...num("detailMinDelayMs")} /></div>
          <div className="field"><label>最大间隔(ms)</label><input {...num("detailMaxDelayMs")} /></div>
        </div>
      </fieldset>

      <fieldset>
        <legend>小红书视觉筛选（DashScope VLM）</legend>
        <div className="row">
          <label><input {...bool("xhsVisualFilter")} /> 启用视觉筛选</label>
          <div className="field"><label>最多判断条数（0=全部）</label><input {...num("xhsVisualMaxItems")} /></div>
          <div className="field"><label>每条取前N张</label><input {...num("xhsVisualMaxImages")} /></div>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>DashScope API Key {hasApiKey ? "（已保存，留空不改）" : "（未设置）"}</label>
            <div className="row" style={{ margin: 0 }}>
              <input
                type="password"
                style={{ flex: 1 }}
                placeholder={hasApiKey ? "••••••••" : "sk-..."}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
              <button className="ghost" onClick={() => { onApiKeyChange(apiKeyInput); setApiKeyInput(""); }}>保存密钥</button>
            </div>
          </div>
        </div>
      </fieldset>

      <div className="row">
        <button className="primary" disabled={running} onClick={() => onStart(config)}>
          {running ? "运行中…" : "开始抓取"}
        </button>
        <span className="muted">设置会自动保存；密钥加密存于系统钥匙串。</span>
      </div>
    </div>
  );
}

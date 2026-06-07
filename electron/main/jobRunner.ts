/**
 * 通用子进程任务：spawn + stdout/stderr 逐行流到 renderer + 取消。
 * ML 工作台的 extract/predict/merge/train 都走这里（fire-and-forget + 事件）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { WebContents } from "electron";
import type { MlLogEvent } from "../shared/ipc.js";

const jobs = new Map<string, ChildProcess>();

export interface RunJobOptions {
  jobId: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  sender: WebContents;
  channel: string;
}

export function runJob(opts: RunJobOptions): ChildProcess {
  const { jobId, command, args, cwd, env, sender, channel } = opts;
  const child = spawn(command, args, { cwd, env });
  jobs.set(jobId, child);

  const send = (level: MlLogEvent["level"], line: string, extra?: Partial<MlLogEvent>) => {
    const payload: MlLogEvent = { jobId, level, line, ...extra };
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };

  const wire = (stream: NodeJS.ReadableStream | null, level: "info" | "error") => {
    let buf = "";
    stream?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (line.trim()) send(level, line);
      }
    });
  };
  wire(child.stdout, "info");
  wire(child.stderr, "error");

  child.on("error", (e) => send("error", `[spawn error] ${e.message}`, { done: true, code: null }));
  child.on("exit", (code) => {
    jobs.delete(jobId);
    send("status", code === 0 ? "[done] 完成" : `[done] 退出 code=${code}`, { done: true, code });
  });

  return child;
}

export function cancelJob(jobId: string): boolean {
  const child = jobs.get(jobId);
  if (child) {
    child.kill();
    jobs.delete(jobId);
    return true;
  }
  return false;
}

export function killAllJobs(): void {
  for (const child of jobs.values()) child.kill();
  jobs.clear();
}

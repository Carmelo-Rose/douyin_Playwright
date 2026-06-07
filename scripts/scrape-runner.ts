/**
 * 抓取子进程入口。
 *
 * 由主进程 fork：`fork(out/main/runner.js, ["--config", "<json路径>"])`。
 * 读入一份完整的 AppConfig（由桌面 UI 生成并持久化），按平台调用现有抓取函数。
 * 进度通过 console.log 输出到 stdout，由主进程逐行转发给 renderer 的日志面板。
 *
 * 不改动 src/ 下任何抓取逻辑——纯复用。
 */
import process from "node:process";
import { readFileSync } from "node:fs";
import type { AppConfig } from "../src/config.js";
import { withPlatform } from "../src/config.js";
import { captureDouyin } from "../src/platforms/douyin/capture.js";
import { captureXhs } from "../src/platforms/xhs/capture.js";

function readConfigArg(): AppConfig {
  const idx = process.argv.indexOf("--config");
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error("scrape-runner 缺少 --config <jsonPath> 参数");
  }
  const raw = readFileSync(process.argv[idx + 1], "utf-8");
  return JSON.parse(raw) as AppConfig;
}

async function main(): Promise<void> {
  const config = readConfigArg();

  if (config.platform === "xhs") {
    await captureXhs(config);
    return;
  }
  if (config.platform === "douyin") {
    await captureDouyin(config);
    return;
  }

  console.log("Platform: all (douyin -> xhs)");
  await captureDouyin(withPlatform(config, "douyin"));
  await captureXhs(withPlatform(config, "xhs"));
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });

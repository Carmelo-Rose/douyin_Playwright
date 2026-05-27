import process from "node:process";
import { loadConfig, withPlatform } from "./config.js";
import { captureDouyin } from "./platforms/douyin/capture.js";
import { captureXhs } from "./platforms/xhs/capture.js";

async function main(): Promise<void> {
  const config = loadConfig();

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
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

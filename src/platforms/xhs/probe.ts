import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Response } from "playwright";
import { openBrowserSession } from "../../browser.js";
import { loadConfig } from "../../config.js";
import { writeDebugDump } from "../../shared/debugDump.js";
import { waitForXhsLogin } from "./login.js";
import { applyXhsSearchFilters, openXhsSearch } from "./capture.js";

const MAX_DUMPS = 20;
const INTERESTING_URL_PARTS = [
  "/api/sns/web/v1/search/",
  "/api/sns/web/v1/homefeed",
  "/api/sns/web/v1/feed",
  "/api/sns/web/v1/note",
];

async function main(): Promise<void> {
  const config = loadConfig({ defaultPlatform: "xhs" });
  const { context, page } = await openBrowserSession(config);
  const responseTasks: Promise<void>[] = [];
  const seenUrls = new Set<string>();
  let dumpsWritten = 0;

  const handler = (response: Response): void => {
    if (!shouldDumpResponse(response) || seenUrls.has(response.url()) || dumpsWritten >= MAX_DUMPS) {
      return;
    }
    seenUrls.add(response.url());
    dumpsWritten += 1;
    const dumpIndex = dumpsWritten;

    responseTasks.push(
      response.json()
        .then((body) => writeDebugDump(config.outputDir, "xhs", dumpIndex, response.url(), body))
        .then((filepath) => console.log(`[xhs:probe] dumped ${dumpIndex}: ${filepath}`))
        .catch(() => {
          // Non-JSON or unreadable responses are expected during probing.
        }),
    );
  };

  page.on("response", handler);
  try {
    console.log("Platform: xhs probe");
    console.log(`Keyword: ${config.keyword}`);
    await waitForXhsLogin(page, { humanLike: config.humanLike });
    await openXhsSearch(page, config.keyword);
    await applyXhsSearchFilters(page, config.contentType, config.publishTime, config.sortBy);

    for (let index = 0; index < config.maxScrolls; index += 1) {
      await page.mouse.wheel(0, config.humanLike ? 1200 : 1800);
      await page.waitForTimeout(config.humanLike ? 2_000 : 1_200);
    }

    await page.waitForTimeout(config.captureTimeoutMs);
  } finally {
    page.off("response", handler);
    await Promise.allSettled(responseTasks);
    console.log(`[xhs:probe] dumped ${dumpsWritten} response(s).`);
    await context.close();
  }
}

function shouldDumpResponse(response: Response): boolean {
  if (!["xhr", "fetch"].includes(response.request().resourceType())) {
    return false;
  }
  if (response.status() < 200 || response.status() >= 300) {
    return false;
  }

  const url = response.url().toLowerCase();
  return INTERESTING_URL_PARTS.some((part) => url.includes(part));
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

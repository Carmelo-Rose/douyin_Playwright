import process from "node:process";
import { openBrowserSession } from "./browser.js";
import { buildSearchUrl, loadConfig } from "./config.js";
import { collectProductsFromDom } from "./domFallback.js";
import { exportProductsToXlsx } from "./exportXlsx.js";
import { dedupeProducts } from "./normalize.js";
import { attachNetworkCapture } from "./networkCapture.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const searchUrl = buildSearchUrl(config);
  const { context, page } = await openBrowserSession(config);
  const getNetworkProducts = attachNetworkCapture(page);

  try {
    console.log(`Keyword: ${config.keyword}`);
    console.log(`Opening: ${searchUrl}`);
    console.log("If this is the first run, log in manually in the opened browser window.");

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_000);

    for (let index = 0; index < config.maxScrolls; index += 1) {
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(1_500);
    }

    await page.waitForTimeout(config.captureTimeoutMs);

    const networkProducts = getNetworkProducts();
    const domProducts = networkProducts.length > 0 ? [] : await collectProductsFromDom(page);
    const products = dedupeProducts([...networkProducts, ...domProducts]);

    if (products.length === 0) {
      console.warn("No product records were recognized. Check SEARCH_URL_TEMPLATE or update selectors/parsers for the current Douyin page.");
      return;
    }

    const outputPath = await exportProductsToXlsx(products, config.outputDir, config.keyword);
    console.log(`Exported ${products.length} products to ${outputPath}`);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import fs from "fs-extra";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Page } from "playwright";
import type { AppConfig } from "./config.js";

chromiumExtra.use(StealthPlugin());

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export async function openBrowserSession(config: AppConfig): Promise<BrowserSession> {
  await fs.ensureDir(config.userDataDir);

  const launchOptions: Parameters<typeof chromiumExtra.launchPersistentContext>[1] = {
    headless: config.headless,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent: config.userAgent,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  };

  if (config.browserChannel) {
    launchOptions.channel = config.browserChannel;
  }

  let context: BrowserContext;
  try {
    context = await chromiumExtra.launchPersistentContext(config.userDataDir, launchOptions);
  } catch (error) {
    if (config.browserChannel) {
      console.warn(
        `Failed to launch with channel="${config.browserChannel}" (${(error as Error).message}). Falling back to bundled Chromium.`,
      );
      delete launchOptions.channel;
      context = await chromiumExtra.launchPersistentContext(config.userDataDir, launchOptions);
    } else {
      throw error;
    }
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-expect-error - extending window.chrome for fingerprint parity
    if (!window.chrome) window.chrome = { runtime: {} };
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30_000);

  return { context, page };
}

import fs from "fs-extra";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.js";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export async function openBrowserSession(config: AppConfig): Promise<BrowserSession> {
  await fs.ensureDir(config.userDataDir);

  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30_000);

  return { context, page };
}

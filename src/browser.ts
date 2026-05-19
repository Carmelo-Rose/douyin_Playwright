import fs from "fs-extra";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Page } from "playwright";
import type { AppConfig } from "./config.js";
import { randomBetween, sleep } from "./human.js";

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

export async function waitForLogin(
  page: Page,
  opts: { timeoutMs?: number; pollMs?: number; humanLike?: boolean } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 2_000;
  const humanLike = opts.humanLike ?? true;

  await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });

  if (humanLike) {
    await sleep(randomBetween(2_000, 5_000));
    await page.mouse.move(randomBetween(200, 800), randomBetween(200, 600), { steps: 8 });
  }

  if (await isLoggedIn(page)) {
    console.log("Detected existing Douyin login.");
    return;
  }

  console.log("请在弹出的浏览器中完成抖音登录，登录成功后脚本会自动继续...");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    if (await isLoggedIn(page)) {
      console.log("Login detected. Continuing.");
      return;
    }
  }

  throw new Error(`Login not completed within ${Math.round(timeoutMs / 1000)}s. Aborting.`);
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const cookies = await page.context().cookies("https://www.douyin.com");
    const hasSession = cookies.some((c) => (c.name === "sessionid" || c.name === "sessionid_ss") && c.value);
    if (hasSession) {
      return true;
    }
  } catch {
    // ignore cookie read errors
  }

  try {
    const loginButton = await page.$('[data-e2e="login-button"], [data-e2e="header-login-entrance"]');
    if (loginButton && (await loginButton.isVisible().catch(() => false))) {
      return false;
    }
    const loginText = await page.getByText("登录", { exact: true }).first().isVisible({ timeout: 500 }).catch(() => false);
    if (loginText) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

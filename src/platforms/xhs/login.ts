import type { Page } from "playwright";
import { randomBetween, sleep } from "../../human.js";

const XHS_HOME = "https://www.xiaohongshu.com";

export async function waitForXhsLogin(
  page: Page,
  opts: { timeoutMs?: number; pollMs?: number; humanLike?: boolean } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 2_000;
  const humanLike = opts.humanLike ?? true;

  await page.goto(XHS_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });

  if (humanLike) {
    await sleep(randomBetween(2_000, 5_000));
    await page.mouse.move(randomBetween(200, 800), randomBetween(200, 600), { steps: 8 });
  }

  if (await isXhsLoggedIn(page)) {
    console.log("Detected existing Xiaohongshu login.");
    return;
  }

  console.log("请在弹出的浏览器中完成小红书登录，登录成功后脚本会自动继续...");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    if (await isXhsLoggedIn(page)) {
      console.log("Xiaohongshu login detected. Continuing.");
      return;
    }
  }

  throw new Error(`Xiaohongshu login not completed within ${Math.round(timeoutMs / 1000)}s. Aborting.`);
}

async function isXhsLoggedIn(page: Page): Promise<boolean> {
  try {
    const cookies = await page.context().cookies(XHS_HOME);
    const hasSession = cookies.some((c) => ["web_session", "webId", "gid"].includes(c.name) && c.value);
    if (hasSession) {
      const loginVisible = await hasVisibleLoginText(page);
      return !loginVisible;
    }
  } catch {
    // Fall through to DOM check.
  }

  return !(await hasVisibleLoginText(page));
}

async function hasVisibleLoginText(page: Page): Promise<boolean> {
  const selectors = [
    "text=登录",
    "text=登陆",
    "[class*=login]",
    "[id*=login]",
  ];

  for (const selector of selectors) {
    try {
      const visible = await page.locator(selector).first().isVisible({ timeout: 500 });
      if (visible) {
        return true;
      }
    } catch {
      // try next selector
    }
  }

  return false;
}

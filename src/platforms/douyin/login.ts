import type { Page } from "playwright";
import { randomBetween, sleep } from "../../human.js";

export async function waitForDouyinLogin(
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

  if (await isDouyinLoggedIn(page)) {
    console.log("Detected existing Douyin login.");
    return;
  }

  console.log("请在弹出的浏览器中完成抖音登录，登录成功后脚本会自动继续...");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    if (await isDouyinLoggedIn(page)) {
      console.log("Login detected. Continuing.");
      return;
    }
  }

  throw new Error(`Login not completed within ${Math.round(timeoutMs / 1000)}s. Aborting.`);
}

async function isDouyinLoggedIn(page: Page): Promise<boolean> {
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

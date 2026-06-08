import type { Page } from "playwright";
import { exportVideosToXlsx } from "../../exportXlsx.js";
import { humanScroll, maybeReadingPause, randomBetween, sleep } from "../../human.js";
import type { ContentType, PublishTimeFilter, VideoRecord } from "../../types.js";
import type { AppConfig } from "../../config.js";
import { openBrowserSession } from "../../browser.js";
import { attachNetworkCapture, type NetworkCaptureHandle } from "./networkCapture.js";
import { dedupeVideos } from "./normalize.js";
import { waitForDouyinLogin } from "./login.js";
import { enrichDouyinDetailImages } from "./detailImages.js";
import { classifyRecordsVisual } from "../../shared/visualClassifier.js";
import { loadSeenIds, saveSeenIds } from "../../seenIds.js";

const JINGXUAN_HOME = "https://www.douyin.com/jingxuan";
const ROOT_SEARCH_AID = "31f360ee-d884-44a8-ab0b-34086c05f4fa";

export async function captureDouyin(config: AppConfig): Promise<void> {
  const { context, page } = await openBrowserSession(config);
  const capture = attachNetworkCapture(page, { contentType: config.contentType });

  try {
    console.log(`Platform: douyin`);
    console.log(`Keyword: ${config.keyword}`);

    await waitForDouyinLogin(page, { humanLike: config.humanLike });

    if (config.humanLike) {
      await sleep(randomBetween(2_000, 5_000));
    }

    const allVideos = [
      ...(await captureJingxuan(page, capture, config)),
      ...(await captureRootSearch(page, capture, config)),
    ];

    const seenIds = loadSeenIds(config.outputDir, "douyin", config.keyword);
    const dedupedAll = dedupeVideos(allVideos);
    const newVideos = dedupedAll.filter((v) => !seenIds.has(v.awemeId));
    console.log(`[seenIds] 已见过 ${seenIds.size} 条，本次新抓 ${newVideos.length}/${dedupedAll.length} 条（过滤重复 ${dedupedAll.length - newVideos.length} 条）`);

    const videos = filterByRelevance(
      filterByMaxAgeDays(newVideos, config.maxAgeDays),
      config.relevanceKeywords,
    );

    if (videos.length === 0) {
      const rawCount = allVideos.length;
      const dedupedCount = dedupedAll.length;
      const newCount = newVideos.length;
      const afterAge = filterByMaxAgeDays(newVideos, config.maxAgeDays).length;
      console.warn(
        `[douyin] 无可导出内容。raw=${rawCount} → 去重=${dedupedCount} → 新增=${newCount} → maxAgeDays(${config.maxAgeDays}天)=${afterAge} → 相关性过滤后=0。` +
        `\n建议：放宽 publishTime（当前=${config.publishTime}）或减小 maxAgeDays（当前=${config.maxAgeDays}），或开 DEBUG_CAPTURE=true 查看 output/debug-douyin-*.json。`,
      );
      return;
    }

    const enrichedVideos = await enrichDouyinDetailImages(page, videos, config);
    const scoredVideos = await classifyRecordsVisual(enrichedVideos, config, "douyin");
    const outputPath = await exportVideosToXlsx(scoredVideos, config.outputDir, config.keyword, config.contentType);
    console.log(`Exported ${scoredVideos.length} videos to ${outputPath}`);

    // 把本次导出的 ID 写入缓存，供下次运行去重
    saveSeenIds(config.outputDir, "douyin", config.keyword, scoredVideos.map((v) => v.awemeId));
  } finally {
    await context.close();
  }
}

async function captureJingxuan(page: Page, capture: NetworkCaptureHandle, config: AppConfig): Promise<VideoRecord[]> {
  console.log(`Opening 精选 home: ${JINGXUAN_HOME}`);
  await page.goto(JINGXUAN_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(config.humanLike ? randomBetween(2_500, 5_000) : 3_000);
  await waitIfCaptcha(page);

  capture.reset();
  const submitted = await searchOnJingxuan(page, config.keyword);
  if (!submitted) {
    console.warn("Could not find/use the search input on /jingxuan/. Skipping jingxuan source.");
    return [];
  }

  await applySearchFilters(page, config.contentType, config.publishTime);
  await collectByScrolling(page, config);
  await capture.flush();
  const videos = withSource(capture.getVideos(), "jingxuan");
  console.log(`Captured ${videos.length} raw videos from jingxuan. URL: ${page.url()}`);
  return videos;
}

async function captureRootSearch(page: Page, capture: NetworkCaptureHandle, config: AppConfig): Promise<VideoRecord[]> {
  const url = buildRootSearchUrl(config.keyword);
  console.log(`Opening 综合搜索: ${url}`);
  capture.reset();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await applySearchFilters(page, config.contentType, config.publishTime);
  await collectByScrolling(page, config);
  await capture.flush();
  const videos = withSource(capture.getVideos(), "root_search");
  console.log(`Captured ${videos.length} raw videos from root_search. URL: ${page.url()}`);
  return videos;
}

async function collectByScrolling(page: Page, config: AppConfig): Promise<void> {
  await page.waitForTimeout(3_000);
  console.log(`Search URL: ${page.url()}`);

  for (let index = 0; index < config.maxScrolls; index += 1) {
    await waitIfCaptcha(page);
    if (config.humanLike) {
      await humanScroll(page);
      await maybeReadingPause();
    } else {
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(1_500);
    }
  }

  await waitIfCaptcha(page);
  await page.waitForTimeout(config.captureTimeoutMs);
}

function buildRootSearchUrl(keyword: string): string {
  return `https://www.douyin.com/root/search/${encodeURIComponent(keyword)}?aid=${ROOT_SEARCH_AID}&type=general`;
}

async function applySearchFilters(page: Page, contentType: ContentType, publishTime: PublishTimeFilter): Promise<void> {
  await page.waitForTimeout(1_500);
  await waitIfCaptcha(page);

  const opened = await hoverVisibleText(page, ["筛选"], 3_000);
  if (!opened) {
    console.warn("Could not open search filter panel. Continuing with post-capture age filtering only.");
    return;
  }

  await page.waitForTimeout(1_000);

  const latest = await clickVisibleText(page, ["最新发布"], 2_000);
  const publishTimeLabel = resolvePublishTimeLabel(publishTime);
  const time = await clickVisibleText(page, [publishTimeLabel], 2_000);
  const contentLabel = contentType === "image" ? "图文" : "视频";
  const content = await clickVisibleText(page, [contentLabel], 2_000);

  if (!latest || !time || !content) {
    console.warn(`Search filter partially applied: 最新发布=${latest}, ${publishTimeLabel}=${time}, ${contentLabel}=${content}.`);
  } else {
    console.log(`Applied search filters: 最新发布 / ${publishTimeLabel} / ${contentLabel}.`);
  }

  await page.waitForTimeout(2_000);
  await waitIfCaptcha(page);
}

function resolvePublishTimeLabel(publishTime: PublishTimeFilter): string {
  if (publishTime === "day") return "一天内";
  if (publishTime === "half-year") return "半年内";
  if (publishTime === "unlimited") return "不限";
  return "一周内";
}

async function hoverVisibleText(page: Page, texts: string[], timeoutMs: number): Promise<boolean> {
  for (const text of texts) {
    const locators = [
      page.getByText(text, { exact: true }),
      page.locator(`text=${text}`),
    ];

    for (const locator of locators) {
      try {
        const target = locator.first();
        if (await target.isVisible({ timeout: timeoutMs })) {
          await target.hover({ timeout: timeoutMs });
          return true;
        }
      } catch {
        // try next locator
      }
    }
  }

  return false;
}

async function clickVisibleText(page: Page, texts: string[], timeoutMs: number): Promise<boolean> {
  for (const text of texts) {
    const locators = [
      page.getByText(text, { exact: true }),
      page.locator(`text=${text}`),
    ];

    for (const locator of locators) {
      try {
        const target = locator.first();
        if (await target.isVisible({ timeout: timeoutMs })) {
          await target.click({ timeout: timeoutMs });
          return true;
        }
      } catch {
        // try next
      }
    }
  }

  return false;
}

function withSource(videos: VideoRecord[], source: string): VideoRecord[] {
  return videos.map((video) => ({ ...video, source }));
}

function filterByMaxAgeDays(videos: VideoRecord[], maxAgeDays: number): VideoRecord[] {
  if (maxAgeDays <= 0) {
    return videos;
  }

  const minTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const filtered = videos.filter((video) => {
    const createdAt = Date.parse(video.createTime);
    return Number.isFinite(createdAt) && createdAt >= minTime;
  });

  console.log(`Kept ${filtered.length}/${videos.length} videos from the last ${maxAgeDays} days.`);
  return filtered;
}

function filterByRelevance(videos: VideoRecord[], keywords: string[]): VideoRecord[] {
  const normalizedKeywords = keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
  if (normalizedKeywords.length === 0) {
    return videos;
  }

  const filtered = videos.filter((video) => {
    const haystack = [video.desc, video.authorName, video.shareUrl].join(" ").toLowerCase();
    return normalizedKeywords.some((keyword) => haystack.includes(keyword));
  });

  console.log(`Kept ${filtered.length}/${videos.length} videos matching relevance keywords: ${keywords.join(", ")}.`);
  return filtered;
}

async function searchOnJingxuan(page: Page, keyword: string): Promise<boolean> {
  const selectors = [
    'input[placeholder*="搜索"]',
    'input[placeholder*="搜"]',
    'input[type="search"]',
    '[data-e2e*="search-input"] input',
    '[data-e2e*="searchbox"] input',
    '[class*="search"] input',
  ];

  for (const sel of selectors) {
    const input = page.locator(sel).first();
    try {
      if (await input.isVisible({ timeout: 1_500 })) {
        await input.click({ timeout: 2_000 });
        await input.fill("");
        await input.fill(keyword);
        console.log(`Filled search input via selector: ${sel}`);
        await input.press("Enter");
        return true;
      }
    } catch {
      // try next
    }
  }

  try {
    const ok = await page.evaluate((kw: string) => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
      const target = inputs.find((el) => {
        if (el.offsetParent === null) return false;
        const ph = (el.placeholder || "").toLowerCase();
        const lbl = (el.getAttribute("aria-label") || "").toLowerCase();
        return ph.includes("搜") || lbl.includes("搜") || el.type === "search";
      });
      if (!target) return false;
      target.focus();
      target.value = kw;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    }, keyword);
    if (ok) {
      console.log("Filled search input via JS scan fallback");
      await page.keyboard.press("Enter");
      return true;
    }
  } catch {
    // fall through
  }

  return false;
}

async function waitIfCaptcha(page: Page): Promise<void> {
  const captchaSelector = '[id*="captcha"], [class*="captcha"], [class*="verify-wrap"], [class*="verifyWrap"], iframe[src*="captcha"]';
  const visible = await page
    .locator(captchaSelector)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (!visible) {
    return;
  }
  console.log("检测到滑块/验证码，请在浏览器中手动完成验证，脚本会自动继续...");
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const still = await page
      .locator(captchaSelector)
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (!still) {
      console.log("验证已完成，继续。");
      return;
    }
  }
  throw new Error("Captcha not solved within 5 minutes.");
}

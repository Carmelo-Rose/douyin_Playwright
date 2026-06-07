import type { Locator, Page } from "playwright";
import { openBrowserSession } from "../../browser.js";
import type { AppConfig } from "../../config.js";
import { exportNotesToXlsx } from "../../exportXlsx.js";
import { humanScroll, maybeReadingPause, randomBetween, sleep } from "../../human.js";
import type { ContentType, NoteRecord, PublishTimeFilter, SearchSort } from "../../types.js";
import { waitForXhsLogin } from "./login.js";
import { attachXhsNetworkCapture, type XhsNetworkCaptureHandle } from "./networkCapture.js";
import { dedupeNotes, formatCreateTimeFromNoteId, resolveXhsDisplayDateStable } from "./normalize.js";
import { enrichXhsDetailImages } from "./detailImages.js";
import { scoreXhsVisualQuality } from "./visualFilter.js";
import { loadSeenIds, saveSeenIds } from "../../seenIds.js";

const XHS_SEARCH_URL = "https://www.xiaohongshu.com/search_result";
const XHS_TEXT = {
  filter: "\u7b5b\u9009",
  filtered: "\u5df2\u7b5b\u9009",
  comprehensive: "\u7efc\u5408",
  latest: "\u6700\u65b0",
  video: "\u89c6\u9891",
  image: "\u56fe\u6587",
  day: "\u4e00\u5929\u5185",
  week: "\u4e00\u5468\u5185",
  halfYear: "\u534a\u5e74\u5185",
  unlimited: "\u4e0d\u9650",
  collapse: "\u6536\u8d77",
};
const XHS_PANEL_TEXT = {
  sortBy: "\u6392\u5e8f\u4f9d\u636e",
  noteType: "\u7b14\u8bb0\u7c7b\u578b",
  publishTime: "\u53d1\u5e03\u65f6\u95f4",
  mostCollect: "\u6700\u591a\u6536\u85cf",
};
const XHS_PANEL_MARKERS_STABLE = [
  XHS_PANEL_TEXT.sortBy,
  XHS_PANEL_TEXT.noteType,
  XHS_PANEL_TEXT.publishTime,
  XHS_PANEL_TEXT.mostCollect,
];

export async function captureXhs(config: AppConfig): Promise<void> {
  const { context, page } = await openBrowserSession(config);
  const capture = attachXhsNetworkCapture(page);

  try {
    console.log("Platform: xhs");
    console.log(`Keyword: ${config.keyword}`);
    await waitForXhsLogin(page, { humanLike: config.humanLike });

    if (config.humanLike) {
      await sleep(randomBetween(2_000, 5_000));
    }

    const notes = await captureXhsSearch(page, capture, config);
    const uniqueNotes = dedupeNotes(notes);

    const seenIds = loadSeenIds(config.outputDir, "xhs", config.keyword);
    const newNotes = uniqueNotes.filter((n) => !seenIds.has(n.noteId));
    console.log(`[seenIds] 已见过 ${seenIds.size} 条，本次新抓 ${newNotes.length}/${uniqueNotes.length} 条（过滤重复 ${uniqueNotes.length - newNotes.length} 条）`);

    const typedNotes = filterNotesByContentType(newNotes, config.contentType);
    const recentNotes = filterByMaxAgeDays(typedNotes, config.maxAgeDays);
    const deduped = filterByRelevance(recentNotes, config.relevanceKeywords);

    if (deduped.length === 0) {
      console.warn(
        `No Xiaohongshu notes left to export. raw=${notes.length}, deduped=${uniqueNotes.length}, new=${newNotes.length}, ${config.contentType}=${typedNotes.length}, recent=${recentNotes.length}, relevant=${deduped.length}.`,
      );
      if (notes.length === 0) {
        console.warn("No Xiaohongshu note records were recognized from network responses. Run DEBUG_CAPTURE=true npm run probe:xhs to inspect output/debug-xhs-*.json.");
      }
      return;
    }

    const enrichedNotes = await enrichXhsDetailImages(page, deduped, config);
    const scoredNotes = await scoreXhsVisualQuality(enrichedNotes, config);
    const outputPath = await exportNotesToXlsx(scoredNotes, config.outputDir, config.keyword);
    console.log(`Exported ${scoredNotes.length} notes to ${outputPath}`);

    // 把本次导出的 ID 写入缓存，供下次运行去重
    saveSeenIds(config.outputDir, "xhs", config.keyword, scoredNotes.map((n) => n.noteId));
  } finally {
    await context.close();
  }
}

async function captureXhsSearch(page: Page, capture: XhsNetworkCaptureHandle, config: AppConfig): Promise<NoteRecord[]> {
  capture.reset();
  await openXhsSearch(page, config.keyword);
  await applyXhsSearchFiltersStable(page, config.contentType, config.publishTime, config.sortBy);
  await collectByScrolling(page, config);
  const networkNotes = capture.getNotes().map((note) => ({ ...note, source: "xhs_search" }));
  // DOM 笔记的 createTime 此时是"原始日期文案"（如 "04-03" / "553天前" / ""）。
  // 在 Node 侧换算成标准时间；换算不出再用 noteId(ObjectId) 兜底；都不行才留空。
  const domNotes = (await scrapeVisibleXhsNotes(page, config.contentType)).map((note) => ({
    ...note,
    authorName: isClockOnlyText(note.authorName) ? "" : note.authorName,
    createTime: formatCreateTimeFromNoteId(note.noteId) || resolveXhsDisplayDateStable(note.createTime),
  }));
  const notes = [...networkNotes, ...domNotes];
  console.log(`Captured ${networkNotes.length} network notes and ${domNotes.length} visible page notes from xhs_search. URL: ${page.url()}`);
  return notes;
}

async function applyXhsSearchFiltersStable(
  page: Page,
  contentType: ContentType,
  publishTime: PublishTimeFilter,
  sortBy: SearchSort,
): Promise<void> {
  await page.waitForTimeout(1_500);
  await waitIfCaptcha(page);

  // 真实结构（已对照页面截图确认）：右上角「筛选/已筛选」按钮展开一个面板，
  // 面板内分区块：排序依据(综合/最新/...) / 笔记类型(不限/视频/图文) /
  // 发布时间(不限/一天内/一周内/半年内) / 搜索范围 / 位置距离。
  // 三项都在同一面板里、可同时选中，所以开一次面板、依次点即可。
  // 顶部那排"综合/鸭舌帽/..."是分类标签，不能拿来当排序，必须只在面板内点。
  const opened = await openXhsFilterPanel(page);
  if (!opened) {
    console.warn("Could not open Xiaohongshu filter panel. Continuing with local export filters.");
    await logVisibleFilterCandidates(page);
    return;
  }

  // 面板展开有动画，等它稳定再点。
  await page.waitForTimeout(randomBetween(800, 1_500));

  await waitIfCaptcha(page);
  if (!(await isXhsFilterPanelOpen(page))) {
    await openXhsFilterPanel(page);
  }

  const sortLabel = sortBy === "comprehensive" ? XHS_TEXT.comprehensive : XHS_TEXT.latest;
  const sort = await clickXhsPanelOption(page, XHS_PANEL_TEXT.sortBy, sortLabel);
  const contentLabel = contentType === "image" ? XHS_TEXT.image : XHS_TEXT.video;
  const content = await clickXhsPanelOption(page, XHS_PANEL_TEXT.noteType, contentLabel);
  const publishTimeLabel = resolveXhsPublishTimeLabel(publishTime);
  const time = await clickXhsPanelOption(page, XHS_PANEL_TEXT.publishTime, publishTimeLabel);

  if (!sort || !content || !time) {
    console.warn(`Xiaohongshu filters partially applied: ${sortBy}=${sort}, ${contentType}=${content}, ${publishTime}=${time}.`);
    await logVisibleFilterCandidates(page);
  } else {
    console.log(`Applied Xiaohongshu filters: ${sortBy} / ${contentType} / ${publishTime}.`);
  }

  const closed = await clickVisibleText(page, [XHS_TEXT.collapse], 1_500);
  if (!closed) {
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  await page.waitForTimeout(randomBetween(2_000, 4_000));
  await waitIfCaptcha(page);
}

async function openXhsFilterPanel(page: Page): Promise<boolean> {
  if (await isXhsFilterPanelOpen(page)) {
    return true;
  }

  // 当前小红书搜索页的筛选面板是 hover 展开，click 反而可能不生效。
  if (await hoverXhsFilterTrigger(page)) {
    return true;
  }

  // click 只保留做兜底，兼容后续 UI 又改回点击展开的情况。
  if (await clickXhsFilterTrigger(page)) {
    return true;
  }

  return hoverXhsFilterTrigger(page);
}

async function isXhsFilterPanelOpen(page: Page): Promise<boolean> {
  if (await page.locator(".filter-panel").first().isVisible({ timeout: 300 }).catch(() => false)) {
    return true;
  }

  return isAnyTextVisible(page, XHS_PANEL_MARKERS_STABLE);
}

async function waitForXhsFilterPanelOpen(page: Page, timeoutMs = 1_800): Promise<boolean> {
  if (await isXhsFilterPanelOpen(page)) {
    return true;
  }

  try {
    await page.waitForFunction(
      (markers: string[]) => markers.every((marker) => document.body.innerText.includes(marker)),
      [XHS_PANEL_TEXT.sortBy, XHS_PANEL_TEXT.publishTime],
      { timeout: timeoutMs },
    );
  } catch {
    // fall through to final visibility check
  }

  return isXhsFilterPanelOpen(page);
}

async function hoverXhsFilterTrigger(page: Page): Promise<boolean> {
  for (const locator of getXhsFilterTriggerCandidates(page)) {
    try {
      if (!(await locator.isVisible({ timeout: 700 }))) {
        continue;
      }

      await locator.hover({ timeout: 1_500, force: true });
      if (await waitForXhsFilterPanelOpen(page)) {
        return true;
      }

      const box = await locator.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: randomBetween(4, 9) });
        if (await waitForXhsFilterPanelOpen(page)) {
          return true;
        }
      }
    } catch {
      // try next candidate
    }
  }

  return false;
}

function getXhsFilterTriggerCandidates(page: Page): Locator[] {
  return [
    page.locator(".search-layout__top .filter").first(),
    page.locator(".search-layout .filter").filter({ hasText: XHS_TEXT.filter }).first(),
    page.locator(".search-layout .filter").filter({ hasText: XHS_TEXT.filtered }).first(),
    page.locator("div.filter").filter({ hasText: XHS_TEXT.filter }).first(),
    page.locator("div.filter").filter({ hasText: XHS_TEXT.filtered }).first(),
    page
      .getByText(XHS_TEXT.filter, { exact: true })
      .locator("xpath=ancestor-or-self::*[contains(concat(' ', normalize-space(@class), ' '), ' filter ')][1]")
      .first(),
    page
      .getByText(XHS_TEXT.filtered, { exact: true })
      .locator("xpath=ancestor-or-self::*[contains(concat(' ', normalize-space(@class), ' '), ' filter ')][1]")
      .first(),
    page.getByText(XHS_TEXT.filter, { exact: true }).first(),
    page.getByText(XHS_TEXT.filtered, { exact: true }).first(),
  ];
}

/**
 * 在「筛选」面板容器内点击某个选项（限定容器，避免点到导航/分类标签同名项）。
 * 面板支持多选、点击不收起，所以无需在项之间重开；但仍保留重开兜底。
 */
async function clickXhsFilterTrigger(page: Page): Promise<boolean> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 1000 };
  const candidates: Array<{ locator: Locator; x: number; y: number; score: number }> = [];

  for (const locator of getXhsFilterTriggerCandidates(page)) {
    const count = await locator.count().catch(() => 0);
    const limit = Math.min(count, 20);

    for (let index = 0; index < limit; index += 1) {
      const target = locator.nth(index);
      try {
        if (!(await target.isVisible({ timeout: 300 }))) {
          continue;
        }

        const box = await target.boundingBox();
        if (!box || box.width <= 0 || box.height <= 0) {
          continue;
        }

        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        const isTopRight = centerX > viewport.width * 0.55 && centerY < viewport.height * 0.35;
        const score = (isTopRight ? 10_000 : 0) + centerX - centerY;
        candidates.push({ locator: target, x: centerX, y: centerY, score });
      } catch {
        // try next candidate
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score);

  for (const candidate of candidates) {
    try {
      await page.mouse.move(candidate.x, candidate.y, { steps: randomBetween(4, 9) });
      await page.mouse.click(candidate.x, candidate.y);
      if (await waitForXhsFilterPanelOpen(page, 1_200)) {
        return true;
      }
    } catch {
      try {
        await candidate.locator.click({ timeout: 1_500, force: true });
        if (await waitForXhsFilterPanelOpen(page, 1_200)) {
          return true;
        }
      } catch {
        // try next candidate
      }
    }
  }

  return false;
}

async function clickXhsPanelOption(page: Page, sectionText: string, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitIfCaptcha(page);
    if (!(await isXhsFilterPanelOpen(page))) {
      await openXhsFilterPanel(page);
      await page.waitForTimeout(randomBetween(700, 1_400));
    }

    if (await isXhsPanelOptionActive(page, sectionText, text)) {
      return true;
    }

    const option = xhsPanelOption(page, sectionText, text);
    const count = await option.count().catch(() => 0);
    const limit = Math.min(count, 8);
    for (let i = 0; i < limit; i += 1) {
      const target = option.nth(i);
      try {
        if (!(await target.isVisible())) {
          continue;
        }
        await target.scrollIntoViewIfNeeded({ timeout: 1_000 }).catch(() => undefined);
        const box = await target.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: randomBetween(4, 9) });
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await target.click({ timeout: 2_000 });
        }
        // 点完会触发结果 reload，等它稳定再点下一项。
        await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
        await page.waitForTimeout(randomBetween(500, 1_000));
        await waitIfCaptcha(page);
        if (!(await isXhsFilterPanelOpen(page))) {
          await openXhsFilterPanel(page);
        }
        if (await waitForXhsPanelOptionActive(page, sectionText, text)) {
          return true;
        }
        return true;
      } catch {
        // try next match
      }
    }

    await page.waitForTimeout(randomBetween(400, 800));
  }

  return false;
}

function xhsPanelOption(page: Page, sectionText: string, text: string): Locator {
  const exactText = new RegExp(`^${escapeRegExp(text)}$`);
  return page
    .locator(".filter-panel .filters")
    .filter({ hasText: sectionText })
    .locator(".tags")
    .filter({ hasText: exactText });
}

async function isXhsPanelOptionActive(page: Page, sectionText: string, text: string): Promise<boolean> {
  return page
    .evaluate(
      ({ option }) => {
        const normalize = (value: string | null | undefined): string => (value || "").replace(/\s+/g, " ").trim();
        const tags = Array.from(document.querySelectorAll<HTMLElement>(".filter-panel .tags.active"));
        return tags.some((tag) => normalize(tag.textContent) === option && tag.classList.contains("active"));
      },
      { section: sectionText, option: text },
    )
    .catch(() => false);
}

async function waitForXhsPanelOptionActive(page: Page, sectionText: string, text: string, timeoutMs = 3_000): Promise<boolean> {
  if (await isXhsPanelOptionActive(page, sectionText, text)) {
    return true;
  }

  try {
    await page.waitForFunction(
      ({ option }) => {
        const normalize = (value: string | null | undefined): string => (value || "").replace(/\s+/g, " ").trim();
        const tags = Array.from(document.querySelectorAll<HTMLElement>(".filter-panel .tags.active"));
        return tags.some((tag) => normalize(tag.textContent) === option && tag.classList.contains("active"));
      },
      { section: sectionText, option: text },
      { timeout: timeoutMs },
    );
  } catch {
    // fall through to final state check
  }

  return isXhsPanelOptionActive(page, sectionText, text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function isAnyTextVisible(page: Page, texts: string[]): Promise<boolean> {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: true });
    const count = await locator.count().catch(() => 0);
    const limit = Math.min(count, 12);
    for (let i = 0; i < limit; i += 1) {
      if (await locator.nth(i).isVisible().catch(() => false)) {
        return true;
      }
    }
  }
  return false;
}

export async function openXhsSearch(page: Page, keyword: string): Promise<void> {
  const url = `${XHS_SEARCH_URL}?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
  console.log(`Opening 小红书搜索: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(randomBetween(2_500, 5_000));
  await waitIfCaptcha(page);

  const input = page.locator('input[placeholder*="搜索"], input[type="search"], [class*="search"] input').first();
  if (await input.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const submitted = await submitXhsSearchInput(page, input, keyword);
    if (submitted) {
      await page.waitForTimeout(randomBetween(2_500, 5_000));
      await waitIfCaptcha(page);
    }
  }
}

async function submitXhsSearchInput(page: Page, input: Locator, keyword: string): Promise<boolean> {
  try {
    await input.fill(keyword, { timeout: 3_000 });
    await page.waitForTimeout(randomBetween(300, 900));
    await input.press("Enter", { timeout: 3_000 });
    return true;
  } catch (err) {
    console.warn(`Xiaohongshu search input fill fallback needed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await input.evaluate((element, value) => {
      const target = element as HTMLInputElement;
      target.focus();
      target.value = value;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    }, keyword);
    await page.keyboard.press("Enter").catch(() => undefined);
    return true;
  } catch (err) {
    console.warn(`Xiaohongshu search input JS fallback failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const ok = await page.evaluate((value) => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="search"], input[id*="search"], input[class*="search"], input[placeholder*="搜索"]'));
      const target = inputs.find((inputElement) => inputElement.offsetParent !== null) || inputs[0];
      if (!target) {
        return false;
      }
      target.focus();
      target.value = value;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
      return true;
    }, keyword);
    if (ok) {
      await page.keyboard.press("Enter").catch(() => undefined);
      return true;
    }
  } catch (err) {
    console.warn(`Xiaohongshu document search input fallback failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.warn("Could not submit Xiaohongshu search input. Continuing with URL keyword results.");
  return false;
}

export async function applyXhsSearchFilters(
  page: Page,
  contentType: ContentType = "image",
  publishTime: PublishTimeFilter = "week",
  sortBy: SearchSort = "latest",
): Promise<void> {
  await applyXhsSearchFiltersStable(page, contentType, publishTime, sortBy);
}

function resolveXhsPublishTimeLabel(publishTime: PublishTimeFilter): string {
  if (publishTime === "day") return XHS_TEXT.day;
  if (publishTime === "half-year") return XHS_TEXT.halfYear;
  if (publishTime === "unlimited") return XHS_TEXT.unlimited;
  return XHS_TEXT.week;
}

async function collectByScrolling(page: Page, config: AppConfig): Promise<void> {
  await page.waitForTimeout(randomBetween(2_000, 4_000));
  await waitIfCaptcha(page);

  for (let index = 0; index < config.maxScrolls; index += 1) {
    await waitIfCaptcha(page);
    if (config.humanLike) {
      await humanScroll(page);
      await maybeReadingPause();
    } else {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(1_500);
    }
    await waitIfCaptcha(page);
  }

  await page.waitForTimeout(config.captureTimeoutMs);
  await waitIfCaptcha(page);
}

async function scrapeVisibleXhsNotes(page: Page, contentType: ContentType): Promise<NoteRecord[]> {
  const capturedAt = formatLocalDateTime(new Date());
  return page.evaluate(({ capturedAtValue, noteType }) => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/explore/"]'));
    const seen = new Set<string>();
    const notes: NoteRecord[] = [];

    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute("href") || "";
      const match = href.match(/\/explore\/([^/?#]+)/);
      const noteId = match?.[1]?.trim();
      if (!noteId || seen.has(noteId)) {
        continue;
      }

      seen.add(noteId);
      const card = findXhsCard(anchor);
      const lines = normalizeLines((card?.innerText || anchor.innerText || "").split("\n"));
      const title = pickTitle(lines);
      const dateInfo = extractDate(lines);
      const authorName = pickAuthor(lines, dateInfo);
      // 浏览器侧只抓"原始日期文案"（如 "04-03" / "553天前"），
      // 真正换算成 YYYY-MM-DD 放到 Node 侧做——page.evaluate 里写带具名
      // 箭头函数的换算逻辑会被 esbuild 注入 __name 包装而在浏览器里报错。
      const createTime = dateInfo.raw;
      const likedCount = pickCount(lines);
      const coverUrl = pickImageUrl(card || anchor);

      notes.push({
        noteId,
        source: "xhs_dom",
        noteType,
        title,
        desc: title,
        createTime,
        authorName,
        authorId: "",
        likedCount,
        commentCount: 0,
        collectCount: 0,
        shareUrl: href,
        linkStatus: href.includes("xsec_token=") ? "优先打开链接" : "裸链接，PC可能受限",
        coverUrl,
        imageUrls: coverUrl ? [coverUrl] : [],
        detailImageStatus: "",
        capturedAt: capturedAtValue,
        rawSnippet: lines.join(" | ").slice(0, 500),
      });
    }

    return notes;

    function findXhsCard(anchor: HTMLElement): HTMLElement | null {
      let current: HTMLElement | null = anchor;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        const text = current.innerText?.trim() || "";
        const imageCount = current.querySelectorAll("img").length;
        const linkCount = current.querySelectorAll('a[href*="/explore/"]').length;
        if (imageCount > 0 && text.length > 8 && linkCount <= 3) {
          return current;
        }
        current = current.parentElement;
      }

      return anchor.closest("section, article") as HTMLElement | null;
    }

    function normalizeLines(lines: string[]): string[] {
      return lines
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);
    }

    function pickTitle(lines: string[]): string {
      const ignored = new Set(["赞", "综合", "最新", "最多点赞", "最多评论", "视频", "图文"]);
      return lines.find((line) => line.length > 1 && !ignored.has(line) && !findDateMatchStable(line)) || "";
    }

    // 作者名常和发布日期粘在同一行，如 "乌甘露04-03" / "一只553天前"。
    // 找到带日期的那行，把日期子串剥掉，剩下就是作者名。
    function pickAuthor(lines: string[], dateInfo: { lineIndex: number; raw: string }): string {
      if (dateInfo.lineIndex >= 0) {
        const line = lines[dateInfo.lineIndex] || "";
        const stripped = stripClockText(dateInfo.raw ? line.replace(dateInfo.raw, "").trim() : line.trim());
        if (isAuthorCandidate(stripped)) {
          return stripped;
        }
        // 日期独占一行时，作者通常在上一行。
        if (dateInfo.lineIndex > 0) {
          const previous = stripClockText(lines[dateInfo.lineIndex - 1] || "");
          return isAuthorCandidate(previous) ? previous : "";
        }
      }
      return "";
    }

    // 在所有行里找第一个日期/相对时间，返回原始子串和所在行（换算交给 Node 侧）。
    function extractDate(lines: string[]): { raw: string; lineIndex: number } {
      for (let i = 0; i < lines.length; i += 1) {
        const m = findDateMatchStable(lines[i]);
        if (m) {
          const clock = findClockText(lines[i]) || (i > 0 ? findClockOnlyText(lines[i - 1]) : "");
          return { raw: [m, clock].filter(Boolean).join(" "), lineIndex: i };
        }
      }
      return { raw: "", lineIndex: -1 };
    }

    // 在一段文本中匹配日期子串（可出现在任意位置，应对作者名+日期粘连）。
    function findDateMatch(value: string): string {
      const patterns = [
        /\d{4}-\d{1,2}-\d{1,2}/,                       // 2024-04-03
        /\d{1,2}-\d{1,2}/,                             // 04-03
        /\d+\s*(?:秒|分钟|小时|天|周|月|年)前/,          // 3天前 / 5小时前
        /(?:昨天|今天|前天|刚刚)/,
      ];
      for (const p of patterns) {
        const m = value.match(p);
        if (m) {
          return m[0];
        }
      }
      return "";
    }

    function findDateMatchStable(value: string): string {
      const patterns = [
        /\d{4}-\d{1,2}-\d{1,2}/,
        /\d{1,2}-\d{1,2}/,
        new RegExp("\\d+\\s*(?:\\u79d2|\\u5206\\u949f|\\u5c0f\\u65f6|\\u5929|\\u5468|\\u6708|\\u5e74)\\u524d"),
        new RegExp("\\u6628\\u5929|\\u4eca\\u5929|\\u524d\\u5929|\\u521a\\u521a"),
      ];
      for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) {
          return match[0];
        }
      }
      return "";
    }

    function findClockText(value: string): string {
      const match = value.match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$)/);
      return match?.[1] || "";
    }

    function findClockOnlyText(value: string): string {
      const text = value.trim();
      return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text) ? text : "";
    }

    function stripClockText(value: string): string {
      return value.replace(/(?:^|\s)\d{1,2}:\d{2}(?::\d{2})?(?:\s|$)/g, " ").replace(/\s+/g, " ").trim();
    }

    function isAuthorCandidate(value: string): boolean {
      const text = value.trim();
      if (!text || findClockOnlyText(text) || findDateMatchStable(text)) {
        return false;
      }
      if (/^\d+(?:\.\d+)?万?$/.test(text)) {
        return false;
      }
      return !["赞", "综合", "最新", "最多点赞", "最多评论", "视频", "图文"].includes(text);
    }

    function pickCount(lines: string[]): number {
      for (const line of lines) {
        const match = line.match(/^(\d+(?:\.\d+)?)(万)?$/);
        if (match) {
          const value = Number.parseFloat(match[1]);
          return Number.isFinite(value) ? Math.round(value * (match[2] ? 10_000 : 1)) : 0;
        }
      }
      return 0;
    }

    function pickImageUrl(root: Element): string {
      const image = root.querySelector<HTMLImageElement>("img");
      return image?.currentSrc || image?.src || "";
    }
  }, { capturedAtValue: capturedAt, noteType: contentType === "image" ? "normal" : "video" });
}

async function clickVisibleText(page: Page, texts: string[], timeoutMs: number): Promise<boolean> {
  for (const text of texts) {
    // 同一个文案在小红书页面经常有多个匹配（隐藏副本 + 面板里的真节点）。
    // 不能只取 .first()：如果第一个是隐藏的，isVisible 直接 false 整项就失败了。
    // 这里遍历所有匹配，点第一个真正可见的。
    const locators = [
      page.getByText(text, { exact: true }),
      page.locator(`text="${text}"`),
    ];

    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      const limit = Math.min(count, 12);
      for (let i = 0; i < limit; i += 1) {
        const target = locator.nth(i);
        try {
          if (!(await target.isVisible())) {
            continue;
          }
          await target.scrollIntoViewIfNeeded({ timeout: 1_000 }).catch(() => undefined);
          await target.click({ timeout: timeoutMs });
          return true;
        } catch {
          // try next match / locator
        }
      }
    }
  }

  return false;
}

/**
 * 诊断用：把页面上"短文本可点元素"，以及看起来像下拉/弹层的容器整段文本
 * 打印出来，方便对照真实结构调整选择器。
 */
async function logVisibleFilterCandidates(page: Page): Promise<void> {
  try {
    const result = await page.evaluate(() => {
      const isVisible = (el: HTMLElement) => el.offsetParent !== null || el.getClientRects().length > 0;

      const labels: string[] = [];
      const seenLabel = new Set<string>();
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, a, span, div[class*='filter'], div[class*='Filter'], div[class*='tag'], li",
        ),
      );
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 12 || seenLabel.has(text)) continue;
        seenLabel.add(text);
        labels.push(text);
        if (labels.length >= 60) break;
      }

      // 弹层/下拉容器：类名含 dropdown/popover/popup/panel/menu/select/filter 的可见元素
      const panels: string[] = [];
      const seenPanel = new Set<string>();
      const panelNodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[class*='dropdown'],[class*='Dropdown'],[class*='popover'],[class*='Popover'],[class*='popup'],[class*='Popup'],[class*='panel'],[class*='Panel'],[class*='menu'],[class*='Menu'],[class*='select'],[class*='Select'],[role='listbox'],[role='menu'],[role='tooltip']",
        ),
      );
      for (const node of panelNodes) {
        if (!isVisible(node)) continue;
        const text = (node.innerText || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 200 || seenPanel.has(text)) continue;
        seenPanel.add(text);
        panels.push(`<${node.className}> ${text}`);
        if (panels.length >= 12) break;
      }

      return { labels, panels };
    });
    console.warn(`[xhs] visible short labels: ${result.labels.join(" | ")}`);
    if (result.panels.length > 0) {
      console.warn(`[xhs] dropdown/popup containers:`);
      for (const p of result.panels) {
        console.warn(`  ${p}`);
      }
    } else {
      console.warn(`[xhs] no dropdown/popup-like containers visible.`);
    }
  } catch {
    // diagnostics are best-effort
  }
}

async function waitIfCaptcha(page: Page): Promise<void> {
  const captchaSelector = [
    '[id*="captcha"]',
    '[class*="captcha"]',
    '[class*="verify"]',
    '[class*="Verify"]',
    '[class*="slider"]',
    '[class*="red-captcha"]',
    'iframe[src*="captcha"]',
    'iframe[src*="verify"]',
  ].join(", ");
  const visible = await page
    .locator(captchaSelector)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (!visible) {
    return;
  }

  console.log("Detected Xiaohongshu verification. Please complete it in the browser; the script will continue automatically.");
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const stillVisible = await page
      .locator(captchaSelector)
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (!stillVisible) {
      console.log("Xiaohongshu verification completed. Continuing.");
      await page.waitForTimeout(randomBetween(1_000, 3_000));
      return;
    }
  }

  throw new Error("Xiaohongshu verification was not solved within 5 minutes.");
}

function filterNotesByContentType(notes: NoteRecord[], contentType: ContentType): NoteRecord[] {
  const filtered = notes.filter((note) => {
    const type = note.noteType.trim().toLowerCase();
    if (contentType === "video") {
      return type.includes("video");
    }
    return type.includes("normal") || type.includes("image") || type.includes("photo") || type.includes("图文");
  });

  if (filtered.length === 0 && notes.length > 0) {
    const untyped = notes.filter((note) => !note.noteType.trim());
    if (untyped.length > 0) {
      console.warn(`No explicit Xiaohongshu ${contentType} note types were detected. Keeping ${untyped.length}/${notes.length} untyped notes instead of exporting nothing.`);
      return untyped;
    }
  }

  console.log(`Kept ${filtered.length}/${notes.length} Xiaohongshu notes matching ${contentType} type.`);
  return filtered;
}

function isClockOnlyText(value: string): boolean {
  return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim());
}

function filterByMaxAgeDays(notes: NoteRecord[], maxAgeDays: number): NoteRecord[] {
  if (maxAgeDays <= 0) {
    return notes;
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const filtered = notes.filter((note) => {
    const createdAt = parseLocalDateTime(note.createTime);
    return createdAt === null || createdAt.getTime() >= cutoff;
  });
  console.log(`Kept ${filtered.length}/${notes.length} Xiaohongshu notes from the last ${maxAgeDays} days.`);
  return filtered;
}

function filterByRelevance(notes: NoteRecord[], keywords: string[]): NoteRecord[] {
  const normalizedKeywords = keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
  if (normalizedKeywords.length === 0) {
    return notes;
  }

  const filtered = notes.filter((note) => {
    const haystack = [note.title, note.desc, note.authorName].join(" ").toLowerCase();
    return normalizedKeywords.some((keyword) => haystack.includes(keyword));
  });
  console.log(`Kept ${filtered.length}/${notes.length} Xiaohongshu notes matching relevance keywords: ${keywords.join(", ")}.`);
  return filtered;
}

function parseLocalDateTime(value: string): Date | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const date = new Date(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10),
  );

  return Number.isFinite(date.getTime()) ? date : null;
}

function formatLocalDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

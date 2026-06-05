import type { Page, Response } from "playwright";
import type { AppConfig } from "../../config.js";
import { randomBetween, sleep } from "../../human.js";
import type { NoteRecord } from "../../types.js";
import { normalizeImageUrlList } from "../../shared/imageUrls.js";

const RESPONSE_READ_TIMEOUT_MS = 8_000;
const DETAIL_WAIT_MS = 6_000;
const MAX_WALK_DEPTH = 16;
const NOTE_ID_KEYS = ["note_id", "noteId", "id"];
const IMAGE_HOST_HINTS = ["xhscdn.com", "sns-webpic", "sns-img", "xiaohongshu.com"];
const REJECT_PATH_HINTS = ["avatar", "user", "emoji", "sticker", "icon", "logo", "qrcode"];

export async function enrichXhsDetailImages(
  page: Page,
  notes: NoteRecord[],
  config: AppConfig,
): Promise<NoteRecord[]> {
  const limit = Math.min(config.detailMaxItems, notes.length);
  if (!config.enrichXhsDetailImages || limit <= 0) {
    return notes.map((note, index) => markFallbackImages(note, index < limit ? "未启用详情补图" : "未补图"));
  }

  console.log(
    `Xiaohongshu detail image enrichment enabled: items=${limit}/${notes.length}, imagesPerItem=${config.detailImageLimit}, delay=${config.detailMinDelayMs}-${config.detailMaxDelayMs}ms.`,
  );

  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    if (index >= limit) {
      markFallbackImages(note, "未补图（超过详情补图上限）");
      continue;
    }

    if (index > 0) {
      await sleep(randomDelay(config));
    }

    const result = await collectDetailImages(page, note, config);
    if (result.stop) {
      markFallbackImages(note, result.status);
      for (let rest = index + 1; rest < notes.length; rest += 1) {
        markFallbackImages(notes[rest], "未补图（详情补图已停止）");
      }
      break;
    }

    if (result.imageUrls.length > 0) {
      note.imageUrls = mergeImageUrls(result.imageUrls, note.coverUrl).slice(0, config.detailImageLimit);
      note.detailImageStatus = `详情补图成功（${note.imageUrls.length}张）`;
    } else {
      markFallbackImages(note, result.status || "详情未发现多图，使用封面");
    }
  }

  return notes;
}

async function collectDetailImages(
  page: Page,
  note: NoteRecord,
  config: AppConfig,
): Promise<{ imageUrls: string[]; status: string; stop: boolean }> {
  const networkUrls: string[] = [];
  const responseTasks: Promise<void>[] = [];
  const seenResponses = new Set<string>();

  const handler = (response: Response): void => {
    if (!shouldReadResponse(response)) {
      return;
    }

    const dedupeKey = `${response.url()}\n${response.request().postData() ?? ""}`;
    if (seenResponses.has(dedupeKey)) {
      return;
    }
    seenResponses.add(dedupeKey);

    responseTasks.push(
      readDetailImages(response, note.noteId)
        .then((urls) => {
          networkUrls.push(...urls);
        })
        .catch(() => {
          // XHS detail pages include non-JSON/unreadable responses; ignore those.
        }),
    );
  };

  page.on("response", handler);
  try {
    const url = buildDetailUrl(note);
    console.log(`[xhs:detail-images] ${note.noteId} opening detail page...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(randomBetween(1_800, 3_500));

    if (await isCaptchaVisible(page)) {
      console.warn("[xhs:detail-images] Verification detected. Stopping detail-image enrichment and keeping existing cover images.");
      return { imageUrls: [], status: "验证中断，使用封面", stop: true };
    }

    if (config.humanLike) {
      await humanDetailInteraction(page);
    }

    await page.waitForTimeout(DETAIL_WAIT_MS);
  } catch (error) {
    return {
      imageUrls: [],
      status: `详情页失败：${error instanceof Error ? error.message : String(error)}`,
      stop: false,
    };
  } finally {
    page.off("response", handler);
  }

  await Promise.allSettled(responseTasks);

  const domUrls = await extractDomImageUrls(page).catch(() => []);
  const imageUrls = mergeImageUrls([...networkUrls, ...domUrls], note.coverUrl).slice(0, config.detailImageLimit);
  return { imageUrls, status: imageUrls.length > 0 ? "" : "详情未发现多图，使用封面", stop: false };
}

async function humanDetailInteraction(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 1000 };
  await page.mouse.move(
    randomBetween(180, Math.max(220, viewport.width - 180)),
    randomBetween(160, Math.max(200, viewport.height - 160)),
    { steps: randomBetween(6, 12) },
  ).catch(() => undefined);
  await page.waitForTimeout(randomBetween(900, 1_800));
  await page.mouse.wheel(0, randomBetween(300, 900)).catch(() => undefined);
  await page.waitForTimeout(randomBetween(1_000, 2_500));
}

async function readDetailImages(response: Response, noteId: string): Promise<string[]> {
  const json = await withTimeout(response.json(), RESPONSE_READ_TIMEOUT_MS);
  return extractImageUrlsFromJson(json, noteId);
}

function extractImageUrlsFromJson(json: unknown, noteId: string): string[] {
  const output: string[] = [];
  walkJsonForImages(json, noteId, output, {
    seen: new Set<string>(),
    path: "$",
    depth: 0,
    activeNoteId: "",
  });
  return output;
}

function walkJsonForImages(
  value: unknown,
  noteId: string,
  output: string[],
  context: { seen: Set<string>; path: string; depth: number; activeNoteId: string },
): void {
  if (context.depth > MAX_WALK_DEPTH || value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkJsonForImages(item, noteId, output, {
        ...context,
        path: `${context.path}.${index}`,
        depth: context.depth + 1,
      });
    });
    return;
  }

  if (typeof value !== "object") {
    if (context.activeNoteId === noteId && typeof value === "string") {
      addImageUrl(value, context.path, context.seen, output);
    }
    return;
  }

  const object = value as Record<string, unknown>;
  const ownNoteId = pickString(object, NOTE_ID_KEYS);
  const activeNoteId = ownNoteId || context.activeNoteId;

  for (const [key, child] of Object.entries(object)) {
    walkJsonForImages(child, noteId, output, {
      seen: context.seen,
      path: `${context.path}.${key}`,
      depth: context.depth + 1,
      activeNoteId,
    });
  }
}

async function extractDomImageUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const urls = new Set<string>();
    for (const image of Array.from(document.querySelectorAll<HTMLImageElement>("img"))) {
      const url = image.currentSrc || image.src || image.getAttribute("src") || "";
      const box = image.getBoundingClientRect();
      if (url && box.width >= 80 && box.height >= 80) {
        urls.add(url);
      }
    }
    return Array.from(urls);
  });
}

function addImageUrl(value: string, path: string, seen: Set<string>, output: string[]): void {
  for (const candidate of extractUrlCandidates(value)) {
    if (!looksLikeContentImage(candidate, path) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    output.push(candidate);
  }
}

function extractUrlCandidates(value: string): string[] {
  const normalized = value.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
  const candidates = new Set<string>();
  for (const text of [normalized, tryDecodeURIComponent(normalized)]) {
    const pattern = /https?:\/\/[^\s"'<>\\]+/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      candidates.add(match[0].replace(/[),\]}]+$/g, ""));
    }
  }
  return Array.from(candidates);
}

function looksLikeContentImage(url: string, path: string): boolean {
  const lowerUrl = url.toLowerCase();
  const lowerPath = path.toLowerCase();
  if (!IMAGE_HOST_HINTS.some((hint) => lowerUrl.includes(hint))) {
    return false;
  }
  if (/\.(mp4|webm|mov|m3u8)(?:[?#]|$)/i.test(lowerUrl)) {
    return false;
  }
  if (REJECT_PATH_HINTS.some((hint) => lowerPath.includes(hint) || lowerUrl.includes(`/${hint}`))) {
    return false;
  }
  return /image|img|cover|url_list|origin|large|medium|thumb|photo|trace/i.test(path) || /\.(jpe?g|png|webp)(?:[?#]|$)/i.test(lowerUrl);
}

function mergeImageUrls(urls: string[], coverUrl: string): string[] {
  return normalizeImageUrlList([...urls, coverUrl]);
}

function markFallbackImages(note: NoteRecord, status: string): NoteRecord {
  note.imageUrls = mergeImageUrls(note.imageUrls ?? [], note.coverUrl);
  note.detailImageStatus = note.detailImageStatus || status;
  return note;
}

function randomDelay(config: AppConfig): number {
  const min = Math.min(config.detailMinDelayMs, config.detailMaxDelayMs);
  const max = Math.max(config.detailMinDelayMs, config.detailMaxDelayMs);
  return randomBetween(min, max);
}

function buildDetailUrl(note: NoteRecord): string {
  const rawUrl = note.shareUrl.trim();
  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    return rawUrl;
  }
  return `https://www.xiaohongshu.com/explore/${encodeURIComponent(note.noteId)}?xsec_source=pc_search`;
}

function shouldReadResponse(response: Response): boolean {
  if (!["xhr", "fetch", "document"].includes(response.request().resourceType())) {
    return false;
  }
  if (response.status() < 200 || response.status() >= 300) {
    return false;
  }

  const url = response.url().toLowerCase();
  return !["captcha", "verify", "login", "passport", ".css", ".png", ".jpg", ".jpeg", ".webp", ".gif"].some((part) => url.includes(part));
}

async function isCaptchaVisible(page: Page): Promise<boolean> {
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
  return page.locator(captchaSelector).first().isVisible({ timeout: 500 }).catch(() => false);
}

function pickString(object: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function tryDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  });
}

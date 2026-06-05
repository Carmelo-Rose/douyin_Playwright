import { Buffer } from "node:buffer";
import path from "node:path";
import fs from "fs-extra";
import type { AppConfig } from "../../config.js";
import type { NoteRecord } from "../../types.js";
import { normalizeImageUrlList } from "../../shared/imageUrls.js";

interface VisionImage {
  mediaType: string;
  data: string;
  sourceUrl: string;
}

interface XhsVisualVerdict {
  person_wearing_hat: boolean;
  hat_clear_and_main: boolean;
  obvious_noise: boolean;
  hat_type: string;
  score: number;
  reason: string;
}

interface XhsVisualFewShotExample {
  caseName?: string;
  inputDescription?: string;
  expectedVerdict?: Partial<XhsVisualVerdict>;
  why?: string;
}

interface XhsVisualReferenceImages {
  good: VisionImage[];
  bad: VisionImage[];
  borderline: VisionImage[];
}

interface XhsVisualPromptContext {
  fewShotText: string;
  visualRulesText: string;
  referenceImages: XhsVisualReferenceImages;
}

const QUALIFIED_YES = "\u662f";
const QUALIFIED_MAYBE = "\u7591\u4f3c";
const QUALIFIED_NO = "\u5426";
const QUALIFIED_UNKNOWN = "\u672a\u5224\u65ad";

export async function scoreXhsVisualQuality(notes: NoteRecord[], config: AppConfig): Promise<NoteRecord[]> {
  if (!config.xhsVisualFilter) {
    console.log("[xhs:visual] visual filter disabled.");
    return notes;
  }

  if (!config.dashscopeApiKey) {
    console.warn("[xhs:visual] Missing DASHSCOPE_API_KEY. Exporting all notes without visual scoring.");
    return notes.map((note) => ({
      ...note,
      visualStatus: "\u672a\u7b5b\u9009\uff08\u7f3a\u5c11 DASHSCOPE_API_KEY\uff09",
      visualQualified: QUALIFIED_UNKNOWN,
    }));
  }

  const limit = config.xhsVisualMaxItems > 0 ? Math.min(config.xhsVisualMaxItems, notes.length) : notes.length;
  const target = notes.slice(0, limit);
  const skipped = notes.slice(limit).map((note) => ({
    ...note,
    visualStatus: "\u672a\u7b5b\u9009\uff08\u8d85\u8fc7\u89c6\u89c9\u7b5b\u9009\u4e0a\u9650\uff09",
    visualQualified: QUALIFIED_UNKNOWN,
  }));

  console.log(
    `[xhs:visual] scoring ${target.length}/${notes.length} notes with ${config.dashscopeModel}, maxImages=${config.xhsVisualMaxImages}, concurrency=${config.xhsVisualConcurrency}.`,
  );
  const promptContext = await loadPromptContext(config);
  if (promptContext.fewShotText) {
    console.log(`[xhs:visual] loaded few-shot examples: ${config.xhsVisualFewShotPath}`);
  }
  if (promptContext.visualRulesText) {
    console.log(`[xhs:visual] loaded visual rules: ${config.xhsVisualRulesPath}`);
  }
  const referenceCount =
    promptContext.referenceImages.good.length + promptContext.referenceImages.bad.length + promptContext.referenceImages.borderline.length;
  if (referenceCount > 0) {
    console.log(
      `[xhs:visual] loaded reference images: good=${promptContext.referenceImages.good.length}, bad=${promptContext.referenceImages.bad.length}, borderline=${promptContext.referenceImages.borderline.length}.`,
    );
  }

  let done = 0;
  const scored = await runPool(target, config.xhsVisualConcurrency, async (note) => {
    const result = await scoreOneNote(note, config, promptContext);
    done += 1;
    console.log(
      `[xhs:visual] ${done}/${target.length} ${result.visualQualified ?? QUALIFIED_UNKNOWN} score=${result.visualScore ?? "-"} ${result.title.slice(0, 24)} ${result.visualReason ?? ""}`,
    );
    return result;
  });

  return [...scored, ...skipped];
}

async function scoreOneNote(note: NoteRecord, config: AppConfig, promptContext: XhsVisualPromptContext): Promise<NoteRecord> {
  const urls = normalizeImageUrlList(note.imageUrls?.length ? note.imageUrls : [note.coverUrl]).slice(0, config.xhsVisualMaxImages);
  if (urls.length === 0) {
    return {
      ...note,
      visualQualified: QUALIFIED_NO,
      visualScore: 0,
      visualStatus: "\u65e0\u56fe",
      visualReason: "\u6ca1\u6709\u53ef\u7528\u56fe\u7247",
      visualAnalyzedImages: "",
    };
  }

  const images: VisionImage[] = [];
  for (const url of urls) {
    const image = await downloadImageAsBase64(url, config.xhsVisualTimeoutMs).catch((error: unknown) => {
      console.warn(`[xhs:visual] image download failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (image) {
      images.push(image);
    }
  }

  if (images.length === 0) {
    return {
      ...note,
      visualQualified: QUALIFIED_UNKNOWN,
      visualScore: 0,
      visualStatus: "\u56fe\u7247\u4e0b\u8f7d\u5931\u8d25",
      visualReason: "\u56fe\u7247\u94fe\u63a5\u65e0\u6cd5\u4e0b\u8f7d\u6216\u5df2\u8fc7\u671f",
      visualAnalyzedImages: urls.join("\n"),
    };
  }

  try {
    const verdict = await callDashScopeVision(note, images, config, promptContext);
    const score = clampScore(verdict.score);
    return {
      ...note,
      visualQualified: resolveQualified(verdict, score),
      visualScore: score,
      visualReason: verdict.reason,
      visualHatType: verdict.hat_type,
      visualStatus: "\u5df2\u7b5b\u9009",
      visualAnalyzedImages: images.map((image) => image.sourceUrl).join("\n"),
    };
  } catch (error) {
    return {
      ...note,
      visualQualified: QUALIFIED_UNKNOWN,
      visualScore: 0,
      visualReason: `\u89c6\u89c9\u8bc6\u522b\u5931\u8d25\uff1a${error instanceof Error ? error.message : String(error)}`.slice(0, 180),
      visualStatus: "\u8bc6\u522b\u5931\u8d25",
      visualAnalyzedImages: images.map((image) => image.sourceUrl).join("\n"),
    };
  }
}

async function callDashScopeVision(
  note: NoteRecord,
  images: VisionImage[],
  config: AppConfig,
  promptContext: XhsVisualPromptContext,
): Promise<XhsVisualVerdict> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = await requestDashScope(note, images, config, promptContext, attempt > 0);
    try {
      return parseVerdict(text);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("vision parse failed");
}

async function requestDashScope(
  note: NoteRecord,
  images: VisionImage[],
  config: AppConfig,
  promptContext: XhsVisualPromptContext,
  strict: boolean,
): Promise<string> {
  if (config.dashscopeBaseUrl.toLowerCase().includes("/anthropic")) {
    return requestAnthropicCompatible(note, images, config, promptContext, strict);
  }
  return requestOpenAiCompatible(note, images, config, promptContext, strict);
}

async function requestOpenAiCompatible(
  note: NoteRecord,
  images: VisionImage[],
  config: AppConfig,
  promptContext: XhsVisualPromptContext,
  strict: boolean,
): Promise<string> {
  const content: unknown[] = [
    {
      type: "text",
      text: buildPrompt(note, promptContext, strict),
    },
  ];
  appendOpenAiReferenceImages(content, promptContext.referenceImages);
  content.push({ type: "text", text: "当前待判断图片如下。请只对这些当前图片输出最终 JSON：" });
  content.push(...images.map(toOpenAiImageBlock));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.xhsVisualTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.dashscopeBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.dashscopeApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.dashscopeModel,
        messages: [{ role: "user", content }],
        temperature: 0.1,
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`DashScope ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

async function requestAnthropicCompatible(
  note: NoteRecord,
  images: VisionImage[],
  config: AppConfig,
  promptContext: XhsVisualPromptContext,
  strict: boolean,
): Promise<string> {
  const content: unknown[] = [{ type: "text", text: buildPrompt(note, promptContext, strict) }];
  appendAnthropicReferenceImages(content, promptContext.referenceImages);
  content.push({ type: "text", text: "当前待判断图片如下。请只对这些当前图片输出最终 JSON：" });
  content.push(...images.map(toAnthropicImageBlock));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.xhsVisualTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.dashscopeBaseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": config.dashscopeApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.dashscopeModel,
        max_tokens: 1200,
        messages: [{ role: "user", content }],
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Anthropic compatible ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }

  const data = (await response.json()) as { content?: { type: string; text?: string }[] };
  return (data.content || [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function buildPrompt(note: NoteRecord, promptContext: XhsVisualPromptContext, strict: boolean): string {
  const text = [note.title, note.desc, note.authorName].join(" ").replace(/\s+/g, " ").slice(0, 300);
  const lines = [
    "\u4f60\u5728\u5e2e\u4e00\u4e2a\u5e3d\u5b50\u5185\u5bb9\u91c7\u96c6\u8868\u7b5b\u9009\u5408\u683c\u7b14\u8bb0\u3002",
    "\u5408\u683c\u6807\u51c6\uff1a\u771f\u4eba\u4f69\u6234\u5e3d\u5b50\uff0c\u5e3d\u5b50\u6e05\u6670\u4e14\u662f\u753b\u9762\u4e3b\u4f53\u6216\u5f3a\u53ef\u89c1\uff0c\u504f\u7a7f\u642d/\u51fa\u7247/\u65e5\u5e38\u79cd\u8349\u5185\u5bb9\u3002",
    "\u4e0d\u5408\u683c\u566a\u58f0\uff1a\u7eaf\u5546\u54c1\u56fe\u3001\u8d27\u67b6/\u67dc\u53f0\u3001\u624b\u5de5/\u94a9\u7ec7/\u7ed8\u753b/\u8bbe\u8ba1\u56fe\u3001\u5b9d\u5b9d\u6216\u513f\u7ae5\u4e3a\u4e3b\u3001\u9632\u6652\u5de5\u5177\u6216\u7a7a\u9876\u5e3d\u4e3a\u4e3b\u3001\u5e3d\u5b50\u4e0d\u6e05\u6670\u6216\u53ea\u662f\u6781\u5c0f\u914d\u89d2\u3002",
    "\u4e0b\u9762\u6587\u5b57\u4ec5\u4f9b\u53c2\u8003\uff0c\u4ee5\u56fe\u7247\u4e3a\u51c6\uff1a",
    text,
    "",
    promptContext.visualRulesText,
    promptContext.visualRulesText ? "" : "",
    promptContext.fewShotText,
    promptContext.fewShotText ? "" : "",
    hasReferenceImages(promptContext.referenceImages)
      ? "本次请求包含固定参考图：good 是合适样板，bad 是不合适样板，borderline 是边界样板。参考图只用于校准视觉偏好，不要把参考图本身当作当前待判断图片。"
      : "",
    hasReferenceImages(promptContext.referenceImages) ? "" : "",
    "\u53ea\u8f93\u51fa JSON\uff0c\u4e0d\u8981\u8f93\u51fa\u5176\u4ed6\u6587\u5b57\uff1a",
    "{",
    '  "person_wearing_hat": true/false,',
    '  "hat_clear_and_main": true/false,',
    '  "obvious_noise": true/false,',
    '  "hat_type": "\u68d2\u7403\u5e3d/\u9e2d\u820c\u5e3d/\u6e14\u592b\u5e3d/\u8349\u5e3d/\u8d1d\u96f7\u5e3d/\u5176\u4ed6/\u4e0d\u786e\u5b9a",',
    '  "score": 0-100,',
    '  "reason": "\u4e2d\u6587\u4e00\u53e5\u8bdd\u8bf4\u660e\u539f\u56e0"',
    "}",
  ];
  if (strict) {
    lines.push("\u6ce8\u610f\uff1a\u8fd9\u6b21\u5fc5\u987b\u8fd4\u56de\u53ef\u89e3\u6790\u7684\u7eaf JSON\u3002");
  }
  return lines.filter((line, index, arr) => line !== "" || arr[index - 1] !== "").join("\n");
}

async function loadPromptContext(config: AppConfig): Promise<XhsVisualPromptContext> {
  const [fewShotText, visualRulesText, referenceImages] = await Promise.all([
    loadFewShotText(config),
    loadVisualRulesText(config),
    loadReferenceImages(config),
  ]);
  return { fewShotText, visualRulesText, referenceImages };
}

async function loadVisualRulesText(config: AppConfig): Promise<string> {
  try {
    if (!(await fs.pathExists(config.xhsVisualRulesPath))) {
      return "";
    }
    const text = String(await fs.readFile(config.xhsVisualRulesPath, "utf8")).trim();
    if (!text) {
      return "";
    }
    return ["固定文字规则：", text.slice(0, 4000)].join("\n");
  } catch (error) {
    console.warn(`[xhs:visual] visual rules skipped: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

async function loadReferenceImages(config: AppConfig): Promise<XhsVisualReferenceImages> {
  const empty = { good: [], bad: [], borderline: [] };
  if (!config.xhsVisualReferenceImages) {
    return empty;
  }

  const [good, bad, borderline] = await Promise.all([
    loadReferenceImagesFromDir(config.xhsVisualReferenceGoodDir, config.xhsVisualReferenceMaxImagesPerClass, "good"),
    loadReferenceImagesFromDir(config.xhsVisualReferenceBadDir, config.xhsVisualReferenceMaxImagesPerClass, "bad"),
    loadReferenceImagesFromDir(config.xhsVisualReferenceBorderlineDir, config.xhsVisualReferenceMaxImagesPerClass, "borderline"),
  ]);
  return { good, bad, borderline };
}

async function loadReferenceImagesFromDir(dir: string, limit: number, label: string): Promise<VisionImage[]> {
  try {
    if (!(await fs.pathExists(dir))) {
      console.warn(`[xhs:visual] reference ${label} dir not found: ${dir}`);
      return [];
    }
    const entries = ((await fs.readdir(dir)) as string[])
      .filter(isSupportedImageFile)
      .sort((a, b) => a.localeCompare(b, "en"))
      .slice(0, limit);
    const images: VisionImage[] = [];
    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      try {
        const buffer = await fs.readFile(filePath);
        images.push({
          mediaType: guessMediaType(filePath, null),
          data: Buffer.from(buffer).toString("base64"),
          sourceUrl: filePath,
        });
      } catch (error) {
        console.warn(`[xhs:visual] reference image skipped: ${filePath} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return images;
  } catch (error) {
    console.warn(`[xhs:visual] reference ${label} images skipped: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function isSupportedImageFile(name: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(name);
}

function hasReferenceImages(referenceImages: XhsVisualReferenceImages): boolean {
  return referenceImages.good.length > 0 || referenceImages.bad.length > 0 || referenceImages.borderline.length > 0;
}

function appendOpenAiReferenceImages(content: unknown[], referenceImages: XhsVisualReferenceImages): void {
  appendOpenAiImageGroup(content, "good 参考图（合适样板）：", referenceImages.good);
  appendOpenAiImageGroup(content, "bad 参考图（不合适样板）：", referenceImages.bad);
  appendOpenAiImageGroup(content, "borderline 参考图（边界样板）：", referenceImages.borderline);
}

function appendOpenAiImageGroup(content: unknown[], label: string, images: VisionImage[]): void {
  if (images.length === 0) {
    return;
  }
  content.push({ type: "text", text: label });
  content.push(...images.map(toOpenAiImageBlock));
}

function toOpenAiImageBlock(image: VisionImage): unknown {
  return {
    type: "image_url",
    image_url: {
      url: `data:${image.mediaType};base64,${image.data}`,
    },
  };
}

function appendAnthropicReferenceImages(content: unknown[], referenceImages: XhsVisualReferenceImages): void {
  appendAnthropicImageGroup(content, "good 参考图（合适样板）：", referenceImages.good);
  appendAnthropicImageGroup(content, "bad 参考图（不合适样板）：", referenceImages.bad);
  appendAnthropicImageGroup(content, "borderline 参考图（边界样板）：", referenceImages.borderline);
}

function appendAnthropicImageGroup(content: unknown[], label: string, images: VisionImage[]): void {
  if (images.length === 0) {
    return;
  }
  content.push({ type: "text", text: label });
  content.push(...images.map(toAnthropicImageBlock));
}

function toAnthropicImageBlock(image: VisionImage): unknown {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mediaType,
      data: image.data,
    },
  };
}

async function loadFewShotText(config: AppConfig): Promise<string> {
  if (!config.xhsVisualFewShot) {
    return "";
  }

  try {
    const raw = (await fs.readJson(config.xhsVisualFewShotPath)) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error("few-shot file must be a JSON array");
    }
    const examples = raw.slice(0, 12).map(normalizeFewShotExample).filter(Boolean) as string[];
    if (examples.length === 0) {
      throw new Error("few-shot file has no valid examples");
    }
    return [
      "参考样板（只用于校准判断边界，不代表当前图片）：",
      ...examples,
      "请按这些边界判断当前图片：成人真人戴帽且帽子清楚才高分；商品陈列、手工设计、儿童宝宝、防晒工具或帽子太小/模糊要降分或判噪声。",
    ].join("\n");
  } catch (error) {
    console.warn(`[xhs:visual] few-shot examples skipped: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

function normalizeFewShotExample(example: unknown, index: number): string | null {
  if (!example || typeof example !== "object") {
    return null;
  }
  const item = example as XhsVisualFewShotExample;
  const description = String(item.inputDescription ?? "").trim();
  if (!description || !item.expectedVerdict) {
    return null;
  }
  const name = String(item.caseName ?? `case ${index + 1}`).trim();
  const why = String(item.why ?? item.expectedVerdict.reason ?? "").trim();
  return [
    `样板${index + 1}：${name}`,
    `图片特征：${description}`,
    `期望JSON：${JSON.stringify(item.expectedVerdict)}`,
    why ? `原因：${why}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseVerdict(text: string): XhsVisualVerdict {
  const slice = extractJsonObject(text);
  if (!slice) {
    throw new Error(`no JSON in model reply: ${text.slice(0, 80)}`);
  }
  const raw = JSON.parse(slice) as Partial<XhsVisualVerdict>;
  return {
    person_wearing_hat: Boolean(raw.person_wearing_hat),
    hat_clear_and_main: Boolean(raw.hat_clear_and_main),
    obvious_noise: Boolean(raw.obvious_noise),
    hat_type: String(raw.hat_type ?? "").trim(),
    score: clampScore(Number(raw.score)),
    reason: String(raw.reason ?? "").trim(),
  };
}

function resolveQualified(verdict: XhsVisualVerdict, score: number): string {
  if (verdict.person_wearing_hat && verdict.hat_clear_and_main && !verdict.obvious_noise && score >= 70) {
    return QUALIFIED_YES;
  }
  if (verdict.person_wearing_hat && !verdict.obvious_noise && score >= 55) {
    return QUALIFIED_MAYBE;
  }
  return QUALIFIED_NO;
}

async function downloadImageAsBase64(url: string, timeoutMs: number): Promise<VisionImage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: "https://www.xiaohongshu.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      mediaType: guessMediaType(url, response.headers.get("content-type")),
      data: buffer.toString("base64"),
      sourceUrl: url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function guessMediaType(url: string, contentType: string | null): string {
  if (contentType?.toLowerCase().startsWith("image/")) {
    return contentType.split(";")[0].trim();
  }
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  return "image/jpeg";
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

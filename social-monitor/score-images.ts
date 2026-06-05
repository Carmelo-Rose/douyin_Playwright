import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import fs from "fs-extra";
import { loadCelebList, matchCeleb } from "./celebs.js";

dotenv.config();

/**
 * Second stage of the social monitor: read a weibo export, send each post's
 * images to a vision model (Xiaomi MiMo, Anthropic-compatible) and judge two
 * things only: (1) is there a clearly visible hat (the core product) and
 * (2) is a celebrity involved. Scene (street / airport / variety show / 同款
 * product shot) does not matter. The verdict + score is written back as new
 * columns so the good rows float to the top.
 *
 * Stage 1 (weibo-demo.ts) stays untouched; this only consumes its xlsx output.
 */

interface ScoreConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxImagesPerPost: number;
  maxTokens: number;
  concurrency: number;
  limit: number;
  requestTimeoutMs: number;
  onlyGood: boolean;
  celebListPath: string;
  push: boolean;
  pushWebhooks: string[];
  stateFile: string;
  rescore: boolean;
}

interface VisionVerdict {
  hat_visible: boolean; // 帽子是否清晰可见（戴着或单独产品图都算）—— 产品核心，第一位
  person_wearing_hat: boolean; // 画面里是否有真人正戴着帽子
  looks_like_celebrity: boolean; // 出镜的人看起来是否像明星/艺人（街拍/综艺/写真等专业拍摄感）
  hat_type: string;
  score: number; // 0-100，对「明星戴帽子」主题的相关度，帽子清晰度为主
  reason: string;
}

interface PostRow {
  rowIndex: number;
  values: Record<string, string>;
  imageUrls: string[];
}

const SOURCE_COLUMNS = [
  "搜索词",
  "匹配关键词",
  "微博ID",
  "正文",
  "作者",
  "发布时间",
  "来源",
  "互动信息",
  "微博链接",
  "作者链接",
  "图片链接",
  "抓取时间",
] as const;

const SCORE_COLUMNS = [
  { header: "明星候选", key: "celeb", width: 18 },
  { header: "带货等级", key: "tier", width: 14 },
  { header: "综合判断", key: "verdict", width: 12 },
  { header: "视觉相关度", key: "score", width: 12 },
  { header: "帽子清晰", key: "hatVisible", width: 12 },
  { header: "有人戴帽", key: "hatWorn", width: 12 },
  { header: "像明星", key: "looksCeleb", width: 12 },
  { header: "帽子类型", key: "hatType", width: 14 },
  { header: "判断理由", key: "reason", width: 50 },
  { header: "已分析图", key: "analyzedImage", width: 60 },
] as const;

// Used to skip score columns if re-scoring an already-scored file.
const SCORE_HEADER_SET = new Set<string>(SCORE_COLUMNS.map((col) => col.header));

async function main(): Promise<void> {
  const config = loadConfig();
  const inputPath = await resolveInputPath();
  console.log(`[score] input: ${inputPath}`);
  console.log(`[score] model: ${config.model} @ ${config.baseUrl}`);

  const celebs = await loadCelebs(config.celebListPath);
  console.log(`[score] 明星名单: ${celebs.size} 个 (${config.celebListPath.split(/[\\/]/).pop()})`);

  const { worksheet, header, sourceHeaders } = await readWorkbook(inputPath);
  const rows = collectRows(worksheet, header);
  const target = config.limit > 0 ? rows.slice(0, config.limit) : rows;
  console.log(`[score] rows to analyze: ${target.length}${config.limit > 0 ? ` (limited from ${rows.length})` : ""}`);

  // Cross-run state keyed by 微博ID: remembers each post's verdict (so we don't
  // re-score it tomorrow) and whether it was already pushed (so we don't re-push).
  const state = await loadState(config.stateFile);
  const keyByRow = new Map<number, string>(target.map((p) => [p.rowIndex, postKey(p)]));

  const outputPath = buildOutputPath(inputPath);
  const results = new Map<number, RowResult>();
  let done = 0;
  let reused = 0;

  await runPool(target, config.concurrency, async (post) => {
    const key = keyByRow.get(post.rowIndex) || "";
    const cached = !config.rescore && key ? state[key] : undefined;
    const result = cached ? cached.result : await scorePost(post, config, celebs);
    results.set(post.rowIndex, result);
    if (key) {
      state[key] = { result, pushed: state[key]?.pushed ?? false };
    }
    done += 1;
    if (cached) {
      reused += 1;
    } else {
      console.log(
        `[score] ${done}/${target.length} #${post.rowIndex - 1} ` +
          `${result.verdict} score=${result.verdict === "错误" || result.verdict === "无图" ? "-" : result.score} ` +
          `@${result.celeb || "未知"} ${result.reason.slice(0, 30)}`,
      );
    }

    if (done % 5 === 0) {
      await writeScoredWorkbook(target, results, sourceHeaders, outputPath, config.onlyGood); // periodic flush
    }
  });

  const kept = await writeScoredWorkbook(target, results, sourceHeaders, outputPath, config.onlyGood);
  const counts = countVerdicts(results);
  console.log(
    `\n[score] done. 绿${counts["绿"] || 0} 黄${counts["黄"] || 0} 红${counts["红"] || 0} ` +
      `其他${target.length - (counts["绿"] || 0) - (counts["黄"] || 0) - (counts["红"] || 0)}` +
      `${reused > 0 ? `（复用缓存 ${reused} 条，未重复打分）` : ""}` +
      `${config.onlyGood ? ` → 仅导出合格 ${kept} 条` : ""}`,
  );
  console.log(`[score] exported: ${outputPath}`);

  if (config.push) {
    // Only push good rows that were never pushed before (cross-run dedup).
    const fresh = target.filter((p) => {
      const r = results.get(p.rowIndex);
      const key = keyByRow.get(p.rowIndex) || "";
      return r && (r.verdict === "绿" || r.verdict === "黄") && key && !state[key].pushed;
    });
    if (fresh.length === 0) {
      console.log("[push] 没有新增的合格内容（去重后），不推送");
    } else {
      await pushToWecom(fresh, results, config.pushWebhooks);
      for (const p of fresh) {
        const key = keyByRow.get(p.rowIndex) || "";
        if (key && state[key]) {
          state[key].pushed = true;
        }
      }
    }
  }

  await saveState(config.stateFile, state);
}

interface SeenEntry {
  result: RowResult;
  pushed: boolean;
}

// Stable per-post identity for dedup: 微博ID, else the link path.
function postKey(post: PostRow): string {
  const id = (post.values["微博ID"] || "").trim();
  if (id) {
    return id;
  }
  return (post.values["微博链接"] || "").split("?")[0].trim();
}

async function loadState(filePath: string): Promise<Record<string, SeenEntry>> {
  try {
    if (await fs.pathExists(filePath)) {
      return (await fs.readJson(filePath)) as Record<string, SeenEntry>;
    }
  } catch (error) {
    console.warn(`[state] 读取失败，按空状态继续：${(error as Error).message}`);
  }
  return {};
}

async function saveState(filePath: string, state: Record<string, SeenEntry>): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, state, { spaces: 0 });
}

// Build a WeCom markdown message from the good (绿/黄) rows and post it to every
// configured group robot. Long lists are chunked to stay under the 4096-byte cap.
async function pushToWecom(
  posts: PostRow[],
  results: Map<number, RowResult>,
  webhooks: string[],
): Promise<void> {
  if (webhooks.length === 0) {
    console.warn("[push] 未配置 WECOM_WEBHOOKS，跳过推送");
    return;
  }

  const rank: Record<string, number> = { 绿: 2, 黄: 1 };
  const good = posts
    .map((p) => ({ post: p, result: results.get(p.rowIndex) }))
    .filter((x) => x.result && (x.result.verdict === "绿" || x.result.verdict === "黄"))
    .sort((a, b) => {
      const d = (rank[b.result!.verdict] ?? 0) - (rank[a.result!.verdict] ?? 0);
      return d !== 0 ? d : (b.result!.score ?? 0) - (a.result!.score ?? 0);
    });

  if (good.length === 0) {
    console.log("[push] 本次没有合格内容，不推送");
    return;
  }

  const header = `**🎩 明星帽子监控** ${formatNow()}　合格 ${good.length} 条`;
  const blocks = good.map(({ post, result }) => {
    const r = result as RowResult;
    const dot = r.verdict === "绿" ? "🟢" : "🟡";
    const tier = r.tier ? `「${r.tier}」` : "";
    const celeb = r.celeb || "未知";
    const link = (post.values["微博链接"] || "").split("?")[0];
    return `${dot} **${celeb}**${tier} ${r.hatType || "帽子"}（${r.score}分）\n[查看微博](${link})`;
  });

  const messages = chunkMarkdown(header, blocks, 3500);
  for (const webhook of webhooks) {
    for (const content of messages) {
      await postWecomMarkdown(webhook, content);
      await new Promise((resolve) => setTimeout(resolve, 600)); // be gentle with the 20/min cap
    }
  }
  console.log(`[push] 已推送 ${good.length} 条到 ${webhooks.length} 个企微群`);
}

function chunkMarkdown(header: string, blocks: string[], maxBytes: number): string[] {
  const messages: string[] = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
      messages.push(current);
      current = `${header}（续）\n\n${block}`;
    } else {
      current = candidate;
    }
  }
  messages.push(current);
  return messages;
}

async function postWecomMarkdown(webhook: string, content: string): Promise<void> {
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
    });
    const data = (await response.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode !== 0) {
      console.warn(`[push] 企微返回错误: ${data.errcode} ${data.errmsg}`);
    }
  } catch (error) {
    console.warn(`[push] 推送失败: ${(error as Error).message}`);
  }
}

function formatNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function countVerdicts(results: Map<number, RowResult>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results.values()) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  }
  return counts;
}

async function loadCelebs(filePath: string): Promise<Map<string, string>> {
  if (!(await fs.pathExists(filePath))) {
    console.warn(`[score] 未找到明星名单 ${filePath}，跳过名单校验（仍用超话/@和视觉判断明星）`);
    return new Map();
  }
  try {
    return await loadCelebList(filePath);
  } catch (error) {
    console.warn(`[score] 明星名单读取失败：${(error as Error).message}；跳过名单校验`);
    return new Map();
  }
}

function loadConfig(): ScoreConfig {
  const apiKey = (process.env.MIMO_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Missing MIMO_API_KEY in .env. Add the vision model credentials first.");
  }

  return {
    apiKey,
    baseUrl: (process.env.MIMO_BASE_URL || "https://token-plan-cn.xiaomimimo.com/anthropic").trim(),
    model: (process.env.MIMO_MODEL || "mimo-v2.5").trim(),
    maxImagesPerPost: positiveInt(readCliValue("--max-images"), 1),
    maxTokens: positiveInt(process.env.MIMO_MAX_TOKENS, 1500),
    concurrency: positiveInt(readCliValue("--concurrency"), 3),
    limit: positiveInt(readCliValue("--limit"), 0),
    requestTimeoutMs: positiveInt(process.env.MIMO_TIMEOUT_MS, 120_000),
    onlyGood: process.argv.includes("--only-good"),
    celebListPath: resolveFromCwd(readCliValue("--celeb-list") || "内娱艺人带货等级清单.xlsx"),
    push: process.argv.includes("--push"),
    pushWebhooks: (process.env.WECOM_WEBHOOKS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    stateFile: resolveFromCwd(readCliValue("--state") || "social-monitor/.state/weibo-seen.json"),
    rescore: process.argv.includes("--rescore"),
  };
}

async function resolveInputPath(): Promise<string> {
  const cli = readCliValue("--input");
  if (cli) {
    return resolveFromCwd(cli);
  }

  // Default: newest weibo-posts-*.xlsx (but not an already-scored file) in output/.
  const outputDir = resolveFromCwd(process.env.OUTPUT_DIR || "output");
  const entries = (await fs.readdir(outputDir).catch(() => [])) as string[];
  const candidates = entries
    .filter((name) => name.startsWith("weibo-posts-") && name.endsWith(".xlsx"))
    .map((name) => path.join(outputDir, name));

  if (candidates.length === 0) {
    throw new Error(`No weibo-posts-*.xlsx found in ${outputDir}. Run weibo-demo.ts first or pass --input.`);
  }

  const withTime = await Promise.all(
    candidates.map(async (file) => ({ file, mtime: (await fs.stat(file)).mtimeMs })),
  );
  withTime.sort((a, b) => b.mtime - a.mtime);
  return withTime[0].file;
}

async function readWorkbook(
  inputPath: string,
): Promise<{ worksheet: ExcelJS.Worksheet; header: Map<string, number>; sourceHeaders: string[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Input workbook has no worksheet.");
  }

  const header = new Map<string, number>();
  const sourceHeaders: string[] = [];
  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell, col) => {
    const name = String(cell.value ?? "").trim();
    if (name && !header.has(name) && !SCORE_HEADER_SET.has(name)) {
      header.set(name, col);
      sourceHeaders.push(name);
    }
  });

  if (!header.has("图片链接")) {
    throw new Error("Input workbook is missing the 图片链接 column; is this a weibo-posts export?");
  }

  return { worksheet, header, sourceHeaders };
}

function collectRows(worksheet: ExcelJS.Worksheet, header: Map<string, number>): PostRow[] {
  const rows: PostRow[] = [];
  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const values: Record<string, string> = {};
    for (const name of SOURCE_COLUMNS) {
      const col = header.get(name);
      values[name] = col ? cellText(row.getCell(col)) : "";
    }

    const imageUrls = (values["图片链接"] || "").split("\n").map((v) => v.trim()).filter(Boolean);
    if (imageUrls.length === 0 && !values["正文"]) {
      continue;
    }
    rows.push({ rowIndex, values, imageUrls });
  }
  return rows;
}

interface RowResult {
  celeb: string;
  tier: string;
  verdict: string;
  score: number;
  hatVisible: string;
  hatWorn: string;
  looksCeleb: string;
  hatType: string;
  reason: string;
  analyzedImage: string;
}

async function scorePost(
  post: PostRow,
  config: ScoreConfig,
  celebs: Map<string, string>,
): Promise<RowResult> {
  // Prefer the authoritative 带货 list (gives a confirmed name + tier); fall back
  // to the 超话/@ heuristic only when the post mentions nobody on the list.
  const listHit = matchCeleb(`${post.values["作者"]}\n${post.values["正文"]}`, celebs);
  const celeb = listHit?.name || extractCeleb(post.values["作者"], post.values["正文"]);
  const tier = listHit?.tier || "";

  if (post.imageUrls.length === 0) {
    return emptyResult(celeb, tier, "无图", "该微博没有可分析的正文配图");
  }

  const urls = post.imageUrls.slice(0, config.maxImagesPerPost);
  const images: { mediaType: string; data: string }[] = [];
  for (const url of urls) {
    const img = await downloadImageAsBase64(url, config.requestTimeoutMs).catch(() => null);
    if (img) {
      images.push(img);
    }
  }

  if (images.length === 0) {
    return emptyResult(celeb, tier, "无图", "图片下载失败（可能链接过期或被风控）", urls[0] || "");
  }

  try {
    const verdict = await callVisionModel(images, celeb, post.values["正文"], config);
    return {
      celeb,
      tier,
      verdict: toTrafficLight(verdict, celeb),
      score: clampScore(verdict.score),
      hatVisible: verdict.hat_visible ? "是" : "否",
      hatWorn: verdict.person_wearing_hat ? "是" : "否",
      looksCeleb: verdict.looks_like_celebrity ? "是" : "否",
      hatType: verdict.hat_type || "",
      reason: verdict.reason || "",
      analyzedImage: urls[0] || "",
    };
  } catch (error) {
    return emptyResult(celeb, tier, "错误", `识别失败：${(error as Error).message}`.slice(0, 120), urls[0] || "");
  }
}

function emptyResult(celeb: string, tier: string, verdict: string, reason: string, image = ""): RowResult {
  return {
    celeb,
    tier,
    verdict,
    score: 0,
    hatVisible: "",
    hatWorn: "",
    looksCeleb: "",
    hatType: "",
    reason,
    analyzedImage: image,
  };
}

async function downloadImageAsBase64(
  url: string,
  timeoutMs: number,
): Promise<{ mediaType: string; data: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: "https://weibo.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { mediaType: guessMediaType(url, response.headers.get("content-type")), data: buffer.toString("base64") };
  } finally {
    clearTimeout(timer);
  }
}

function guessMediaType(url: string, contentType: string | null): string {
  if (contentType && contentType.startsWith("image/")) {
    return contentType.split(";")[0].trim();
  }
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  return "image/jpeg";
}

async function callVisionModel(
  images: { mediaType: string; data: string }[],
  celeb: string,
  caption: string,
  config: ScoreConfig,
): Promise<VisionVerdict> {
  // mimo-v2.5 occasionally appends stray prose to the JSON; retry once before giving up.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = await requestVision(images, celeb, caption, config, attempt > 0);
    try {
      return parseVerdict(text);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("vision parse failed");
}

async function requestVision(
  images: { mediaType: string; data: string }[],
  celeb: string,
  caption: string,
  config: ScoreConfig,
  strict: boolean,
): Promise<string> {
  const content: unknown[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  content.push({ type: "text", text: buildPrompt(celeb, caption, strict) });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        messages: [{ role: "user", content }],
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }

  const data = (await response.json()) as { content?: { type: string; text?: string }[] };
  return (data.content || [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function buildPrompt(celeb: string, caption: string, strict: boolean): string {
  const trimmedCaption = caption.replace(/\s+/g, " ").slice(0, 200);
  const lines = [
    "你在帮一个帽子商家筛选选题。只看两个条件：①画面里有没有清晰可见的帽子（帽子是核心产品，能看清款式最好）②戴帽子/出镜的人是不是明星。",
    "场景不限：机场街拍、综艺截图、写真、品牌「明星同款」摆拍+商品图，都算合格。不要因为不是街拍就降低评价。",
    "下面是这条微博的文字信息（仅供参考，可能有水分，请以图片为准）：",
    `疑似明星：${celeb || "未知"}`,
    `正文：${trimmedCaption}`,
    "",
    "请只根据图片判断，并只输出一个 JSON 对象，不要输出 JSON 以外的任何内容：",
    "{",
    '  "hat_visible": 画面里是否有清晰可见的帽子，无论是戴在头上还是单独的产品图(true/false),',
    '  "person_wearing_hat": 是否有真人正把帽子戴在头上(true/false),',
    '  "looks_like_celebrity": 出镜的人看起来是否像明星/艺人，即街拍、综艺、写真、红毯等专业拍摄而非普通素人自拍(true/false),',
    '  "hat_type": 帽子类型(如 棒球帽/渔夫帽/贝雷帽/针织帽/草帽/无),',
    '  "score": 0到100的整数，对「明星戴帽子」主题的相关度，以帽子是否清晰可见为主、是否明星为辅，纯商品广告且无明星给低分,',
    '  "reason": 中文一句话理由',
    "}",
  ];
  if (strict) {
    lines.push("", "重要：reason 的值必须用英文双引号包裹，整个回复只能是一个合法 JSON，不要任何解释或多余文字。");
  }
  return lines.join("\n");
}

function parseVerdict(text: string): VisionVerdict {
  const slice = extractJsonObject(text);
  if (!slice) {
    throw new Error(`no JSON in model reply: ${text.slice(0, 80)}`);
  }

  const raw = JSON.parse(slice) as Partial<VisionVerdict>;
  return {
    hat_visible: Boolean(raw.hat_visible),
    person_wearing_hat: Boolean(raw.person_wearing_hat),
    looks_like_celebrity: Boolean(raw.looks_like_celebrity),
    hat_type: String(raw.hat_type ?? "").trim(),
    score: clampScore(Number(raw.score)),
    reason: String(raw.reason ?? "").trim(),
  };
}

// Return the first complete top-level {...} object, tracking string/escape state
// so a stray Chinese sentence after the JSON (or braces inside strings) won't break us.
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

// Two conditions only: ① a clearly visible hat (the product, top priority)
// ② a celebrity. Scene (street/airport/variety/同款) does not matter.
// Celebrity signal = text super-topic/@mention (reliable) OR the image looking
// like a pro celebrity shot.
function toTrafficLight(v: VisionVerdict, celebFromText: string): string {
  if (!v.hat_visible) {
    return "红"; // 帽子是核心产品，没帽子直接淘汰
  }
  const hasCeleb = celebFromText.trim() !== "" || v.looks_like_celebrity;
  if (!hasCeleb) {
    return "红"; // 明星是必要条件
  }
  // 两个条件都满足：戴着帽子且证据足→绿；纯产品图/证据偏弱→凑活黄。
  if (v.person_wearing_hat && v.score >= 55) {
    return "绿";
  }
  return "黄";
}

// Pull a likely celebrity name from "X超话" or "@X" in the author/caption text.
function extractCeleb(author: string, caption: string): string {
  const haystack = `${author}\n${caption}`;
  const superTopic = haystack.match(/([^\s#@，,。:：]{2,12})超话/);
  if (superTopic) {
    return superTopic[1];
  }
  const mention = haystack.match(/@([^\s#，,。:：]{2,16})/);
  if (mention) {
    return mention[1];
  }
  return "";
}

// Rebuild a fresh workbook = original columns + score columns, sorted best-first.
// Building from scratch (instead of mutating the loaded sheet) avoids ExcelJS
// sparse-array column-shift bugs.
async function writeScoredWorkbook(
  posts: PostRow[],
  results: Map<number, RowResult>,
  sourceHeaders: string[],
  outputPath: string,
  onlyGood: boolean,
): Promise<number> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "weibo_monitor_score";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("scored");

  const sourceWidth: Record<string, number> = { 正文: 70, 微博链接: 60, 作者链接: 60, 图片链接: 80 };
  worksheet.columns = [
    ...sourceHeaders.map((name) => ({ header: name, key: name, width: sourceWidth[name] ?? 22 })),
    ...SCORE_COLUMNS.map((col) => ({ header: col.header, key: col.header, width: col.width })),
  ];

  const rank: Record<string, number> = { 绿: 3, 黄: 2, 红: 1 };
  // --only-good keeps just the rows that satisfy 帽子+明星 (绿/黄); everything
  // else (红/错误/无图, e.g. 盒马烧烤) is dropped so the user never sees junk.
  const visible = onlyGood
    ? posts.filter((p) => {
        const v = results.get(p.rowIndex)?.verdict;
        return v === "绿" || v === "黄";
      })
    : [...posts];
  const ordered = visible.sort((a, b) => {
    const ra = results.get(a.rowIndex);
    const rb = results.get(b.rowIndex);
    const rankDiff = (rank[rb?.verdict ?? ""] ?? 0) - (rank[ra?.verdict ?? ""] ?? 0);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return (rb?.score ?? -1) - (ra?.score ?? -1);
  });

  for (const post of ordered) {
    const result = results.get(post.rowIndex);
    const row: Record<string, string | number> = {};
    for (const name of sourceHeaders) {
      row[name] = post.values[name] ?? "";
    }
    if (result) {
      row["明星候选"] = result.celeb;
      row["带货等级"] = result.tier;
      row["综合判断"] = result.verdict;
      row["视觉相关度"] = result.verdict === "错误" || result.verdict === "无图" ? "" : result.score;
      row["帽子清晰"] = result.hatVisible;
      row["有人戴帽"] = result.hatWorn;
      row["像明星"] = result.looksCeleb;
      row["帽子类型"] = result.hatType;
      row["判断理由"] = result.reason;
      row["已分析图"] = result.analyzedImage;
    }

    const added = worksheet.addRow(row);
    const fill = result ? verdictFill(result.verdict) : null;
    if (fill) {
      added.getCell("综合判断").fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    }
  }

  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  await workbook.xlsx.writeFile(outputPath);
  return ordered.length;
}

function verdictFill(verdict: string): string | null {
  if (verdict === "绿") return "FF92D050";
  if (verdict === "黄") return "FFFFFF00";
  if (verdict === "红") return "FFFF5050";
  return null;
}

function buildOutputPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, ".xlsx").replace(/^weibo-posts-/, "weibo-scored-");
  return path.join(dir, `${base}.xlsx`);
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const size = Math.max(1, concurrency);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) {
    return "";
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text: unknown }).text ?? "");
  }
  if (typeof value === "object" && "richText" in value) {
    return (value as { richText: { text: string }[] }).richText.map((part) => part.text).join("");
  }
  return String(value);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

function readCliValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function resolveFromCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

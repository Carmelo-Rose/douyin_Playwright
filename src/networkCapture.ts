import type { Page, Response } from "playwright";
import { normalizeCandidates } from "./normalize.js";
import type { ProductRecord, RawProductCandidate } from "./types.js";

const PRODUCT_KEYS = [
  "product",
  "commodity",
  "goods",
  "item",
  "sku",
  "shop",
  "price",
  "sale",
  "douyin",
  "ecom",
];

export function attachNetworkCapture(page: Page): () => ProductRecord[] {
  const products: ProductRecord[] = [];
  const seenUrls = new Set<string>();

  page.on("response", async (response) => {
    if (!isCandidateResponse(response) || seenUrls.has(response.url())) {
      return;
    }

    seenUrls.add(response.url());

    try {
      const json = await response.json();
      const candidates = extractCandidatesFromJson(json);
      products.push(...normalizeCandidates(candidates, "network"));
    } catch {
      // Many matching responses are streaming, encrypted, or not JSON. Ignore them.
    }
  });

  return () => products;
}

export function extractCandidatesFromJson(json: unknown): RawProductCandidate[] {
  const candidates: RawProductCandidate[] = [];
  walkJson(json, candidates, 0);
  return candidates;
}

function isCandidateResponse(response: Response): boolean {
  const request = response.request();
  const resourceType = request.resourceType();
  if (!["xhr", "fetch"].includes(resourceType)) {
    return false;
  }

  const url = response.url().toLowerCase();
  const contentType = response.headers()["content-type"]?.toLowerCase() || "";
  const hasProductSignal = PRODUCT_KEYS.some((key) => url.includes(key));

  return response.status() >= 200 && response.status() < 300 && (contentType.includes("json") || hasProductSignal);
}

function walkJson(value: unknown, output: RawProductCandidate[], depth: number): void {
  if (depth > 12 || value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    if (looksLikeProductList(value)) {
      for (const item of value) {
        const candidate = objectToCandidate(item);
        if (candidate) {
          output.push(candidate);
        }
      }
      return;
    }

    for (const item of value) {
      walkJson(item, output, depth + 1);
    }
    return;
  }

  if (typeof value === "object") {
    const candidate = objectToCandidate(value);
    if (candidate) {
      output.push(candidate);
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      walkJson(child, output, depth + 1);
    }
  }
}

function looksLikeProductList(value: unknown[]): boolean {
  if (value.length === 0) {
    return false;
  }

  const sample = value.slice(0, 8);
  const matches = sample.filter((item) => Boolean(objectToCandidate(item)));
  return matches.length >= Math.min(2, sample.length);
}

function objectToCandidate(value: unknown): RawProductCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const object = value as Record<string, unknown>;
  const title = pickString(object, ["title", "name", "product_name", "goods_name", "commodity_name", "item_title"]);
  const price = pickString(object, ["price", "min_price", "real_price", "market_price", "discount_price", "sell_price"]);
  const productId = pickString(object, ["product_id", "goods_id", "commodity_id", "item_id", "sku_id", "id"]);
  const productUrl = pickString(object, ["url", "link", "schema", "detail_url", "product_url", "jump_url"]);
  const imageUrl = pickImageUrl(object);
  const shopName = pickNestedString(object, [
    "shop_name",
    "shopName",
    "shop.title",
    "shop.name",
    "seller.name",
    "store.name",
  ]);
  const salesOrHeat = pickString(object, ["sales", "sale_num", "sold_count", "hot_value", "heat", "rank_score"]);

  const signalCount = [title, price, productId, productUrl, imageUrl].filter(Boolean).length;
  if (signalCount < 2 || (!title && !productUrl)) {
    return null;
  }

  return {
    productId,
    title,
    price,
    salesOrHeat,
    shopName,
    productUrl,
    imageUrl,
    raw: value,
  };
}

function pickString(object: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }

  return "";
}

function pickNestedString(object: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (!key.includes(".")) {
      const direct = pickString(object, [key]);
      if (direct) {
        return direct;
      }
      continue;
    }

    const value = key.split(".").reduce<unknown>((current, part) => {
      if (!current || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[part];
    }, object);

    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }

  return "";
}

function pickImageUrl(object: Record<string, unknown>): string {
  const direct = pickString(object, ["image", "image_url", "img", "img_url", "cover", "cover_url", "pic_url"]);
  if (direct) {
    return direct;
  }

  for (const key of ["images", "imgs", "covers", "pic_urls"]) {
    const value = object[key];
    if (Array.isArray(value)) {
      const first = value[0];
      if (typeof first === "string") {
        return first;
      }
      if (first && typeof first === "object") {
        const nested = pickString(first as Record<string, unknown>, ["url", "uri", "image_url"]);
        if (nested) {
          return nested;
        }
      }
    }
  }

  return "";
}

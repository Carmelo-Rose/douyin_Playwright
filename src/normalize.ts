import type { CaptureSource, ProductRecord, RawProductCandidate } from "./types.js";

export function normalizeCandidates(candidates: RawProductCandidate[], source: CaptureSource): ProductRecord[] {
  const capturedAt = new Date().toISOString();
  const products = candidates
    .map((candidate) => normalizeCandidate(candidate, source, capturedAt))
    .filter((product): product is ProductRecord => Boolean(product));

  return dedupeProducts(products);
}

export function dedupeProducts(products: ProductRecord[]): ProductRecord[] {
  const seen = new Set<string>();
  const result: ProductRecord[] = [];

  for (const product of products) {
    const key = product.productId || product.productUrl || product.title;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(product);
  }

  return result;
}

function normalizeCandidate(candidate: RawProductCandidate, source: CaptureSource, capturedAt: string): ProductRecord | null {
  const title = cleanText(candidate.title);
  const productUrl = cleanText(candidate.productUrl);
  const productId = cleanText(candidate.productId) || inferProductId(productUrl);

  if (!title && !productUrl && !productId) {
    return null;
  }

  return {
    productId,
    title,
    price: normalizePrice(candidate.price),
    salesOrHeat: cleanText(candidate.salesOrHeat),
    shopName: cleanText(candidate.shopName),
    productUrl,
    imageUrl: cleanText(candidate.imageUrl),
    source,
    capturedAt,
    rawSnippet: toRawSnippet(candidate.raw),
  };
}

export function cleanText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).replace(/\s+/g, " ").trim();
}

function normalizePrice(value: unknown): string {
  const text = cleanText(value);
  if (!text) {
    return "";
  }

  return text.startsWith("¥") ? text : text.replace(/^￥/, "¥");
}

function inferProductId(url: string): string {
  const match = url.match(/(?:commodity|product|item|goods)[=/_-]?(\d{5,})|\/(\d{8,})(?:[/?#]|$)/i);
  return match?.[1] || match?.[2] || "";
}

function toRawSnippet(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 500);
  } catch {
    return "";
  }
}

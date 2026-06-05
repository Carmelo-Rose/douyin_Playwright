export function normalizeImageUrlList(values: Array<string | undefined | null>): string[] {
  const urlsByKey = new Map<string, string>();

  for (const value of values) {
    const url = (value ?? "").trim();
    if (!url) {
      continue;
    }

    const key = resolveImageDedupeKey(url);
    const existing = urlsByKey.get(key);
    if (!existing || scoreImageUrl(url) > scoreImageUrl(existing)) {
      urlsByKey.set(key, url);
    }
  }

  return Array.from(urlsByKey.values());
}

function resolveImageDedupeKey(url: string): string {
  const parsed = tryParseUrl(url);
  if (!parsed) {
    return url;
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = decodeURIComponent(parsed.pathname);
  if (host.includes("xhscdn.com") || host.includes("xiaohongshu.com")) {
    const filename = pathname.split("/").filter(Boolean).at(-1) ?? pathname;
    return `xhs:${filename.replace(/!.+$/, "")}`;
  }

  parsed.hash = "";
  return parsed.toString();
}

function scoreImageUrl(url: string): number {
  const lowerUrl = url.toLowerCase();
  let score = 0;

  if (lowerUrl.startsWith("https://")) score += 1;
  if (/!nc_n_webp_mw_\d+/.test(lowerUrl)) score += 30;
  if (/origin|large/.test(lowerUrl)) score += 20;
  if (/!nc_n_webp_prv_\d+|thumb|thumbnail|small/.test(lowerUrl)) score += 5;

  return score;
}

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

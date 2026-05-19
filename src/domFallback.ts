import type { Page } from "playwright";
import { normalizeCandidates } from "./normalize.js";
import type { ProductRecord, RawProductCandidate } from "./types.js";

export async function collectProductsFromDom(page: Page): Promise<ProductRecord[]> {
  const candidates = await page.evaluate<RawProductCandidate[]>(() => {
    const selectors = [
      "[data-ecom-item-id]",
      "[data-item-id]",
      "[data-product-id]",
      "a[href*='item']",
      "a[href*='product']",
      "a[href*='goods']",
      "a[href*='commodity']",
    ];
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selectors.join(",")));
    const cards = new Set<HTMLElement>();

    for (const node of nodes) {
      cards.add(findLikelyCard(node));
    }

    return Array.from(cards).map((card) => {
      const link = card.matches("a") ? card as HTMLAnchorElement : card.querySelector<HTMLAnchorElement>("a[href]");
      const image = card.querySelector<HTMLImageElement>("img");
      const text = normalizeText(card.innerText || card.textContent || "");
      const priceMatch = text.match(/[¥￥]\s?\d+(?:\.\d+)?|\d+(?:\.\d+)?\s?元/);
      const salesMatch = text.match(/(?:已售|销量|热度|人付款|件售出|sold)\s*[:：]?\s*[\d.万wW+]+/i);
      const title = pickTitle(card, text, priceMatch?.[0] || "");

      return {
        productId: card.dataset.ecomItemId || card.dataset.itemId || card.dataset.productId || "",
        title,
        price: priceMatch?.[0] || "",
        salesOrHeat: salesMatch?.[0] || "",
        shopName: "",
        productUrl: link?.href || "",
        imageUrl: image?.currentSrc || image?.src || "",
        raw: {
          text: text.slice(0, 500),
          href: link?.href || "",
        },
      };
    });

    function findLikelyCard(node: HTMLElement): HTMLElement {
      let current: HTMLElement | null = node;
      for (let i = 0; i < 4 && current?.parentElement; i += 1) {
        const text = normalizeText(current.innerText || current.textContent || "");
        const hasImage = Boolean(current.querySelector("img"));
        const hasPrice = /[¥￥]\s?\d+|\d+(?:\.\d+)?\s?元/.test(text);
        if (hasImage && hasPrice && text.length > 8) {
          return current;
        }
        current = current.parentElement;
      }
      return node;
    }

    function pickTitle(card: HTMLElement, text: string, price: string): string {
      const explicit = card.querySelector<HTMLElement>("[title], [aria-label]");
      const attrTitle = explicit?.getAttribute("title") || explicit?.getAttribute("aria-label");
      if (attrTitle) {
        return normalizeText(attrTitle);
      }

      return text.replace(price, "").split(/\s{2,}|\n/).map(normalizeText).find((part) => part.length >= 4) || "";
    }

    function normalizeText(value: string): string {
      return value.replace(/\s+/g, " ").trim();
    }
  });

  return normalizeCandidates(candidates, "dom");
}

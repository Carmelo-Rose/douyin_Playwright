export type CaptureSource = "network" | "dom";

export interface ProductRecord {
  productId: string;
  title: string;
  price: string;
  salesOrHeat: string;
  shopName: string;
  productUrl: string;
  imageUrl: string;
  source: CaptureSource;
  capturedAt: string;
  rawSnippet: string;
}

export interface RawProductCandidate {
  productId?: string;
  title?: string;
  price?: string | number;
  salesOrHeat?: string | number;
  shopName?: string;
  productUrl?: string;
  imageUrl?: string;
  raw: unknown;
}

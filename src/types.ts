export interface VideoRecord {
  awemeId: string;
  source: string;
  desc: string;
  createTime: string;
  authorName: string;
  authorSecUid: string;
  diggCount: number;
  commentCount: number;
  shareCount: number;
  collectCount: number;
  playCount: number;
  shareUrl: string;
  coverUrl: string;
  capturedAt: string;
  rawSnippet: string;
}

export interface RawVideoCandidate {
  awemeId?: string;
  desc?: string;
  createTime?: number;
  authorName?: string;
  authorSecUid?: string;
  diggCount?: number;
  commentCount?: number;
  shareCount?: number;
  collectCount?: number;
  playCount?: number;
  shareUrl?: string;
  coverUrl?: string;
  raw: unknown;
}

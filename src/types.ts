export type Platform = "douyin" | "xhs" | "all";

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

export interface NoteRecord {
  noteId: string;
  source: string;
  noteType: string;
  title: string;
  desc: string;
  createTime: string;
  authorName: string;
  authorId: string;
  likedCount: number;
  commentCount: number;
  collectCount: number;
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

export interface RawNoteCandidate {
  noteId?: string;
  noteType?: string;
  title?: string;
  desc?: string;
  createTime?: number | string;
  authorName?: string;
  authorId?: string;
  likedCount?: number;
  commentCount?: number;
  collectCount?: number;
  shareUrl?: string;
  coverUrl?: string;
  raw: unknown;
}

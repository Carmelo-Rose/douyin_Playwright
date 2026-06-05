export type Platform = "douyin" | "xhs" | "all";
export type ContentType = "image" | "video";

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
  imageUrls: string[];
  detailImageStatus: string;
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
  linkStatus: string;
  coverUrl: string;
  imageUrls: string[];
  detailImageStatus: string;
  visualQualified?: string;
  visualScore?: number;
  visualReason?: string;
  visualHatType?: string;
  visualStatus?: string;
  visualAnalyzedImages?: string;
  capturedAt: string;
  rawSnippet: string;
}

export interface RawVideoCandidate {
  awemeId?: string;
  awemeType?: number;
  mediaType?: number;
  isImagePost?: boolean;
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
  imageUrls?: string[];
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
  xsecToken?: string;
  xsecSource?: string;
  coverUrl?: string;
  imageUrls?: string[];
  raw: unknown;
}

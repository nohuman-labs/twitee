export type XSearchIntent = "profile" | "unified";
export type XSearchMode = "people" | "latest";
export type XSearchStatus =
  | "ready"
  | "loading"
  | "loading_more"
  | "error"
  | "rate_limited"
  | "end"
  | "temporary_empty";

export interface XSearchIntentResult {
  rawQuery: string;
  normalizedQuery: string;
  intent: XSearchIntent;
  handle: string | null;
  profileUrl: string | null;
}

export interface XPeopleCandidate {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followerCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  verified: boolean;
  rank: number;
  sourceUrl: string;
}

export interface XVideoSource {
  type: string;
  url: string;
  bitrate?: number;
}

export interface XLatestPostResult {
  externalId: string | null;
  sourceUrl: string;
  authorHandle: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  isPinned?: boolean;
  isRepost?: boolean;
  repostedByHandle?: string | null;
  repostedByDisplayName?: string | null;
  repostedByAvatarUrl?: string | null;
  text: string | null;
  postedAt: string | null;
  replyCount: number | null;
  repostCount: number | null;
  quoteCount: number | null;
  likeCount: number | null;
  viewCount: number | null;
  media: Array<{
    mediaType: "photo" | "video" | "unknown";
    mediaUrl: string;
    thumbnailUrl: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    sources?: XVideoSource[];
  }>;
  quotedPost?: XQuotedPostResult | null;
  rank: number;
}

export type XQuotedPostResult = Omit<
  XLatestPostResult,
  | "isRepost"
  | "quotedPost"
  | "rank"
  | "repostedByAvatarUrl"
  | "repostedByDisplayName"
  | "repostedByHandle"
>;

export interface XProfile {
  username: string;
  sourceProfileId: string | null;
  displayName: string | null;
  bio: string | null;
  followerCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  listedCount: number | null;
  location: string | null;
  joinedAt: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  websiteUrl: string | null;
  isVerified: boolean | null;
  sensitiveLabel: string | null;
}

export interface XSearchParseResult<TItem> {
  items: TItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface XSearchPageState {
  pageDepth: number;
  seenHandles: string[];
  seenPostIds: string[];
  seenSourceUrls: string[];
  extractionMethod: "dom" | "graphql" | "mixed";
  scrollAttempts: number;
  lastVisibleItemCount: number;
  hasMore: boolean | "unknown";
  parentCacheId: string | null;
}

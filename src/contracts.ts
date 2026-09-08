import { z } from "zod";

export type ApiErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "not_authenticated"
  | "not_found"
  | "protected_account"
  | "rate_limited"
  | "queue_full"
  | "browser_unavailable"
  | "upstream_timeout"
  | "upstream_changed"
  | "internal_error";

export type ApiEnvelope<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly next_cursor: string | null;
      readonly error: null;
    }
  | {
      readonly ok: false;
      readonly data: null;
      readonly next_cursor: null;
      readonly error: { readonly code: ApiErrorCode; readonly message: string };
    };

export type Profile = {
  readonly handle: string;
  readonly sourceProfileId?: string | null;
  readonly displayName?: string | null;
  readonly avatarUrl?: string | null;
  readonly bannerUrl?: string | null;
  readonly bio?: string | null;
  readonly location?: string | null;
  readonly websiteUrl?: string | null;
  readonly isVerified?: boolean;
  readonly sensitiveLabel?: string | null;
  readonly availabilityStatus:
    | "available"
    | "protected"
    | "not_found"
    | "unavailable"
    | "suspended";
  readonly sourceUrl?: string | null;
  readonly stats?: {
    readonly followersCount?: number;
    readonly followingCount?: number;
    readonly postsCount?: number;
    readonly listedCount?: number | null;
    readonly sourceUrl?: string | null;
  };
};

export type Post = {
  readonly sourcePostId: string;
  readonly handle: string;
  readonly displayName?: string | null;
  readonly avatarUrl?: string | null;
  readonly isPinned?: boolean;
  readonly isRepost?: boolean;
  readonly repostedByHandle?: string | null;
  readonly repostedByDisplayName?: string | null;
  readonly repostedByAvatarUrl?: string | null;
  readonly text: string;
  readonly postedAt: string;
  readonly likeCount?: number;
  readonly repostCount?: number;
  readonly replyCount?: number;
  readonly quoteCount?: number;
  readonly viewCount?: number | null;
  readonly media?: readonly Record<string, unknown>[];
  readonly sensitiveLabel?: string | null;
  readonly isReply?: boolean;
  readonly quotedPost?: {
    readonly sourcePostId: string | null;
    readonly handle: string;
    readonly displayName?: string | null;
    readonly avatarUrl?: string | null;
    readonly text: string;
    readonly postedAt: string | null;
    readonly media?: readonly Record<string, unknown>[];
    readonly sourceUrl?: string | null;
  } | null;
  readonly sourceUrl?: string | null;
};

export type PeopleSearchItem = {
  readonly rank: number;
  readonly handle: string;
  readonly displayName?: string | null;
  readonly avatarUrl?: string | null;
  readonly bio?: string | null;
  readonly followersCount?: number | null;
  readonly verified?: boolean;
  readonly sourceUrl?: string | null;
};

export type Page<T> = {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
};

const handleSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{1,15}$/, "invalid X handle"));

const postIdSchema = z.string().regex(/^\d+$/, "invalid X post id");

export function normalizeHandle(value: string): string {
  return handleSchema.parse(value);
}

export function parsePostId(value: string): string {
  return postIdSchema.parse(value);
}

export function parseQuery(value: string): string {
  const query = value.trim();
  if (query.length === 0 || Array.from(query).length > 512) {
    throw new Error("query must contain 1-512 characters");
  }
  return query;
}

export function parseCursor(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (Buffer.byteLength(value, "utf8") > 4096) {
    throw new Error("cursor must not exceed 4096 bytes");
  }
  return value;
}

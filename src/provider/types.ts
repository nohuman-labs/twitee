import type { RuntimeContext } from "../browser.js";
import type { PeopleSearchItem, Post, Profile } from "../contracts.js";

export type ProviderContinuation = {
  readonly cursor: string | null;
  readonly pageDepth: number | null;
};

export type ProviderCallContext = {
  readonly browserContext: RuntimeContext;
  readonly continuation?: ProviderContinuation | null;
};

export type ProviderOutcome<T> =
  | {
      readonly type: "success";
      readonly data: T;
      readonly nextCursor?: string | null;
      readonly providerHasMore?: boolean;
    }
  | { readonly type: "temporary_empty" }
  | { readonly type: "protected"; readonly data?: T }
  | { readonly type: "not_found" }
  | { readonly type: "deleted_or_suspended" }
  | {
      readonly type: "provider_rate_limited";
      readonly retryAfterSeconds: number;
    }
  | { readonly type: "browser_crash"; readonly message?: string };

export type XProvider = {
  searchPeople(
    query: string,
    context: ProviderCallContext,
  ): Promise<ProviderOutcome<readonly PeopleSearchItem[]>>;
  searchLatest(
    query: string,
    context: ProviderCallContext,
  ): Promise<ProviderOutcome<readonly Post[]>>;
  openProfile(
    handle: string,
    context: ProviderCallContext,
  ): Promise<ProviderOutcome<Profile>>;
  listPosts(
    handle: string,
    context: ProviderCallContext,
  ): Promise<ProviderOutcome<readonly Post[]>>;
  openPost(
    handle: string,
    sourcePostId: string,
    context: ProviderCallContext,
  ): Promise<ProviderOutcome<Post>>;
};

export class ProviderCaptureTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCaptureTimeoutError";
  }
}

export class ProviderHttpError extends Error {
  constructor(readonly providerHttpStatus: number) {
    super(`X provider returned HTTP ${providerHttpStatus}`);
    this.name = "ProviderHttpError";
  }
}

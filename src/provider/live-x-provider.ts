import pino from "pino";
import type { Page, Response as PlaywrightResponse } from "playwright-core";
import type {
  PeopleSearchItem as SearchPeopleResult,
  Post as SearchLatestPost,
  Profile as ProfilePayload,
} from "../contracts.js";
import type { RuntimePage } from "../browser.js";
import { sanitizePayload as sanitizeCrawlerPayload } from "../sanitize.js";
import {
  type ProviderOutcome as FixtureOutcome,
  type XProvider as FixtureProvider,
  type ProviderCallContext,
  ProviderCaptureTimeoutError,
  ProviderHttpError,
} from "./types.js";
import {
  type XProfileGraphqlDiagnostic,
  evidenceFields,
  extractXProfileEvidence,
  graphProfileUnavailableReason,
  hasUsefulXProfile,
  mergeProfile,
  normalizeXHandle,
  profileUnavailableReason,
  startXProfileGraphqlCapture,
} from "./profile-extraction.js";
import {
  collectRenderedSearchSnapshot,
  extractLatestFromSnapshot,
  extractPeopleFromSnapshot,
} from "./rendered-extraction.js";
import { xSearchUrl } from "./search-intent.js";
import {
  isCompleteSearchTimelinePayload,
  parseLatestPostsFromSearch,
  parsePeopleFromSearch,
  summarizeLatestSearchPayloadForDebug,
} from "./search-parsers.js";
import type {
  XLatestPostResult,
  XPeopleCandidate,
  XSearchMode,
  XSearchParseResult,
} from "./search-types.js";

type LiveXPage = RuntimePage & Page;

type GraphqlCapture = {
  readonly payload: unknown;
  readonly url: string;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly postData: string | null;
    readonly headers: Record<string, string>;
  };
};

type GraphqlCaptureWaiter = {
  readonly promise: Promise<GraphqlCapture>;
  cancel(): void;
};

type SearchCaptureDebugContext = {
  readonly label:
    | "search_latest"
    | "search_people"
    | "profile_posts"
    | "profile";
  readonly query: string;
  readonly continuation: boolean;
  readonly cursorPresent: boolean;
};

type SearchCaptureOptions = {
  readonly debugContext?: SearchCaptureDebugContext;
  readonly continuationStrategy?: "fetch" | "scroll";
  readonly rejectNonSuccessfulContinuationResponse?: boolean;
  readonly continuationCaptureTimeoutMs?: number;
  readonly continuationMaxScrollAttempts?: number;
  readonly continuationReplayDepth?: number;
  readonly preserveDuplicateItems?: boolean;
  readonly scrollWaitMs?: number;
};

type PageLogLevel = "debug" | "info" | "warn" | "error";

type RetainedLatestPageState = {
  readonly query: string;
  readonly pageDepth: number;
  readonly nextCursor: string | null;
};

const crawlerLogger = pino({
  base: null,
  level: readCrawlerLogLevel(
    process.env.TWITEE_LOG_LEVEL ?? process.env.LOG_LEVEL,
  ),
  messageKey: "event",
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    censor: "[REDACTED]",
    paths: [
      "request.headers.authorization",
      "request.headers.cookie",
      "request.headers['x-csrf-token']",
      "request.headers['x-client-transaction-id']",
      "request.query.authorization",
      "request.query.cookie",
      "request.query.token",
      "request.query.variables",
      "request.body.authorization",
      "request.body.cookie",
      "request.body.token",
    ],
  },
}).child({ component: "twitee-crawler" });

type ScrollLoadMoreResult = {
  readonly items: readonly (XPeopleCandidate | XLatestPostResult)[];
  readonly temporaryStateDetected: boolean;
};

export type LiveXProviderOptions = {
  readonly waitForResultsMs?: number;
  readonly navigationTimeoutMs?: number;
  readonly maxSearchPeopleResults?: number;
  readonly maxSearchLatestResults?: number;
  readonly graphCaptureTimeoutMs?: number;
  readonly loadMoreMaxScrollAttempts?: number;
  readonly loadMoreIdleAttempts?: number;
  readonly scrollWaitMs?: number;
  readonly profileEvidenceTimeoutMs?: number;
  readonly now?: () => Date;
};

export function createLiveXProvider(
  options: LiveXProviderOptions = {},
): FixtureProvider {
  const waitForResultsMs = options.waitForResultsMs ?? 1_500;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
  const maxSearchPeopleResults = options.maxSearchPeopleResults ?? 20;
  const maxSearchLatestResults = options.maxSearchLatestResults ?? 40;
  const graphCaptureTimeoutMs = options.graphCaptureTimeoutMs ?? 10_000;
  const loadMoreMaxScrollAttempts = options.loadMoreMaxScrollAttempts ?? 8;
  const loadMoreIdleAttempts = options.loadMoreIdleAttempts ?? 2;
  const scrollWaitMs = options.scrollWaitMs ?? 700;
  const profileEvidenceTimeoutMs = options.profileEvidenceTimeoutMs ?? 6_000;
  const now = options.now ?? (() => new Date());
  const retainedPeoplePages = new WeakMap<LiveXPage, RetainedLatestPageState>();
  const retainedLatestPages = new WeakMap<LiveXPage, RetainedLatestPageState>();
  return {
    async searchPeople(query, context) {
      const page = livePage(context);
      if (!page) {
        return browserCrash("Live X provider requires an opened browser page.");
      }

      const normalizedQuery = query.trim().toLowerCase();
      const sourceUrl = xSearchUrl(normalizedQuery, "people");
      const continuation = context?.continuation ?? null;
      const continuationCursor = continuation?.cursor ?? null;
      const continuationPageDepth = continuation?.pageDepth ?? null;
      const retainedState = retainedPeoplePages.get(page);
      const canContinueRetainedPage = Boolean(
        continuationCursor &&
          retainedState?.query === normalizedQuery &&
          retainedState.pageDepth + 1 === continuationPageDepth &&
          retainedState.nextCursor === continuationCursor &&
          typeof page.url === "function" &&
          page.url() === sourceUrl,
      );
      if (
        canContinueRetainedPage &&
        continuationCursor !== null &&
        continuationPageDepth !== null
      ) {
        const graphqlPage = await captureSearchContinuationByScroll({
          page,
          mode: "people",
          limit: maxSearchPeopleResults,
          cursor: continuationCursor,
          initialParsed: {
            items: [],
            nextCursor: continuationCursor,
            hasMore: true,
          },
          timeoutMs: graphCaptureTimeoutMs,
          maxScrollAttempts: 1,
          preserveDuplicateItems: true,
          scrollWaitMs,
          debugContext: {
            label: "search_people",
            query,
            continuation: true,
            cursorPresent: true,
          },
        });
        const graphqlPeople = graphqlPage.items.filter(isPeopleCandidate);
        if (graphqlPeople.length) {
          retainedPeoplePages.set(page, {
            query: normalizedQuery,
            pageDepth: continuationPageDepth,
            nextCursor: graphqlPage.nextCursor,
          });
          return {
            type: "success",
            data: graphqlPeople.map(mapPeople),
            nextCursor: graphqlPage.nextCursor,
          };
        }
        retainedPeoplePages.delete(page);
        return { type: "temporary_empty" };
      }

      retainedPeoplePages.delete(page);
      const payloadWaiter = waitForSearchGraphqlPayload(
        page,
        graphCaptureTimeoutMs,
        "people",
        maxSearchPeopleResults,
      );
      try {
        await gotoPage(page, sourceUrl, navigationTimeoutMs);
        await waitForSearchDomStabilization(page, waitForResultsMs);

        const graphqlPage = await captureSearchPage(
          page,
          payloadWaiter,
          "people",
          maxSearchPeopleResults,
          context?.continuation?.cursor ?? null,
          {
            debugContext: {
              label: "search_people",
              query,
              continuation: Boolean(context?.continuation?.cursor),
              cursorPresent: Boolean(context?.continuation?.cursor),
            },
            continuationStrategy: context?.continuation?.cursor
              ? "scroll"
              : "fetch",
            continuationCaptureTimeoutMs: graphCaptureTimeoutMs,
            continuationMaxScrollAttempts: Math.max(
              loadMoreMaxScrollAttempts,
              (context?.continuation?.pageDepth ?? 0) + 2,
            ),
            ...(context?.continuation?.cursor
              ? {
                  continuationReplayDepth: context.continuation.pageDepth ?? 1,
                }
              : {}),
            scrollWaitMs,
          },
        );
        const graphqlPeople = graphqlPage.items.filter(isPeopleCandidate);
        if (graphqlPeople.length) {
          retainedPeoplePages.set(page, {
            query: normalizedQuery,
            pageDepth: continuation?.pageDepth ?? 0,
            nextCursor: graphqlPage.nextCursor,
          });
          return {
            type: "success",
            data: graphqlPeople.map(mapPeople),
            nextCursor: graphqlPage.nextCursor,
          };
        }

        if (context?.continuation?.cursor) {
          return { type: "temporary_empty" };
        }

        const snapshot = await collectRenderedSearchSnapshot(page);
        if (renderedSearchIsTemporary(snapshot)) {
          return { type: "provider_rate_limited", retryAfterSeconds: 300 };
        }
        return { type: "temporary_empty" };
      } finally {
        payloadWaiter.cancel();
      }
    },

    async searchLatest(query, context) {
      const page = livePage(context);
      if (!page) {
        return browserCrash("Live X provider requires an opened browser page.");
      }

      const normalizedQuery = query.trim().toLowerCase();
      const sourceUrl = xSearchUrl(normalizedQuery, "latest");
      const continuation = context?.continuation ?? null;
      const continuationCursor = continuation?.cursor ?? null;
      const continuationPageDepth = continuation?.pageDepth ?? null;
      const retainedState = retainedLatestPages.get(page);
      const canContinueRetainedPage = Boolean(
        continuationCursor &&
          retainedState?.query === normalizedQuery &&
          retainedState.pageDepth + 1 === continuationPageDepth &&
          retainedState.nextCursor === continuationCursor &&
          typeof page.url === "function" &&
          page.url() === sourceUrl,
      );
      if (
        canContinueRetainedPage &&
        continuationCursor !== null &&
        continuationPageDepth !== null
      ) {
        const graphqlPage = await captureSearchContinuationByScroll({
          page,
          mode: "latest",
          limit: maxSearchLatestResults,
          cursor: continuationCursor,
          initialParsed: {
            items: [],
            nextCursor: continuationCursor,
            hasMore: true,
          },
          timeoutMs: graphCaptureTimeoutMs,
          maxScrollAttempts: 1,
          preserveDuplicateItems: true,
          scrollWaitMs,
          debugContext: {
            label: "search_latest",
            query,
            continuation: true,
            cursorPresent: true,
          },
        });
        const graphqlPosts = mapLatestResults(
          graphqlPage.items.filter(isLatestPost),
          { fallbackPostedAt: now().toISOString() },
        );
        if (graphqlPosts.length) {
          retainedLatestPages.set(page, {
            query: normalizedQuery,
            pageDepth: continuationPageDepth,
            nextCursor: graphqlPage.nextCursor,
          });
          return {
            type: "success",
            data: graphqlPosts,
            nextCursor: graphqlPage.nextCursor,
          };
        }
        retainedLatestPages.delete(page);
        return { type: "temporary_empty" };
      }

      retainedLatestPages.delete(page);
      const payloadWaiter = waitForSearchGraphqlPayload(
        page,
        graphCaptureTimeoutMs,
        "latest",
        maxSearchLatestResults,
      );
      try {
        await gotoPage(page, sourceUrl, navigationTimeoutMs);
        await waitForSearchDomStabilization(page, waitForResultsMs);

        const graphqlPage = await captureSearchPage(
          page,
          payloadWaiter,
          "latest",
          maxSearchLatestResults,
          context?.continuation?.cursor ?? null,
          {
            debugContext: {
              label: "search_latest",
              query,
              continuation: Boolean(context?.continuation?.cursor),
              cursorPresent: Boolean(context?.continuation?.cursor),
            },
            continuationStrategy: context?.continuation?.cursor
              ? "scroll"
              : "fetch",
            continuationCaptureTimeoutMs: graphCaptureTimeoutMs,
            continuationMaxScrollAttempts: Math.max(
              loadMoreMaxScrollAttempts,
              (context?.continuation?.pageDepth ?? 0) + 2,
            ),
            ...(context?.continuation?.cursor
              ? {
                  continuationReplayDepth: context.continuation.pageDepth ?? 1,
                  preserveDuplicateItems: true,
                }
              : {}),
            scrollWaitMs,
          },
        );
        const graphqlLatest = graphqlPage.items.filter(isLatestPost);
        const graphqlPosts = mapLatestResults(graphqlLatest, {
          fallbackPostedAt: now().toISOString(),
        });
        if (continuation?.cursor) {
          if (!graphqlPosts.length) return { type: "temporary_empty" };
          retainedLatestPages.set(page, {
            query: normalizedQuery,
            pageDepth: continuation.pageDepth ?? 1,
            nextCursor: graphqlPage.nextCursor,
          });
          return {
            type: "success",
            data: graphqlPosts,
            nextCursor: graphqlPage.nextCursor,
          };
        }

        if (graphqlPosts.length) {
          retainedLatestPages.set(page, {
            query: normalizedQuery,
            pageDepth: 0,
            nextCursor: graphqlPage.nextCursor,
          });
          return {
            type: "success",
            data: graphqlPosts,
            nextCursor: graphqlPage.nextCursor,
          };
        }

        const snapshot = await collectRenderedSearchSnapshot(page);
        if (renderedSearchIsTemporary(snapshot)) {
          return { type: "provider_rate_limited", retryAfterSeconds: 300 };
        }
        return { type: "temporary_empty" };
      } finally {
        payloadWaiter.cancel();
      }
    },

    async openProfile(handle, context) {
      const page = livePage(context);
      if (!page) {
        return browserCrash("Live X provider requires an opened browser page.");
      }

      const normalized = normalizeXHandle(handle);
      const profileGraphqlDiagnostic = crawlerLogger.isLevelEnabled("debug")
        ? (diagnostic: XProfileGraphqlDiagnostic) => {
            logPageEvent(
              "debug",
              {
                label: "profile",
                query: normalized,
                continuation: false,
                cursorPresent: false,
              },
              "profile_request_response",
              {
                ...diagnostic,
                responseHeaders: sanitizeCrawlerPayload(
                  diagnostic.responseHeaders,
                ),
                responseData: sanitizeCrawlerPayload(diagnostic.responseData),
              },
            );
          }
        : undefined;
      const graphProfilePromise = startXProfileGraphqlCapture(
        page,
        normalized,
        graphCaptureTimeoutMs,
        profileGraphqlDiagnostic,
      );
      await gotoPage(
        page,
        `https://x.com/${encodeURIComponent(normalized)}`,
        navigationTimeoutMs,
      );
      const evidence = await extractXProfileEvidence({
        page,
        handle: normalized,
        graphCaptureTimeoutMs,
        domStabilizationMs: waitForResultsMs,
        evidenceTimeoutMs: profileEvidenceTimeoutMs,
        graphProfilePromise,
      });
      logPageEvent(
        "info",
        {
          label: "profile",
          query: normalized,
          continuation: false,
          cursorPresent: false,
        },
        "profile_evidence",
        {
          title: evidence.title,
          currentUrl: evidence.currentUrl,
          hasGraphProfile: Boolean(evidence.graphProfile),
          hasFallbackProfile: Boolean(evidence.fallbackProfile),
          graphFields: evidenceFields(evidence.graphProfile),
          fallbackFields: evidenceFields(evidence.fallbackProfile),
        },
      );
      const unavailableReason =
        graphProfileUnavailableReason(evidence.graphProfile) ??
        profileUnavailableReason({
          handle: normalized,
          title: evidence.title,
          bodyText: evidence.bodyText,
          currentUrl: evidence.currentUrl,
        });
      if (unavailableReason === "protected_profile") {
        const merged = mergeProfile(
          normalized,
          evidence.graphProfile,
          evidence.fallbackProfile,
        );
        return {
          type: "protected",
          data: merged
            ? {
                ...mapProfile(normalized, merged),
                availabilityStatus: "protected",
              }
            : {
                handle: normalized,
                availabilityStatus: "protected",
                sourceUrl: `https://x.com/${normalized}`,
              },
        };
      }
      if (unavailableReason) {
        return mapProfileUnavailable(unavailableReason);
      }

      const merged = mergeProfile(
        normalized,
        evidence.graphProfile,
        evidence.fallbackProfile,
      );
      if (!merged || !hasUsefulXProfile(merged)) {
        return { type: "temporary_empty" };
      }

      return { type: "success", data: mapProfile(normalized, merged) };
    },

    async listPosts(handle, context) {
      const page = livePage(context);
      if (!page) {
        return browserCrash("Live X provider requires an opened browser page.");
      }

      const normalized = normalizeXHandle(handle);
      const payloadWaiter = waitForProfileTimelineGraphqlPayload(
        page,
        graphCaptureTimeoutMs,
      );
      try {
        await gotoPage(
          page,
          `https://x.com/${encodeURIComponent(normalized)}`,
          navigationTimeoutMs,
        );
        await waitForSearchDomStabilization(page, waitForResultsMs);

        const sensitiveProfileButton = page.getByRole("button", {
          name: "Yes, view profile",
          exact: true,
        });
        if (await sensitiveProfileButton.isVisible()) {
          await sensitiveProfileButton.click();
          await waitForSearchDomStabilization(page, waitForResultsMs);
        }

        const graphqlPage = await captureSearchPage(
          page,
          payloadWaiter,
          "latest",
          maxSearchLatestResults,
          context?.continuation?.cursor ?? null,
          {
            rejectNonSuccessfulContinuationResponse: true,
            debugContext: {
              label: "profile_posts",
              query: normalized,
              continuation: Boolean(context?.continuation?.cursor),
              cursorPresent: Boolean(context?.continuation?.cursor),
            },
          },
        );
        if (graphqlPage.items.length) {
          const posts = mapLatestResults(
            graphqlPage.items.filter(isLatestPost),
            {
              forcedHandle: normalized,
              fallbackPostedAt: now().toISOString(),
            },
          );
          if (posts.length) {
            return {
              type: "success",
              data: posts,
              nextCursor: graphqlPage.nextCursor,
              providerHasMore: graphqlPage.hasMore,
            };
          }
        }

        const loaded = await collectScrollLoadMore({
          page,
          mode: "latest",
          limit: maxSearchLatestResults,
          loadMoreMaxScrollAttempts,
          loadMoreIdleAttempts,
          scrollWaitMs,
        });
        if (loaded.temporaryStateDetected) {
          return { type: "provider_rate_limited", retryAfterSeconds: 300 };
        }
        const posts = loaded.items.filter(isLatestPost);
        const mappedPosts = mapLatestResults(posts, {
          forcedHandle: normalized,
          fallbackPostedAt: now().toISOString(),
        });
        return mappedPosts.length
          ? {
              type: "success",
              data: mappedPosts,
              providerHasMore: false,
            }
          : { type: "temporary_empty" };
      } finally {
        payloadWaiter.cancel();
      }
    },

    async openPost(handle, sourcePostId, context) {
      const page = livePage(context);
      if (!page) {
        return browserCrash("Live X provider requires an opened browser page.");
      }

      const normalized = normalizeXHandle(handle);
      const postId = sourcePostId.trim();
      const payloadWaiter = waitForPostDetailGraphqlPayload(
        page,
        graphCaptureTimeoutMs,
      );
      try {
        await gotoPage(
          page,
          `https://x.com/${encodeURIComponent(normalized)}/status/${encodeURIComponent(postId)}`,
          navigationTimeoutMs,
        );
        await waitForSearchDomStabilization(page, waitForResultsMs);

        let capture: GraphqlCapture | null = null;
        try {
          capture = await payloadWaiter.promise;
        } catch (error) {
          const rendered = await renderedPostDetail(page, postId);
          if (rendered) return { type: "success", data: rendered };
          const unavailable = await renderedPostDetailUnavailable(page);
          if (unavailable) return unavailable;
          throw error;
        }

        const unavailable = postDetailUnavailable(capture.payload);
        if (unavailable) return unavailable;

        const parsed = parseLatestPostsFromSearch(capture.payload, 1);
        const post = mapLatestResults(parsed.items.filter(isLatestPost), {
          forcedHandle: normalized,
          fallbackPostedAt: now().toISOString(),
        }).find((item) => item.sourcePostId === postId);
        if (post) return { type: "success", data: post };

        const rendered = await renderedPostDetail(page, postId);
        if (rendered) return { type: "success", data: rendered };
        const renderedUnavailable = await renderedPostDetailUnavailable(page);
        return renderedUnavailable ?? { type: "not_found" };
      } finally {
        payloadWaiter.cancel();
      }
    },

  };
}

function livePage(context: ProviderCallContext | undefined): LiveXPage | null {
  const page = context?.browserContext.page as Partial<LiveXPage> | undefined;
  if (
    page &&
    typeof page.goto === "function" &&
    typeof page.waitForTimeout === "function" &&
    typeof page.evaluate === "function"
  ) {
    return page as LiveXPage;
  }
  return null;
}

async function waitForSearchDomStabilization(
  page: LiveXPage,
  waitMs: number,
): Promise<void> {
  const boundedWaitMs = Number.isFinite(waitMs)
    ? Math.min(10_000, Math.max(0, Math.trunc(waitMs)))
    : 0;
  if (boundedWaitMs <= 0) {
    return;
  }
  await page.waitForTimeout(boundedWaitMs);
}

async function gotoPage(
  page: LiveXPage,
  sourceUrl: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !message.includes("ERR_CERT_VERIFIER_CHANGED") &&
      !message.includes("ERR_ABORTED")
    ) {
      throw error;
    }
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
  }
}

const searchGraphqlOperations = [
  "SearchTimeline",
  "SearchByRawQuery",
  "search_by_raw_query",
] as const;

const profileTimelineGraphqlOperations = [
  "UserTweets",
  "UserOriginalsTimeline",
  "UserTweetsAndReplies",
  "UserMedia",
] as const;

const postDetailGraphqlOperations = [
  "TweetDetail",
  "TweetDetailByRestId",
  "TweetResultByRestId",
] as const;

function graphqlUrlHasOperation(
  url: string,
  operations: readonly string[],
): boolean {
  const parsed = parseUrl(url);
  if (
    !parsed ||
    !isXHost(parsed.hostname) ||
    !parsed.pathname.includes("/graphql/")
  ) {
    return false;
  }
  try {
    const decodedUrl = decodeURIComponent(parsed.href).toLowerCase();
    return operations.some((operation) =>
      decodedUrl.includes(operation.toLowerCase()),
    );
  } catch {
    return false;
  }
}

function isSearchGraphqlUrl(url: string): boolean {
  return graphqlUrlHasOperation(url, searchGraphqlOperations);
}

function isProfileTimelineGraphqlUrl(url: string): boolean {
  return graphqlUrlHasOperation(url, profileTimelineGraphqlOperations);
}

function isPostDetailGraphqlUrl(url: string): boolean {
  return graphqlUrlHasOperation(url, postDetailGraphqlOperations);
}

function waitForPostDetailGraphqlPayload(
  page: LiveXPage,
  timeoutMs: number,
): GraphqlCaptureWaiter {
  return waitForJsonPayload(
    page,
    timeoutMs,
    isPostDetailGraphqlUrl,
    "Timed out waiting for X post detail GraphQL response",
    (capture) =>
      parseLatestPostsFromSearch(capture.payload, 1).items.length > 0 ||
      postDetailUnavailable(capture.payload) !== null,
    true,
  );
}

function waitForSearchGraphqlPayload(
  page: LiveXPage,
  timeoutMs: number,
  mode: XSearchMode,
  limit: number,
): GraphqlCaptureWaiter {
  return waitForJsonPayload(
    page,
    timeoutMs,
    isSearchGraphqlUrl,
    "Timed out waiting for X search GraphQL response",
    (capture) => {
      const hasItems =
        mode === "people"
          ? parsePeopleFromSearch(capture.payload, limit).items.length > 0
          : parseLatestPostsFromSearch(capture.payload, limit).items.length > 0;
      return hasItems || isCompleteSearchTimelinePayload(capture.payload);
    },
  );
}

function waitForSearchContinuationGraphqlPayload(
  page: LiveXPage,
  timeoutMs: number,
  mode: XSearchMode,
  limit: number,
  seenKeys: ReadonlySet<string>,
  debugContext: SearchCaptureDebugContext | undefined,
): GraphqlCaptureWaiter {
  return waitForJsonPayload(
    page,
    timeoutMs,
    isSearchGraphqlUrl,
    "Timed out waiting for X search continuation GraphQL response",
    (capture) => {
      const requestCursor = graphqlCursorFromRequest({
        url: capture.request.url,
        postData: capture.request.postData,
      });
      if (!requestCursor) {
        logPageEvent("debug", debugContext, "scroll_capture_ignored", {
          reason: "missing_request_cursor",
          request: requestDebugDetails({
            url: capture.request.url,
            method: capture.request.method,
            postData: capture.request.postData,
            headers: capture.request.headers,
          }),
        });
        return false;
      }

      const parsed =
        mode === "people"
          ? parsePeopleFromSearch(capture.payload, limit)
          : parseLatestPostsFromSearch(capture.payload, limit);
      const freshItems = parsed.items.filter(
        (item) => !seenKeys.has(resultKeyFor(item)),
      );
      logPageEvent("debug", debugContext, "scroll_capture_candidate", {
        items: parsed.items.length,
        freshItems: freshItems.length,
        requestCursorPresent: true,
        nextCursorPresent: Boolean(parsed.nextCursor),
        request: requestDebugDetails({
          url: capture.request.url,
          method: capture.request.method,
          postData: capture.request.postData,
          headers: capture.request.headers,
        }),
      });
      return (
        parsed.items.length > 0 ||
        isCompleteSearchTimelinePayload(capture.payload)
      );
    },
  );
}

function waitForProfileTimelineGraphqlPayload(
  page: LiveXPage,
  timeoutMs: number,
): GraphqlCaptureWaiter {
  return waitForJsonPayload(
    page,
    timeoutMs,
    isProfileTimelineGraphqlUrl,
    "Timed out waiting for X profile timeline GraphQL response",
    () => true,
    true,
  );
}

function waitForJsonPayload(
  page: LiveXPage,
  timeoutMs: number,
  shouldCaptureUrl: (url: string) => boolean,
  timeoutMessage: string,
  shouldAcceptPayload: (capture: GraphqlCapture) => boolean = () => true,
  rejectNonSuccessfulResponse = false,
): GraphqlCaptureWaiter {
  let cancel = () => {};
  if (typeof page.on !== "function") {
    const promise = Promise.reject(
      new Error("Page response events are unavailable."),
    );
    void promise.catch(() => undefined);
    return { promise, cancel };
  }
  const promise = new Promise<GraphqlCapture>((resolve, reject) => {
    let settled = false;
    let onResponse: ((response: PlaywrightResponse) => Promise<void>) | null =
      null;
    const cleanup = () => {
      if (onResponse) {
        page.off?.("response", onResponse);
      }
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new ProviderCaptureTimeoutError(timeoutMessage));
    }, timeoutMs);

    cancel = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
    };

    onResponse = async (response: PlaywrightResponse) => {
      if (settled) {
        return;
      }
      if (!shouldCaptureUrl(response.url())) {
        return;
      }
      const responseStatus = response.status();
      if (responseStatus !== 200) {
        if (rejectNonSuccessfulResponse) {
          settled = true;
          cleanup();
          reject(new ProviderHttpError(responseStatus));
        }
        return;
      }

      const request = response.request();
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return;
      }
      const capture = {
        payload,
        url: response.url(),
        request: {
          url:
            typeof request.url === "function" ? request.url() : response.url(),
          method:
            typeof request.method === "function" ? request.method() : "GET",
          postData:
            typeof request.postData === "function" ? request.postData() : null,
          headers:
            typeof request.headers === "function" ? request.headers() : {},
        },
      };
      if (settled || !shouldAcceptPayload(capture)) {
        return;
      }

      try {
        settled = true;
        cleanup();
        resolve(capture);
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    };

    page.on?.("response", onResponse);
  });
  void promise.catch(() => undefined);

  return { promise, cancel };
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isXHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "x.com" ||
    normalized.endsWith(".x.com") ||
    normalized === "twitter.com" ||
    normalized.endsWith(".twitter.com")
  );
}

async function captureSearchPage(
  page: LiveXPage,
  payloadWaiter: GraphqlCaptureWaiter,
  mode: XSearchMode,
  limit: number,
  cursor: string | null,
  options: SearchCaptureOptions = {},
): Promise<XSearchParseResult<XPeopleCandidate | XLatestPostResult>> {
  const debugContext = options.debugContext;
  try {
    const capture = await payloadWaiter.promise;
    logPageEvent("debug", debugContext, "capture", {
      mode,
      limit,
      cursorPresent: Boolean(cursor),
      request: requestDebugDetails({
        url: capture.request.url,
        method: capture.request.method,
        postData: capture.request.postData,
        headers: capture.request.headers,
      }),
    });
    if (cursor && options.continuationStrategy === "scroll") {
      const initialParsed =
        mode === "people"
          ? parsePeopleFromSearch(capture.payload, limit)
          : parseLatestPostsFromSearch(capture.payload, limit);
      return await captureSearchContinuationByScroll({
        page,
        mode,
        limit,
        cursor,
        initialParsed,
        timeoutMs: options.continuationCaptureTimeoutMs ?? 10_000,
        maxScrollAttempts: options.continuationMaxScrollAttempts ?? 3,
        ...(options.continuationReplayDepth !== undefined
          ? { replayDepth: options.continuationReplayDepth }
          : {}),
        preserveDuplicateItems: options.preserveDuplicateItems ?? false,
        scrollWaitMs: options.scrollWaitMs ?? 700,
        ...(debugContext ? { debugContext } : {}),
      });
    }

    const payload = cursor
      ? await fetchContinuationPayload(
          page,
          capture,
          cursor,
          debugContext,
          options.rejectNonSuccessfulContinuationResponse ?? false,
        )
      : capture.payload;
    if (!payload) {
      logPageEvent("info", debugContext, "empty_payload", {
        mode,
        cursorPresent: Boolean(cursor),
      });
      return { items: [], nextCursor: null, hasMore: false };
    }
    const parsed =
      mode === "people"
        ? parsePeopleFromSearch(payload, limit)
        : parseLatestPostsFromSearch(payload, limit);
    logPageEvent("info", debugContext, "parsed", {
      mode,
      items: parsed.items.length,
      nextCursorPresent: Boolean(parsed.nextCursor),
      ...(mode === "latest"
        ? summarizeLatestSearchPayloadForDebug(payload, limit)
        : {}),
    });
    return parsed;
  } catch (error) {
    logPageEvent("warn", debugContext, "capture_error", {
      mode,
      error: error instanceof Error ? error.message : String(error),
    });
    payloadWaiter.cancel();
    throw error;
  }
}

async function captureSearchContinuationByScroll(input: {
  readonly page: LiveXPage;
  readonly mode: XSearchMode;
  readonly limit: number;
  readonly cursor: string;
  readonly initialParsed: XSearchParseResult<
    XPeopleCandidate | XLatestPostResult
  >;
  readonly debugContext?: SearchCaptureDebugContext;
  readonly replayDepth?: number;
  readonly timeoutMs: number;
  readonly maxScrollAttempts: number;
  readonly preserveDuplicateItems: boolean;
  readonly scrollWaitMs: number;
}): Promise<XSearchParseResult<XPeopleCandidate | XLatestPostResult>> {
  const seenKeys = new Set(input.initialParsed.items.map(resultKeyFor));
  const parseLimit = Math.max(input.limit + seenKeys.size, input.limit * 2);
  const replayDepth = Math.max(1, input.replayDepth ?? 1);

  for (let attempt = 0; attempt < input.maxScrollAttempts; attempt += 1) {
    const waiter = waitForSearchContinuationGraphqlPayload(
      input.page,
      input.timeoutMs,
      input.mode,
      parseLimit,
      seenKeys,
      input.debugContext,
    );
    await scrollToPageBottom(input.page);
    await input.page.waitForTimeout(input.scrollWaitMs);
    try {
      const capture = await waiter.promise;
      const parsed =
        input.mode === "people"
          ? parsePeopleFromSearch(capture.payload, parseLimit)
          : parseLatestPostsFromSearch(capture.payload, parseLimit);
      const requestCursor = graphqlCursorFromRequest({
        url: capture.request.url,
        postData: capture.request.postData,
      });
      if (attempt + 1 < replayDepth) {
        logPageEvent("debug", input.debugContext, "scroll_capture_skipped", {
          attempt: attempt + 1,
          reason: "replaying_provider_depth",
          replayDepth,
          requestCursorPresent: Boolean(requestCursor),
        });
        continue;
      }
      const items = input.preserveDuplicateItems
        ? parsed.items
        : parsed.items.filter((item) => !seenKeys.has(resultKeyFor(item)));
      logPageEvent("info", input.debugContext, "scroll_capture_result", {
        attempt: attempt + 1,
        items: parsed.items.length,
        freshItems: items.length,
        nextCursorPresent: Boolean(parsed.nextCursor),
        requestCursorPresent: Boolean(requestCursor),
      });
      if (items.length > 0) {
        return {
          items: items.slice(0, input.limit),
          nextCursor: parsed.nextCursor,
          hasMore: parsed.hasMore,
        };
      }
      return {
        items: [],
        nextCursor: parsed.nextCursor,
        hasMore: parsed.hasMore,
      };
    } catch (error) {
      logPageEvent("warn", input.debugContext, "scroll_capture_error", {
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      waiter.cancel();
    }
  }

  return { items: [], nextCursor: null, hasMore: false };
}

async function fetchContinuationPayload(
  page: LiveXPage,
  capture: GraphqlCapture,
  cursor: string,
  debugContext?: SearchCaptureDebugContext,
  rejectNonSuccessfulResponse = false,
): Promise<unknown | null> {
  const request = rewriteGraphqlCursorRequest(capture, cursor);
  if (!request) {
    logPageEvent("warn", debugContext, "continuation_rewrite_failed", {
      request: requestDebugDetails({
        url: capture.request.url,
        method: capture.request.method,
        postData: capture.request.postData,
        headers: capture.request.headers,
      }),
    });
    return null;
  }

  try {
    logPageEvent("debug", debugContext, "continuation_fetch", {
      request: requestDebugDetails({
        url: request.url,
        method: request.method,
        postData: request.body,
        headers: request.headers,
      }),
    });
    const result = await page.evaluate(async (input) => {
      const response = await fetch(input.url, {
        method: input.method,
        body: input.body,
        credentials: "include",
        headers: input.headers,
      });
      const status = response.status;
      if (!response.ok) {
        return { ok: false, status, payload: null };
      }
      return { ok: true, status, payload: await response.json() };
    }, request);
    if (!isContinuationFetchResult(result)) {
      logPageEvent("info", debugContext, "continuation_fetch_result", {
        ok: true,
        status: null,
        hasPayload: Boolean(result),
        legacyReturnShape: true,
      });
      return result;
    }
    logPageEvent("info", debugContext, "continuation_fetch_result", {
      ok: result.ok,
      status: result.status,
      hasPayload: Boolean(result.payload),
    });
    if (!result.ok && rejectNonSuccessfulResponse) {
      throw new ProviderHttpError(result.status);
    }
    return result.payload;
  } catch (error) {
    logPageEvent("warn", debugContext, "continuation_fetch_error", {
      request: requestDebugDetails({
        url: request.url,
        method: request.method,
        postData: request.body,
        headers: request.headers,
      }),
    });
    if (error instanceof ProviderHttpError) {
      throw error;
    }
    return null;
  }
}

function isContinuationFetchResult(
  value: unknown,
): value is { ok: boolean; status: number; payload: unknown | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "ok" in value && "status" in value && "payload" in value;
}

function rewriteGraphqlCursorRequest(
  capture: GraphqlCapture,
  cursor: string,
): {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  readonly headers: Record<string, string>;
} | null {
  const method = capture.request.method.toUpperCase();
  const safeHeaders = graphqlContinuationHeaders(capture.request.headers);

  if (method === "POST" && capture.request.postData) {
    const body = rewriteGraphqlBodyCursor(capture.request.postData, cursor);
    return body
      ? {
          url: capture.request.url,
          method,
          body,
          headers: { ...safeHeaders, "content-type": "application/json" },
        }
      : null;
  }

  const rewrittenUrl = rewriteGraphqlUrlCursor(capture.request.url, cursor);
  return rewrittenUrl
    ? { url: rewrittenUrl, method: "GET", body: null, headers: safeHeaders }
    : null;
}

function rewriteGraphqlUrlCursor(url: string, cursor: string): string | null {
  try {
    const parsed = new URL(url);
    const variables = parseGraphqlVariables(
      parsed.searchParams.get("variables"),
    );
    if (!variables) {
      return null;
    }
    parsed.searchParams.set(
      "variables",
      JSON.stringify(withCursorVariable(variables, cursor)),
    );
    return parsed.toString();
  } catch {
    return null;
  }
}

function logPageEvent(
  level: PageLogLevel,
  context: SearchCaptureDebugContext | undefined,
  event: string,
  fields: Record<string, unknown>,
): void {
  if (!context) {
    return;
  }

  crawlerLogger[level](
    {
      area: "x_page_capture",
      label: context.label,
      query: context.query,
      continuation: context.continuation,
      cursorPresent: context.cursorPresent,
      ...fields,
    },
    level === "debug" ? `[DEBUG] x_page_${event}` : `x_page_${event}`,
  );
}

function requestDebugDetails(input: {
  readonly url: string;
  readonly method: string;
  readonly postData?: string | null;
  readonly headers?: Record<string, string>;
}): Record<string, unknown> {
  const parsed = parseUrl(input.url);
  const variables = parsed
    ? parseGraphqlVariables(parsed.searchParams.get("variables"))
    : null;
  const features = parsed
    ? parseGraphqlVariables(parsed.searchParams.get("features"))
    : null;
  const body = parseGraphqlBody(input.postData ?? null);

  return {
    url: input.url,
    method: input.method,
    pathname: parsed?.pathname ?? "unparseable",
    operation: parsed ? graphqlOperationName(parsed.pathname) : null,
    query: parsed ? Object.fromEntries(parsed.searchParams.entries()) : {},
    variables,
    features,
    body,
    headers: input.headers ?? {},
  };
}

function graphqlCursorFromRequest(input: {
  readonly url: string;
  readonly postData?: string | null;
}): string | null {
  const parsed = parseUrl(input.url);
  const variables = parsed
    ? parseGraphqlVariables(parsed.searchParams.get("variables"))
    : null;
  const bodyVariables = recordFromUnknown(
    parseGraphqlBody(input.postData ?? null)?.variables,
  );
  return (
    stringFromUnknown(variables?.cursor) ??
    stringFromUnknown(bodyVariables?.cursor)
  );
}

function parseGraphqlBody(
  value: string | null,
): Record<string, Record<string, unknown> | unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...record,
      variables: parseGraphqlVariables(record.variables),
    };
  } catch {
    return null;
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function graphqlOperationName(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const graphqlIndex = parts.indexOf("graphql");
  return graphqlIndex >= 0 ? (parts[graphqlIndex + 2] ?? null) : null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}


function rewriteGraphqlBodyCursor(body: string, cursor: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const variables = parseGraphqlVariables(record.variables);
    if (!variables) {
      return null;
    }
    return JSON.stringify({
      ...record,
      variables: withCursorVariable(variables, cursor),
    });
  } catch {
    return null;
  }
}

function parseGraphqlVariables(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function withCursorVariable(
  variables: Record<string, unknown>,
  cursor: string,
): Record<string, unknown> {
  return {
    ...variables,
    cursor,
  };
}

function graphqlContinuationHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const allowed = new Set([
    "authorization",
    "content-type",
    "x-csrf-token",
    "x-twitter-active-user",
    "x-twitter-auth-type",
    "x-twitter-client-language",
  ]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (allowed.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

async function captureGraphqlCapture(
  payloadWaiter: GraphqlCaptureWaiter,
): Promise<GraphqlCapture | null> {
  try {
    return await payloadWaiter.promise;
  } catch {
    payloadWaiter.cancel();
    return null;
  }
}

async function pageHtmlOrText(page: LiveXPage): Promise<string> {
  if (typeof page.content === "function") {
    return page.content();
  }
  return page.evaluate(() => {
    const globalRef = globalThis as unknown as {
      readonly document?: { readonly body?: { readonly innerText?: string } };
    };
    return globalRef.document?.body?.innerText ?? "";
  });
}

function parseJsonPayloadFromHtmlOrText(value: string): unknown {
  const text = value
    .replace(/<[^>]+>/g, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function collectScrollLoadMore(input: {
  readonly page: LiveXPage;
  readonly mode: XSearchMode;
  readonly limit: number;
  readonly loadMoreMaxScrollAttempts: number;
  readonly loadMoreIdleAttempts: number;
  readonly scrollWaitMs: number;
}): Promise<ScrollLoadMoreResult> {
  let idleAttempts = 0;
  let scrollAttempts = 0;
  let temporaryStateDetected = false;
  let lastVisibleItemCount = 0;
  const accumulated: Array<XPeopleCandidate | XLatestPostResult> = [];
  const accumulatedKeys = new Set<string>();

  for (
    let attempt = 0;
    attempt < input.loadMoreMaxScrollAttempts;
    attempt += 1
  ) {
    scrollAttempts = attempt + 1;
    const snapshot = await collectRenderedSearchSnapshot(input.page);
    temporaryStateDetected =
      temporaryStateDetected || renderedSearchIsTemporary(snapshot);
    const parsed =
      input.mode === "people"
        ? extractPeopleFromSnapshot(snapshot, input.limit)
        : extractLatestFromSnapshot(snapshot, input.limit);
    const visibleItemCount = parsed.items.length;
    let newlyObservedCount = 0;

    for (const item of parsed.items) {
      const key = resultKeyFor(item);
      const sourceUrl = item.sourceUrl;
      if (!accumulatedKeys.has(key) && !accumulatedKeys.has(sourceUrl)) {
        newlyObservedCount += 1;
        accumulated.push(item);
        accumulatedKeys.add(key);
        accumulatedKeys.add(sourceUrl);
      }
    }

    if (temporaryStateDetected || accumulated.length >= input.limit) {
      break;
    }
    idleAttempts = newlyObservedCount === 0 ? idleAttempts + 1 : 0;
    lastVisibleItemCount = Math.max(lastVisibleItemCount, visibleItemCount);
    if (idleAttempts >= input.loadMoreIdleAttempts && attempt > 0) {
      break;
    }
    await scrollToPageBottom(input.page);
    await input.page.waitForTimeout(input.scrollWaitMs);
  }

  void scrollAttempts;
  void lastVisibleItemCount;
  return {
    items: accumulated.slice(0, input.limit),
    temporaryStateDetected,
  };
}

async function scrollToPageBottom(page: LiveXPage): Promise<void> {
  await page.evaluate(() => {
    const windowRef = globalThis as unknown as {
      scrollTo(x: number, y: number): void;
      readonly document: { readonly body: { readonly scrollHeight: number } };
    };
    windowRef.scrollTo(0, windowRef.document.body.scrollHeight);
  });
}

function renderedSearchIsTemporary(snapshot: {
  readonly links: readonly { readonly text: string }[];
  readonly articles: readonly { readonly text: string }[];
  readonly mainText: string;
  readonly bodyText: string;
}): boolean {
  const text = [
    ...snapshot.links.map((link) => link.text),
    ...snapshot.articles.map((article) => article.text),
    snapshot.mainText,
    snapshot.bodyText,
  ]
    .join(" ")
    .toLowerCase();
  return /something went wrong|try reloading|rate limit|temporarily unavailable|cannot retrieve/i.test(
    text,
  );
}

function resultKeyFor(item: XPeopleCandidate | XLatestPostResult): string {
  return "handle" in item ? item.handle : (item.externalId ?? item.sourceUrl);
}

function isLatestPost(
  item: XPeopleCandidate | XLatestPostResult,
): item is XLatestPostResult {
  return "sourceUrl" in item && "externalId" in item;
}

function isPeopleCandidate(
  item: XPeopleCandidate | XLatestPostResult,
): item is XPeopleCandidate {
  return "handle" in item;
}

function mapPeople(item: XPeopleCandidate): SearchPeopleResult {
  return {
    rank: item.rank,
    handle: item.handle,
    displayName: item.displayName,
    avatarUrl: item.avatarUrl,
    bio: item.bio,
    followersCount: item.followerCount,
    verified: item.verified,
    sourceUrl: item.sourceUrl,
  };
}

function mapLatest(
  item: XLatestPostResult,
  options: {
    readonly forcedHandle?: string;
    readonly fallbackPostedAt?: string;
  } = {},
): SearchLatestPost | null {
  const postedAt = item.postedAt ?? options.fallbackPostedAt;
  if (!postedAt) {
    return null;
  }
  const fallbackHandle = profileHandleFromStatusUrl(item.sourceUrl);
  return {
    sourcePostId: item.externalId ?? statusIdFromUrl(item.sourceUrl),
    handle:
      item.authorHandle ??
      options.forcedHandle ??
      fallbackHandle ??
      normalizeXHandle("unknown"),
    displayName: item.authorDisplayName,
    avatarUrl: item.authorAvatarUrl,
    ...(item.isPinned !== undefined ? { isPinned: item.isPinned } : {}),
    ...(item.isRepost !== undefined ? { isRepost: item.isRepost } : {}),
    ...(item.repostedByHandle !== undefined
      ? { repostedByHandle: item.repostedByHandle }
      : {}),
    ...(item.repostedByDisplayName !== undefined
      ? { repostedByDisplayName: item.repostedByDisplayName }
      : {}),
    ...(item.repostedByAvatarUrl !== undefined
      ? { repostedByAvatarUrl: item.repostedByAvatarUrl }
      : {}),
    text: item.text ?? "",
    postedAt,
    ...(item.likeCount !== null ? { likeCount: item.likeCount } : {}),
    ...(item.repostCount !== null ? { repostCount: item.repostCount } : {}),
    ...(item.replyCount !== null ? { replyCount: item.replyCount } : {}),
    ...(item.quoteCount !== null ? { quoteCount: item.quoteCount } : {}),
    ...(item.quotedPost
      ? {
          quotedPost: {
            sourcePostId:
              item.quotedPost.externalId ??
              statusIdFromUrl(item.quotedPost.sourceUrl),
            handle:
              item.quotedPost.authorHandle ??
              profileHandleFromStatusUrl(item.quotedPost.sourceUrl) ??
              normalizeXHandle("unknown"),
            displayName: item.quotedPost.authorDisplayName,
            avatarUrl: item.quotedPost.authorAvatarUrl,
            text: item.quotedPost.text ?? "",
            postedAt: item.quotedPost.postedAt,
            media: item.quotedPost.media.map((media) => ({
              type: media.mediaType,
              url: media.mediaUrl,
              thumbnailUrl: media.thumbnailUrl,
              width: media.width,
              height: media.height,
              durationSeconds: media.durationSeconds,
              ...(media.sources ? { sources: media.sources } : {}),
            })),
            sourceUrl: item.quotedPost.sourceUrl,
          },
        }
      : {}),
    media: item.media.map((media) => ({
      type: media.mediaType,
      url: media.mediaUrl,
      thumbnailUrl: media.thumbnailUrl,
      width: media.width,
      height: media.height,
      durationSeconds: media.durationSeconds,
      ...(media.sources ? { sources: media.sources } : {}),
    })),
    sourceUrl: item.sourceUrl,
  };
}

function mapLatestResults(
  items: readonly XLatestPostResult[],
  options: {
    readonly forcedHandle?: string;
    readonly fallbackPostedAt?: string;
  } = {},
): SearchLatestPost[] {
  return items
    .map((item) => mapLatest(item, options))
    .filter((item): item is SearchLatestPost => Boolean(item));
}

async function renderedPostDetail(
  page: LiveXPage,
  sourcePostId: string,
): Promise<SearchLatestPost | null> {
  const snapshot = await collectRenderedSearchSnapshot(page);
  const item = extractLatestFromSnapshot(snapshot, 1).items[0];
  if (!item || item.externalId !== sourcePostId) return null;
  return (
    mapLatestResults([item], {
      fallbackPostedAt: new Date().toISOString(),
    })[0] ?? null
  );
}

async function renderedPostDetailUnavailable(
  page: LiveXPage,
): Promise<FixtureOutcome<SearchLatestPost> | null> {
  const bodyText =
    typeof page.textContent === "function"
      ? await page.textContent("body").catch(() => null)
      : null;
  return postDetailUnavailable(bodyText ?? "");
}

function postDetailUnavailable(
  value: unknown,
): FixtureOutcome<SearchLatestPost> | null {
  const text = typeof value === "string" ? value : safeJsonText(value);
  const normalized = text.toLowerCase();
  if (normalized.includes("these posts are protected")) {
    return { type: "protected" };
  }
  if (
    normalized.includes("account suspended") ||
    normalized.includes("account is suspended") ||
    normalized.includes("suspended account")
  ) {
    return { type: "deleted_or_suspended" };
  }
  if (
    normalized.includes("tweet not found") ||
    normalized.includes("post not found") ||
    normalized.includes("this post is unavailable") ||
    normalized.includes("doesn't exist") ||
    normalized.includes("does not exist")
  ) {
    return { type: "not_found" };
  }
  return null;
}

function safeJsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function statusIdFromUrl(url: string): string {
  return url.match(/\/status\/(\d+)/)?.[1] ?? url;
}

function profileHandleFromStatusUrl(url: string): string | null {
  const match = url.match(
    /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)\/status\/\d+/i,
  );
  return match?.[1] ? normalizeXHandle(match[1]) : null;
}

function mapProfile(
  handle: string,
  profile: NonNullable<ReturnType<typeof mergeProfile>>,
): ProfilePayload {
  const followerCount = profile.followerCount;
  const followingCount = profile.followingCount;
  const postsCount = profile.postsCount;
  const stats =
    followerCount !== null && followingCount !== null && postsCount !== null
      ? {
          followersCount: followerCount,
          followingCount,
          postsCount,
          sourceUrl: `https://x.com/${handle}`,
        }
      : null;

  return {
    handle,
    sourceProfileId: profile.sourceProfileId,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    bannerUrl: profile.coverUrl,
    bio: profile.bio,
    location: profile.location,
    websiteUrl: profile.websiteUrl,
    isVerified: profile.isVerified ?? false,
    sensitiveLabel: profile.sensitiveLabel,
    availabilityStatus: "available",
    sourceUrl: `https://x.com/${handle}`,
    ...(stats ? { stats: { ...stats, listedCount: profile.listedCount } } : {}),
  };
}

export const shouldCaptureSearchGraphqlUrlForTest = isSearchGraphqlUrl;
export const shouldCaptureProfileTimelineGraphqlUrlForTest =
  isProfileTimelineGraphqlUrl;
export const shouldCapturePostDetailGraphqlUrlForTest = isPostDetailGraphqlUrl;
export const gotoPageForTest = gotoPage;
export const mapProfileForTest = mapProfile;
export const postDetailUnavailableForTest = postDetailUnavailable;
export const crawlerLoggerForTest = crawlerLogger;

function readCrawlerLogLevel(value: string | undefined): PageLogLevel {
  return isCrawlerLogLevel(value) ? value : "info";
}

function isCrawlerLogLevel(value: string | undefined): value is PageLogLevel {
  return (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  );
}

function mapProfileUnavailable(
  reason:
    | "protected_profile"
    | "not_found"
    | "suspended"
    | "profile_unavailable",
): FixtureOutcome<ProfilePayload> {
  if (reason === "protected_profile") {
    return { type: "protected" };
  }
  if (reason === "not_found") {
    return { type: "not_found" };
  }
  if (reason === "suspended") {
    return { type: "deleted_or_suspended" };
  }
  return { type: "temporary_empty" };
}

function browserCrash<T>(message: string): FixtureOutcome<T> {
  return { type: "browser_crash", message };
}

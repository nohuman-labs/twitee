import type { Page } from "playwright-core";
import type { XProfile } from "./search-types.js";

export type ProfileEvidenceField =
  | "displayName"
  | "avatarUrl"
  | "coverUrl"
  | "bio"
  | "location"
  | "joinedAt"
  | "followerCount"
  | "followingCount"
  | "postsCount";

export type XProfileExtractionResult = {
  graphProfile: Partial<XProfile> | null;
  fallbackProfile: Partial<XProfile> | null;
  title: string;
  bodyText: string;
  currentUrl: string;
};

export type ProfileUnavailableReason =
  | "protected_profile"
  | "not_found"
  | "suspended"
  | "profile_unavailable";

type XProfileGraphqlCapture = Promise<Partial<XProfile> | null> & {
  cancel?: () => void;
};

export type XProfileGraphqlDiagnostic = {
  status: number | null;
  url: string | null;
  responseHeaders: Record<string, string> | null;
  responseData: unknown;
  responseLatencyMs: number | null;
  parseResult:
    | "unmatched_operation"
    | "non_200"
    | "json_error"
    | "parser_null"
    | "timeout"
    | "accepted";
  accepted: boolean;
};

type PageResponse = {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
  headers?(): Record<string, string>;
  request?(): {
    timing?(): { startTime?: number; responseStart?: number };
  };
};

type AttributeLocator = {
  first?: () => AttributeLocator;
  getAttribute?: (
    attribute: string,
    options?: Record<string, unknown>,
  ) => Promise<string | null>;
};

export class XProfileEvidenceInconclusiveError extends Error {
  code = "profile_evidence_inconclusive";

  constructor(handle: string) {
    super(
      `X profile evidence was inconclusive for @${normalizeXHandle(handle)}`,
    );
    this.name = "XProfileEvidenceInconclusiveError";
  }
}

export function createXProfileEvidenceInconclusiveError(
  handle: string,
): XProfileEvidenceInconclusiveError {
  return new XProfileEvidenceInconclusiveError(handle);
}

export function isXProfileEvidenceInconclusiveError(
  error: unknown,
): error is XProfileEvidenceInconclusiveError {
  return (
    (error as { code?: string } | null)?.code ===
    "profile_evidence_inconclusive"
  );
}

const PROFILE_UNAVAILABLE_RE = [
  /^this account doesn['’]t exist\.?$/i,
  /^(?:this )?account does not exist\.?$/i,
  /^does not exist\.?$/i,
  /^(?:this )?account suspended\.?$/i,
  /^(?:this )?account is temporarily unavailable\.?$/i,
  /^this profile is unavailable\.?$/i,
  /^profile unavailable\.?$/i,
  /^this account is private\.?$/i,
  /^these posts are protected\.?$/i,
  /^posts are protected\.?$/i,
  /^user has been withheld\.?$/i,
];

const PROFILE_NOT_FOUND_RE = [
  /^this account doesn['’]t exist\.?$/i,
  /^(?:this )?account does not exist\.?$/i,
  /^does not exist\.?$/i,
];

const PROFILE_SUSPENDED_RE = [
  /^(?:this )?account suspended\.?$/i,
  /^this account is suspended\.?$/i,
];

const PROFILE_PROTECTED_RE = [
  /^this account is private\.?$/i,
  /^these posts are protected\.?$/i,
  /^posts are protected\.?$/i,
];

export function normalizeXHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

export function emptyXProfile(username: string): XProfile {
  return {
    username,
    sourceProfileId: null,
    displayName: null,
    bio: null,
    followerCount: null,
    followingCount: null,
    postsCount: null,
    listedCount: null,
    location: null,
    joinedAt: null,
    avatarUrl: null,
    coverUrl: null,
    websiteUrl: null,
    isVerified: null,
    sensitiveLabel: null,
  };
}

function parseCompactNumber(value?: string | null): number | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/,/g, "");
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const suffix = match[2]?.toUpperCase();
  const multiplier =
    suffix === "B"
      ? 1_000_000_000
      : suffix === "M"
        ? 1_000_000
        : suffix === "K"
          ? 1_000
          : 1;
  return Math.round(amount * multiplier);
}

function parseJoinedMonth(value: string): string | null {
  const parsed = new Date(`${value} 1 00:00:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstExpandedWebsiteUrl(
  legacy: Record<string, unknown>,
): string | null {
  const entities = asRecord(legacy.entities);
  const url = asRecord(entities?.url);
  const urls = Array.isArray(url?.urls) ? url.urls : [];
  for (const item of urls) {
    const record = asRecord(item);
    const expanded =
      stringOrNull(record?.expanded_url) ??
      stringOrNull(record?.display_url) ??
      stringOrNull(record?.url);
    if (expanded) return expanded;
  }
  return stringOrNull(legacy.url);
}

function sensitiveLabelFromGraphQL(
  result: Record<string, unknown>,
  legacy: Record<string, unknown>,
): string | null {
  if (
    legacy.possibly_sensitive === true ||
    result.possibly_sensitive === true
  ) {
    return "possibly_sensitive";
  }
  return stringOrNull(legacy.profile_interstitial_type);
}

function graphqlProfileHandle(result: Record<string, unknown>): string | null {
  const legacy = asRecord(result.legacy);
  const core = asRecord(result.core);
  const handle =
    legacy?.screen_name ?? core?.screen_name ?? result.screen_name ?? null;
  return typeof handle === "string" && handle.trim()
    ? normalizeXHandle(handle)
    : null;
}

export function parseProfileFromGraphQL(
  data: Record<string, unknown>,
  expectedHandle?: string,
): Partial<XProfile> | null {
  try {
    const dataNode = asRecord(data.data);
    const userNode = asRecord(dataNode?.user);
    const userResultNode = asRecord(dataNode?.user_result);
    const result =
      asRecord(userNode?.result) ?? asRecord(userResultNode?.result);
    if (!result) return null;
    const legacy = asRecord(result.legacy) ?? {};
    if (
      expectedHandle &&
      graphqlProfileHandle(result) !== normalizeXHandle(expectedHandle)
    )
      return null;

    const core = asRecord(result.core);
    const avatar = asRecord(result.avatar);
    const banner = asRecord(result.banner);
    const profileBio = asRecord(result.profile_bio);
    const relationshipCounts = asRecord(result.relationship_counts);
    const tweetCounts = asRecord(result.tweet_counts);
    const website = asRecord(result.website);
    const avatarSource =
      typeof avatar?.image_url === "string"
        ? avatar.image_url
        : typeof legacy.profile_image_url_https === "string"
          ? legacy.profile_image_url_https
          : null;
    const avatarUrl = avatarSource?.replace("_normal", "") ?? null;
    const location = asRecord(result.location);
    const verification = asRecord(result.verification);
    const coverUrl =
      stringOrNull(legacy.profile_banner_url) ??
      stringOrNull(banner?.image_url) ??
      stringOrNull(result.profile_banner_url);
    const joinedAt =
      stringOrNull(legacy.created_at) ?? stringOrNull(core?.created_at);
    const joinedAtDate = joinedAt ? new Date(joinedAt) : null;
    const profile: Partial<XProfile> & { protected?: boolean } = {
      sourceProfileId: stringOrNull(result.rest_id),
      displayName: stringOrNull(core?.name) ?? stringOrNull(legacy.name),
      avatarUrl,
      coverUrl,
      bio:
        stringOrNull(legacy.description) ??
        stringOrNull(profileBio?.description),
      followerCount:
        numberOrNull(legacy.followers_count) ??
        numberOrNull(relationshipCounts?.followers),
      followingCount:
        numberOrNull(legacy.friends_count) ??
        numberOrNull(relationshipCounts?.following),
      postsCount:
        numberOrNull(legacy.statuses_count) ??
        numberOrNull(tweetCounts?.tweets),
      listedCount: numberOrNull(legacy.listed_count),
      joinedAt:
        joinedAtDate && Number.isFinite(joinedAtDate.getTime())
          ? joinedAtDate.toISOString()
          : null,
      location:
        stringOrNull(location?.location) ?? stringOrNull(legacy.location),
      websiteUrl: firstExpandedWebsiteUrl(legacy) ?? stringOrNull(website?.url),
      isVerified:
        verification?.verified === true ||
        result.is_blue_verified === true ||
        legacy.verified === true,
      sensitiveLabel: sensitiveLabelFromGraphQL(result, legacy),
    };

    if (
      legacy.protected === true ||
      asRecord(result.privacy)?.protected === true
    )
      profile.protected = true;
    return profile;
  } catch {
    return null;
  }
}

export const parseProfileFromGraphQLForTests = parseProfileFromGraphQL;

export function graphProfileUnavailableReason(
  profile: Partial<XProfile> | null,
): ProfileUnavailableReason | null {
  return (profile as { protected?: unknown } | null)?.protected === true
    ? "protected_profile"
    : null;
}

export function hasUsefulXProfile(
  profile: Partial<XProfile> | null,
): profile is Partial<XProfile> {
  if (!profile) return false;
  return Boolean(
    profile.displayName ||
      profile.avatarUrl ||
      profile.coverUrl ||
      profile.bio ||
      profile.location ||
      profile.joinedAt ||
      (profile.followerCount !== null && profile.followerCount !== undefined) ||
      (profile.followingCount !== null &&
        profile.followingCount !== undefined) ||
      (profile.postsCount !== null && profile.postsCount !== undefined),
  );
}

export function evidenceFields(
  profile: Partial<XProfile> | null,
): ProfileEvidenceField[] {
  if (!profile) return [];
  const fields: ProfileEvidenceField[] = [];
  if (profile.displayName) fields.push("displayName");
  if (profile.avatarUrl) fields.push("avatarUrl");
  if (profile.coverUrl) fields.push("coverUrl");
  if (profile.bio) fields.push("bio");
  if (profile.location) fields.push("location");
  if (profile.joinedAt) fields.push("joinedAt");
  if (profile.followerCount !== null && profile.followerCount !== undefined)
    fields.push("followerCount");
  if (profile.followingCount !== null && profile.followingCount !== undefined)
    fields.push("followingCount");
  if (profile.postsCount !== null && profile.postsCount !== undefined)
    fields.push("postsCount");
  return fields;
}

export async function readVisibleBodyText(page: Page): Promise<string> {
  try {
    const locator = page.locator?.("body");
    if (locator?.innerText) {
      const text = await locator.innerText();
      if (typeof text === "string") return text;
    }
  } catch {
    // Fall through to textContent.
  }

  try {
    return (await page.textContent?.("body")) ?? "";
  } catch {
    return "";
  }
}

export async function waitForProfileDom(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const boundedTimeoutMs = Math.max(0, Math.min(timeoutMs, 10_000));
  if (boundedTimeoutMs <= 0) return;
  const loadStateTimeoutMs = Math.min(boundedTimeoutMs, 1_000);

  try {
    await page.waitForLoadState?.("networkidle", {
      timeout: loadStateTimeoutMs,
    });
  } catch {
    // X keeps some connections open; the bounded pause below still gives rendered evidence time to settle.
  }

  const remainingTimeoutMs = boundedTimeoutMs - loadStateTimeoutMs;
  if (remainingTimeoutMs <= 0) return;

  try {
    await page.waitForTimeout?.(remainingTimeoutMs);
  } catch {
    // Test doubles may not implement waitForTimeout.
  }
}

function profileAttributeTimeoutMs(timeoutMs: number): number {
  return Math.max(50, Math.min(timeoutMs, 500));
}

async function readFirstAttribute(
  page: Page,
  selectors: string[],
  attribute: string,
  timeoutMs: number,
  shouldStop?: () => boolean,
): Promise<string | null> {
  const boundedTimeoutMs = profileAttributeTimeoutMs(timeoutMs);
  for (const selector of selectors) {
    if (shouldStop?.()) return null;
    try {
      const pageWithLocator = page as Page & {
        locator?: (selector: string) => AttributeLocator;
      };
      const locator = pageWithLocator.locator?.(selector);
      const first =
        typeof locator?.first === "function" ? locator.first() : locator;
      const value = await first?.getAttribute?.(attribute, {
        timeout: boundedTimeoutMs,
      });
      if (shouldStop?.()) return null;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // Try the next conservative selector.
    }
  }
  return null;
}

export function profileMediaSelectors(
  handle: string,
  media: "photo" | "header_photo",
): string[] {
  const normalizedHandle = normalizeXHandle(handle);
  const path = `/${normalizedHandle}/${media}`;
  return [
    `a[href="${path}"] img`,
    `a[href="https://x.com${path}"] img`,
    `a[href="https://twitter.com${path}"] img`,
    `a[href$="${path}"] img`,
  ];
}

function profileAvatarSelectors(handle: string): string[] {
  const normalizedHandle = normalizeXHandle(handle);
  return [
    ...profileMediaSelectors(normalizedHandle, "photo"),
    `div[data-testid="UserAvatar-Container-${normalizedHandle}"] img`,
    `div[data-testid^="UserAvatar-Container-${normalizedHandle}"] img`,
    `a[href="/${normalizedHandle}"] div[data-testid="UserAvatar-Container"] img`,
    `a[href="https://x.com/${normalizedHandle}"] div[data-testid="UserAvatar-Container"] img`,
    `a[href="https://twitter.com/${normalizedHandle}"] div[data-testid="UserAvatar-Container"] img`,
  ];
}

export async function readRenderedProfileMedia(
  page: Page,
  handle: string,
  timeoutMs: number,
  shouldStop?: () => boolean,
): Promise<Partial<XProfile>> {
  const avatarUrl = await readFirstAttribute(
    page,
    profileAvatarSelectors(handle),
    "src",
    timeoutMs,
    shouldStop,
  );
  if (shouldStop?.()) return {};
  const coverUrl = await readFirstAttribute(
    page,
    profileMediaSelectors(handle, "header_photo"),
    "src",
    timeoutMs,
    shouldStop,
  );
  return { avatarUrl, coverUrl };
}

export function startXProfileGraphqlCapture(
  page: Page,
  handle: string,
  timeoutMs: number,
  onDiagnostic?: (diagnostic: XProfileGraphqlDiagnostic) => void,
): XProfileGraphqlCapture {
  let cancelCapture: (() => void) | null = null;
  const captureStartedAt = Date.now();
  const promise = new Promise<Partial<XProfile> | null>((resolve) => {
    let settled = false;
    const reportDiagnostic = (diagnostic: XProfileGraphqlDiagnostic): void => {
      try {
        onDiagnostic?.(diagnostic);
      } catch {
        // Diagnostics must not change capture behavior.
      }
    };
    const removeResponseListener = (
      handler: (response: PageResponse) => void | Promise<void>,
    ) => {
      const eventPage = page as {
        off?: (event: string, listener: typeof handler) => unknown;
        removeListener?: (event: string, listener: typeof handler) => unknown;
      };
      eventPage.off?.("response", handler);
      eventPage.removeListener?.("response", handler);
    };
    const settle = (profile: Partial<XProfile> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeResponseListener(onResponse);
      resolve(profile);
    };
    const timer = setTimeout(() => {
      reportDiagnostic({
        status: null,
        url: null,
        responseHeaders: null,
        responseData: null,
        responseLatencyMs: timeoutMs,
        parseResult: "timeout",
        accepted: false,
      });
      settle(null);
    }, timeoutMs);
    cancelCapture = () => settle(null);
    const onResponse = async (response: PageResponse) => {
      if (settled) return;
      const url = response.url();
      if (!url.includes("/graphql/")) return;
      const status = response.status();
      const responseHeaders = response.headers?.() ?? {};
      const timing = response.request?.()?.timing?.();
      const responseLatencyMs =
        timing?.startTime !== undefined && timing.responseStart !== undefined
          ? Math.max(0, timing.responseStart - timing.startTime)
          : Math.max(0, Date.now() - captureStartedAt);
      const debugUrl = safeResponseUrl(url);

      let payload: unknown;

      try {
        payload = await response.json();
      } catch {
        reportDiagnostic({
          status,
          url: debugUrl,
          responseHeaders,
          responseData: null,
          responseLatencyMs,
          parseResult: "json_error",
          accepted: false,
        });
        return;
      }

      if (!/userby|userresult|user_result/i.test(decodeURIComponent(url))) {
        reportDiagnostic({
          status,
          url: debugUrl,
          responseHeaders,
          responseData: payload,
          responseLatencyMs,
          parseResult: "unmatched_operation",
          accepted: false,
        });
        return;
      }

      if (status !== 200) {
        reportDiagnostic({
          status,
          url: debugUrl,
          responseHeaders,
          responseData: payload,
          responseLatencyMs,
          parseResult: "non_200",
          accepted: false,
        });
        return;
      }

      const profile = parseProfileFromGraphQL(
        payload as Record<string, unknown>,
        handle,
      );
      if (!profile) {
        reportDiagnostic({
          status,
          url: debugUrl,
          responseHeaders,
          responseData: payload,
          responseLatencyMs,
          parseResult: "parser_null",
          accepted: false,
        });
        return;
      }

      reportDiagnostic({
        status,
        url: debugUrl,
        responseHeaders,
        responseData: payload,
        responseLatencyMs,
        parseResult: "accepted",
        accepted: true,
      });
      settle(profile);
    };
    page.on("response", onResponse);
  });
  (promise as XProfileGraphqlCapture).cancel = () => cancelCapture?.();
  return promise as XProfileGraphqlCapture;
}

function safeResponseUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unparseable";
  }
}

export function mergeProfile(
  handle: string,
  graphProfile: Partial<XProfile> | null,
  fallbackProfile: Partial<XProfile> | null,
): XProfile | null {
  const merged = {
    ...emptyXProfile(handle),
    ...(fallbackProfile ?? {}),
    ...(graphProfile ?? {}),
    username: handle,
  };

  return hasUsefulXProfile(merged) ? merged : null;
}

export function stripUrlMetadata(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

export function isProfileUrlForHandle(
  handle: string,
  currentUrl: string,
): boolean {
  const normalizedHandle = normalizeXHandle(handle);
  try {
    const parsed = new URL(currentUrl);
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(parsed.hostname))
      return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    return (
      segments.length === 1 && segments[0]?.toLowerCase() === normalizedHandle
    );
  } catch {
    const path = currentUrl.split(/[?#]/, 1)[0] ?? "";
    return path.replace(/^\/+|\/+$/g, "").toLowerCase() === normalizedHandle;
  }
}

export function profileUnavailableReason(input: {
  handle: string;
  title: string;
  bodyText: string;
  currentUrl: string;
}): ProfileUnavailableReason | null {
  const normalizedHandle = normalizeXHandle(input.handle);
  const lines = `${input.title}\n${input.bodyText}`
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (PROFILE_NOT_FOUND_RE.some((pattern) => pattern.test(line)))
      return "not_found";
    if (PROFILE_SUSPENDED_RE.some((pattern) => pattern.test(line)))
      return "suspended";
    if (PROFILE_PROTECTED_RE.some((pattern) => pattern.test(line)))
      return "protected_profile";
    if (PROFILE_UNAVAILABLE_RE.some((pattern) => pattern.test(line)))
      return "profile_unavailable";
    const lower = line.toLowerCase();
    if (
      lower.includes(`@${normalizedHandle}`) &&
      (/you (?:are|have been).*blocked/.test(lower) ||
        /blocked from (?:following|viewing)/.test(lower))
    )
      return "profile_unavailable";
  }

  return null;
}

export function isProfileUnavailable(input: {
  handle: string;
  title: string;
  bodyText: string;
  currentUrl: string;
}): boolean {
  return Boolean(profileUnavailableReason(input));
}

function profileTextConfirmsHandle(
  handle: string,
  title: string,
  bodyText: string,
): boolean {
  const normalizedHandle = normalizeXHandle(handle);
  const text = `${title}\n${bodyText}`.toLowerCase();
  return text.includes(`@${normalizedHandle}`);
}

function hasRenderedProfileTextEvidence(
  handle: string,
  title: string,
  bodyText: string,
  profile: Partial<XProfile> | null,
): boolean {
  return (
    profileTextConfirmsHandle(handle, title, bodyText) ||
    evidenceFields(profile).some(
      (field) => field !== "avatarUrl" && field !== "coverUrl",
    )
  );
}

function hasProfileMediaEvidence(profile: Partial<XProfile> | null): boolean {
  return Boolean(profile?.avatarUrl || profile?.coverUrl);
}

function hasCompleteGraphProfileEvidence(
  profile: Partial<XProfile> | null,
): boolean {
  return Boolean(
    hasUsefulXProfile(profile) &&
      hasProfileMediaEvidence(profile) &&
      profile.followerCount !== null &&
      profile.followerCount !== undefined &&
      profile.followingCount !== null &&
      profile.followingCount !== undefined &&
      profile.postsCount !== null &&
      profile.postsCount !== undefined,
  );
}

function isProfileTextSignalLine(line: string): boolean {
  return !(
    line.startsWith("@") ||
    /^https?:\/\//i.test(line) ||
    /^joined\s+/i.test(line) ||
    /^[\d,.]+[KMB]?\s+(following|followers|posts)\b/i.test(line) ||
    /^(follow|following|message|subscribe|posts|replies|media|likes)$/i.test(
      line,
    ) ||
    PROFILE_UNAVAILABLE_RE.some((pattern) => pattern.test(line))
  );
}

export function parseProfileFromVisibleText(
  handle: string,
  input: { title: string; bodyText: string },
): Partial<XProfile> | null {
  const normalizedHandle = normalizeXHandle(handle);
  const titleMatch = input.title.match(/^\(?\d*\)?\s*(.+?)\s*\(@/);
  let displayName = titleMatch?.[1]?.trim() ?? null;
  const titleLower = input.title.toLowerCase();
  const titleHasHandle = titleLower.includes(`@${normalizedHandle}`);
  const lines = input.bodyText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const handleIndex = lines.findIndex(
    (line) => line.toLowerCase() === `@${normalizedHandle}`,
  );
  if (handleIndex < 0 && !titleHasHandle) return null;

  const previousLine =
    handleIndex > 0 ? (lines[handleIndex - 1] ?? null) : null;
  const bodyDisplayName =
    previousLine && isProfileTextSignalLine(previousLine) ? previousLine : null;
  displayName = displayName ?? bodyDisplayName;
  const headerStart = handleIndex >= 0 ? Math.max(0, handleIndex - 1) : 0;
  const headerLines =
    handleIndex >= 0 ? lines.slice(headerStart, handleIndex + 9) : [];
  const headerText = headerLines.join("\n");
  const followerMatch = headerText.match(/([\d,.]+[KMB]?)\s+Followers/i);
  const followingMatch = headerText.match(/([\d,.]+[KMB]?)\s+Following/i);
  const postsMatch = headerText.match(/([\d,.]+[KMB]?)\s+posts/i);
  const joinedMatch = headerText.match(/Joined\s+([A-Za-z]+\s+\d{4})/i);
  const visibleProfileLines =
    handleIndex >= 0 ? headerLines.slice(handleIndex - headerStart + 1) : [];
  const profileTextSignals: string[] = [];
  for (const line of visibleProfileLines) {
    if (!isProfileTextSignalLine(line)) continue;
    profileTextSignals.push(line);
    if (profileTextSignals.length >= 2) break;
  }

  return {
    displayName,
    bio: profileTextSignals[0] ?? null,
    location: profileTextSignals[1] ?? null,
    followerCount: parseCompactNumber(followerMatch?.[1]),
    followingCount: parseCompactNumber(followingMatch?.[1]),
    postsCount: parseCompactNumber(postsMatch?.[1]),
    joinedAt: joinedMatch?.[1] ? parseJoinedMonth(joinedMatch[1]) : null,
  };
}

export async function extractXProfileEvidence(input: {
  page: Page;
  handle: string;
  graphCaptureTimeoutMs: number;
  domStabilizationMs: number;
  evidenceTimeoutMs: number;
  graphProfilePromise?: XProfileGraphqlCapture;
}): Promise<XProfileExtractionResult> {
  const graphProfilePromise =
    input.graphProfilePromise ??
    startXProfileGraphqlCapture(
      input.page,
      input.handle,
      input.graphCaptureTimeoutMs,
    );
  let graphProfile: Partial<XProfile> | null = null;
  let graphSettled = false;
  const trackedGraphProfile = graphProfilePromise
    .then((profile) => {
      graphSettled = true;
      graphProfile = profile;
      return profile;
    })
    .catch(() => {
      graphSettled = true;
      graphProfile = null;
      return null;
    });

  const flushGraphProfile = async () => {
    await Promise.race([trackedGraphProfile, Promise.resolve(null)]);
    await Promise.resolve();
  };

  const evidenceTimeoutMs = Math.max(0, input.evidenceTimeoutMs);
  const waitChunkMs = Math.max(
    0,
    Math.min(input.domStabilizationMs, evidenceTimeoutMs),
  );
  let remainingMs = evidenceTimeoutMs;
  let title = "";
  let bodyText = "";
  let currentUrl = input.page.url();
  let fallbackProfile: Partial<XProfile> | null = null;

  const readFallbackEvidence = async () => {
    title = await input.page.title().catch(() => "");
    bodyText = await readVisibleBodyText(input.page);
    currentUrl = input.page.url();
    const visibleProfile = parseProfileFromVisibleText(input.handle, {
      title,
      bodyText,
    });
    const mediaProfile =
      visibleProfile || isProfileUrlForHandle(input.handle, currentUrl)
        ? await readRenderedProfileMedia(
            input.page,
            input.handle,
            input.evidenceTimeoutMs,
            () => hasCompleteGraphProfileEvidence(graphProfile),
          )
        : null;
    fallbackProfile =
      visibleProfile || mediaProfile
        ? { ...(visibleProfile ?? {}), ...(mediaProfile ?? {}) }
        : null;
  };

  do {
    await flushGraphProfile();
    if (hasCompleteGraphProfileEvidence(graphProfile)) {
      break;
    }

    const waitMs =
      remainingMs === evidenceTimeoutMs
        ? waitChunkMs
        : Math.min(waitChunkMs || remainingMs, remainingMs);
    if (waitMs > 0) {
      await waitForProfileDom(input.page, waitMs);
      remainingMs -= waitMs;
    } else if (waitChunkMs <= 0) {
      remainingMs = 0;
    }

    await flushGraphProfile();
    if (hasCompleteGraphProfileEvidence(graphProfile)) {
      break;
    }
    await readFallbackEvidence();
    const unavailableFound = isProfileUnavailable({
      handle: input.handle,
      title,
      bodyText,
      currentUrl,
    });
    const graphUnavailableFound = Boolean(
      graphProfileUnavailableReason(graphProfile),
    );
    const renderedTextEvidenceFound = hasRenderedProfileTextEvidence(
      input.handle,
      title,
      bodyText,
      fallbackProfile,
    );
    const graphEvidenceReady =
      hasUsefulXProfile(graphProfile) &&
      (hasProfileMediaEvidence(graphProfile) ||
        renderedTextEvidenceFound ||
        remainingMs <= 0);
    const fallbackEvidenceReady =
      hasUsefulXProfile(fallbackProfile) &&
      renderedTextEvidenceFound &&
      (hasProfileMediaEvidence(fallbackProfile) || remainingMs <= 0);

    if (
      unavailableFound ||
      graphUnavailableFound ||
      fallbackEvidenceReady ||
      graphEvidenceReady ||
      remainingMs <= 0
    ) {
      break;
    }
  } while (remainingMs > 0);

  if (!graphSettled) graphProfilePromise.cancel?.();

  return {
    graphProfile,
    fallbackProfile,
    title,
    bodyText,
    currentUrl,
  };
}

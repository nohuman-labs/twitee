import type { Page } from "playwright-core";
import type {
  XLatestPostResult,
  XPeopleCandidate,
  XSearchParseResult,
} from "./search-types.js";

type RenderedLink = {
  href: string;
  text: string;
  imageSrc: string | null;
};

type RenderedArticle = {
  text: string;
  links: string[];
  imageSrcs: string[];
  profileLinks?: RenderedLink[];
  repostContext?: {
    text: string;
    profileLinks: RenderedLink[];
  } | null;
};

export type RenderedSearchSnapshot = {
  links: RenderedLink[];
  peopleRows?: Array<{
    text: string;
    links: RenderedLink[];
  }>;
  articles: RenderedArticle[];
  mainText: string;
  bodyText: string;
};

const X_SYSTEM_ROUTES = new Set([
  "home",
  "login",
  "signup",
  "search",
  "explore",
  "i",
  "settings",
  "notifications",
  "messages",
  "who_to_follow",
]);

function parseXUrl(value: string): URL | null {
  try {
    const url = new URL(value, "https://x.com");
    const host = url.hostname.toLowerCase();
    return host === "x.com" ||
      host === "www.x.com" ||
      host === "twitter.com" ||
      host === "www.twitter.com"
      ? url
      : null;
  } catch {
    return null;
  }
}

function normalizeHandle(value: string | null): string | null {
  const handle = value?.trim().replace(/^@+/, "").toLowerCase() ?? "";
  return /^[a-z0-9_]{1,15}$/.test(handle) && !X_SYSTEM_ROUTES.has(handle)
    ? handle
    : null;
}

function statusParts(
  href: string,
): { handle: string; id: string; sourceUrl: string } | null {
  const url = parseXUrl(href);
  const parts = url?.pathname.split("/").filter(Boolean) ?? [];
  const handle = normalizeHandle(parts[0] ?? null);
  const id =
    parts[1] === "status" && /^\d+$/.test(parts[2] ?? "") ? parts[2] : null;
  return handle && id
    ? { handle, id, sourceUrl: `https://x.com/${handle}/status/${id}` }
    : null;
}

function profileHandleFromHref(href: string): string | null {
  const url = parseXUrl(href);
  const parts = url?.pathname.split("/").filter(Boolean) ?? [];
  if (parts.length !== 1) return null;
  return normalizeHandle(parts[0] ?? null);
}

function displayNameFromText(text: string, handle: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const marker = new RegExp(`@${handle}\\b`, "i");
  const beforeHandle = normalized.split(marker)[0]?.trim();
  return beforeHandle || null;
}

function profileIdentityFromLink(link: RenderedLink) {
  const handle = profileHandleFromHref(link.href);
  return handle
    ? {
        handle,
        displayName: displayNameFromText(link.text, handle),
        avatarUrl: link.imageSrc,
      }
    : null;
}

function profileIdentityScore(profile: {
  displayName: string | null;
  avatarUrl: string | null;
}): number {
  return (profile.displayName ? 2 : 0) + (profile.avatarUrl ? 1 : 0);
}

function bestProfileIdentity(
  links: RenderedLink[],
  predicate: (handle: string) => boolean,
) {
  return (
    links
      .map(profileIdentityFromLink)
      .filter(
        (profile): profile is NonNullable<typeof profile> =>
          profile !== null && predicate(profile.handle),
      )
      .sort(
        (left, right) =>
          profileIdentityScore(right) - profileIdentityScore(left),
      )[0] ?? null
  );
}

function compactCount(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const suffix = match[2]?.toLowerCase();
  const multiplier =
    suffix === "b"
      ? 1_000_000_000
      : suffix === "m"
        ? 1_000_000
        : suffix === "k"
          ? 1_000
          : 1;
  return Math.round(amount * multiplier);
}

function trailingMetricsFromText(text: string): {
  readonly text: string;
  readonly replyCount: number | null;
  readonly repostCount: number | null;
  readonly likeCount: number | null;
  readonly viewCount: number | null;
} {
  const matches = Array.from(text.matchAll(/\d+(?:\.\d+)?[KMB]?/gi)).filter(
    (match) => match.index !== undefined,
  );
  const metricMatches = matches.slice(-4);
  const suffix = metricMatches.map((match) => match[0]).join("");
  if (metricMatches.length < 3 || !text.endsWith(suffix)) {
    return {
      text,
      replyCount: null,
      repostCount: null,
      likeCount: null,
      viewCount: null,
    };
  }
  const [reply, repost, like, view] = metricMatches.map((match) =>
    compactCount(match[0]),
  );
  const firstMetric = metricMatches[0];
  return {
    text: text.slice(0, firstMetric?.index ?? text.length).trim(),
    replyCount: reply ?? null,
    repostCount: repost ?? null,
    likeCount: like ?? null,
    viewCount: view ?? null,
  };
}

function cleanPostTextFromArticleText(
  text: string,
  handle: string,
): {
  readonly displayName: string | null;
  readonly text: string | null;
  readonly replyCount: number | null;
  readonly repostCount: number | null;
  readonly likeCount: number | null;
  readonly viewCount: number | null;
} {
  const normalized = text.replace(/\s+/g, " ").trim();
  const displayName = displayNameFromText(normalized, handle);
  const marker = new RegExp(
    `^.*?@${handle}\\b\\s*(?:·\\s*)?(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}(?:,\\s*\\d{4})?|\\d+\\s*(?:s|m|h|d))?`,
    "i",
  );
  const withoutHeader = normalized.replace(marker, "").trim();
  const withoutCardAttribution = withoutHeader
    .replace(/\s*From\s+[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?=\d|$)/i, " ")
    .trim();
  const metrics = trailingMetricsFromText(withoutCardAttribution);
  const cleaned = metrics.text
    .replace(/Show more/g, " ")
    .replace(/\s*From\s+\S+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    displayName,
    text: cleaned || null,
    replyCount: metrics.replyCount,
    repostCount: metrics.repostCount,
    likeCount: metrics.likeCount,
    viewCount: metrics.viewCount,
  };
}

function isPostMediaUrl(src: string): boolean {
  const normalized = src.toLowerCase();
  return (
    normalized.includes("/media/") ||
    normalized.includes("/card_img/") ||
    normalized.includes("video_thumb") ||
    normalized.includes("/amplify_video_thumb/")
  );
}

export async function collectRenderedSearchSnapshot(
  page: Page,
): Promise<RenderedSearchSnapshot> {
  return page.evaluate(() => {
    type RenderedElement = {
      readonly textContent?: string | null;
      readonly href?: string;
      readonly src?: string;
      querySelector?(selector: string): RenderedElement | null;
      querySelectorAll(selector: string): Iterable<RenderedElement>;
    };
    const documentRef = (
      globalThis as unknown as {
        readonly document: {
          querySelector(selector: string): RenderedElement | null;
          querySelectorAll(selector: string): Iterable<RenderedElement>;
          readonly body?: { readonly textContent?: string | null };
        };
      }
    ).document;
    const serializeLink = (anchor: RenderedElement) => {
      const image = anchor.querySelector?.("img") ?? null;
      return {
        href: anchor.href ?? "",
        text: anchor.textContent ?? "",
        imageSrc: image?.src ?? null,
      };
    };
    const isProfileHref = (href: string) => {
      try {
        const url = new URL(href, "https://x.com");
        const parts = url.pathname.split("/").filter(Boolean);
        const handle = parts[0]?.trim().replace(/^@+/, "").toLowerCase() ?? "";
        return (
          ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
            url.hostname.toLowerCase(),
          ) &&
          parts.length === 1 &&
          /^[a-z0-9_]{1,15}$/.test(handle) &&
          ![
            "home",
            "login",
            "signup",
            "search",
            "explore",
            "i",
            "settings",
            "notifications",
            "messages",
            "who_to_follow",
          ].includes(handle)
        );
      } catch {
        return false;
      }
    };
    const resultCells = Array.from(
      documentRef.querySelectorAll('main [data-testid="cellInnerDiv"]'),
    );
    const peopleRows = resultCells.map((row) => ({
      text: row.textContent ?? "",
      links: Array.from(row.querySelectorAll("a")).map(serializeLink),
    }));
    const linkRows = resultCells.flatMap((row) =>
      Array.from(row.querySelectorAll("a")).map(serializeLink),
    );
    const articleRows = Array.from(
      documentRef.querySelectorAll("main article"),
    ).map((article) => {
      const links = Array.from(article.querySelectorAll("a"));
      const profileLinks = links
        .map(serializeLink)
        .filter((link) => isProfileHref(link.href));
      const socialContext =
        article.querySelector?.('[data-testid="socialContext"]') ?? null;
      const repostContext = socialContext
        ? {
            text: socialContext.textContent ?? "",
            profileLinks: Array.from(socialContext.querySelectorAll("a"))
              .map(serializeLink)
              .filter((link) => isProfileHref(link.href)),
          }
        : null;

      return {
        text: article.textContent ?? "",
        links: links.map((anchor) => anchor.href ?? ""),
        imageSrcs: Array.from(article.querySelectorAll("img"))
          .map((img) => img.src ?? "")
          .filter(Boolean),
        profileLinks,
        repostContext,
      };
    });
    return {
      links: linkRows,
      peopleRows,
      articles: articleRows,
      mainText: documentRef.querySelector("main")?.textContent ?? "",
      bodyText: documentRef.body?.textContent ?? "",
    };
  });
}

export function extractPeopleFromSnapshot(
  snapshot: RenderedSearchSnapshot,
  limit: number,
): XSearchParseResult<XPeopleCandidate> {
  const seen = new Set<string>();
  const items: XPeopleCandidate[] = [];
  const links = snapshot.peopleRows?.length
    ? snapshot.peopleRows.flatMap((row) =>
        row.links.map((link) => ({ ...link, text: row.text || link.text })),
      )
    : snapshot.links;

  for (const link of links) {
    if (items.length >= limit) break;
    if (statusParts(link.href)) continue;
    const handle = profileHandleFromHref(link.href);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    items.push({
      handle,
      displayName: displayNameFromText(link.text, handle),
      avatarUrl: link.imageSrc,
      bio: null,
      followerCount: null,
      followingCount: null,
      postsCount: null,
      verified: false,
      rank: items.length + 1,
      sourceUrl: `https://x.com/${handle}`,
    });
  }

  return { items, nextCursor: null, hasMore: false };
}

export function extractLatestFromSnapshot(
  snapshot: RenderedSearchSnapshot,
  limit: number,
): XSearchParseResult<XLatestPostResult> {
  const seen = new Set<string>();
  const items: XLatestPostResult[] = [];

  for (const article of snapshot.articles) {
    if (items.length >= limit) break;
    const status = article.links
      .map(statusParts)
      .find((item): item is NonNullable<ReturnType<typeof statusParts>> =>
        Boolean(item),
      );
    if (!status || seen.has(status.id)) continue;
    seen.add(status.id);
    const postMedia = article.imageSrcs.filter(isPostMediaUrl);
    const articleText = cleanPostTextFromArticleText(
      article.text,
      status.handle,
    );
    const profileLinks = article.profileLinks ?? [];
    const authorProfile = bestProfileIdentity(
      profileLinks,
      (handle) => handle === status.handle,
    );
    const repostContext = article.repostContext;
    const repostedBy = repostContext
      ? (bestProfileIdentity(
          repostContext.profileLinks,
          (handle) => handle !== status.handle,
        ) ?? bestProfileIdentity(repostContext.profileLinks, () => true))
      : null;
    const isRepost = Boolean(
      repostContext &&
        (repostContext.profileLinks.length > 0 ||
          /\breposted\b/i.test(repostContext.text)),
    );
    items.push({
      externalId: status.id,
      sourceUrl: status.sourceUrl,
      authorHandle: status.handle,
      authorDisplayName:
        authorProfile?.displayName ??
        (isRepost ? null : articleText.displayName),
      authorAvatarUrl: authorProfile?.avatarUrl ?? article.imageSrcs[0] ?? null,
      isRepost,
      repostedByHandle: repostedBy?.handle ?? null,
      repostedByDisplayName: repostedBy?.displayName ?? null,
      repostedByAvatarUrl: repostedBy?.avatarUrl ?? null,
      text: articleText.text,
      postedAt: null,
      replyCount: articleText.replyCount,
      repostCount: articleText.repostCount,
      quoteCount: null,
      likeCount: articleText.likeCount,
      viewCount: articleText.viewCount,
      media: postMedia.map((src) => ({
        mediaType: "photo",
        mediaUrl: src,
        thumbnailUrl: src,
        width: null,
        height: null,
        durationSeconds: null,
      })),
      rank: items.length + 1,
    });
  }

  return { items, nextCursor: null, hasMore: false };
}

export function mergePeopleResults(
  graphqlItems: XPeopleCandidate[],
  domItems: XPeopleCandidate[],
  limit: number,
): XPeopleCandidate[] {
  const byHandle = new Map<string, XPeopleCandidate>();
  for (const item of [...graphqlItems, ...domItems]) {
    const previous = byHandle.get(item.handle);
    byHandle.set(
      item.handle,
      previous
        ? {
            ...item,
            ...previous,
            avatarUrl: previous.avatarUrl ?? item.avatarUrl,
          }
        : item,
    );
  }
  return Array.from(byHandle.values())
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export function mergeLatestResults(
  graphqlItems: XLatestPostResult[],
  domItems: XLatestPostResult[],
  limit: number,
): XLatestPostResult[] {
  const keyFor = (item: XLatestPostResult) => item.externalId ?? item.sourceUrl;
  const byId = new Map<string, XLatestPostResult>();
  for (const item of [...graphqlItems, ...domItems]) {
    const key = keyFor(item);
    const previous = byId.get(key);
    byId.set(
      key,
      previous
        ? {
            ...item,
            ...previous,
            viewCount: previous.viewCount ?? item.viewCount,
            media: previous.media.length ? previous.media : item.media,
          }
        : item,
    );
  }
  return Array.from(byId.values())
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

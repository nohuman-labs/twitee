import type {
  XLatestPostResult,
  XPeopleCandidate,
  XSearchParseResult,
} from "./search-types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isCompleteSearchTimelinePayload(value: unknown): boolean {
  const root = asRecord(value);
  const data = asRecord(root?.data);
  const search = asRecord(data?.search_by_raw_query ?? data?.searchByRawQuery);
  const searchTimeline = asRecord(
    search?.search_timeline ?? search?.searchTimeline,
  );
  const timeline = asRecord(searchTimeline?.timeline);

  return Boolean(timeline && Array.isArray(timeline.instructions));
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

const maxVideoBitrate = 2_176_000;

function normalizeHandle(value: string | null): string | null {
  const handle = value?.trim().replace(/^@+/, "").toLowerCase() ?? "";
  return handle ? handle : null;
}

function normalizeAvatarUrl(value: string | null): string | null {
  return value?.replace(/_normal(\.[a-z]+)$/i, "$1") ?? null;
}

function parseDateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function walkGraph(
  value: unknown,
  visitor: (node: Record<string, unknown>) => boolean | undefined,
): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (walkGraph(item, visitor)) return true;
    }
    return false;
  }

  const node = value as Record<string, unknown>;
  if (visitor(node)) return true;
  for (const child of Object.values(node)) {
    if (walkGraph(child, visitor)) return true;
  }
  return false;
}

function bottomCursorFromNode(node: Record<string, unknown>): string | null {
  const cursorType = (
    stringOrNull(node.cursorType) ?? stringOrNull(node.cursor_type)
  )?.toLowerCase();
  const typeText = [
    stringOrNull(node.entryType),
    stringOrNull(node.__typename),
    stringOrNull(node.type),
    stringOrNull(node.itemType),
    stringOrNull(node.entryId),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  if (cursorType !== "bottom" && !typeText.includes("cursor")) return null;
  if (cursorType && cursorType !== "bottom") return null;

  return stringOrNull(node.value) ?? stringOrNull(node.cursor);
}

function extractBottomCursor(data: unknown): string | null {
  let cursor: string | null = null;

  walkGraph(data, (node) => {
    const value = bottomCursorFromNode(node);
    if (value) cursor = value;
    return false;
  });

  return cursor;
}

function normalizeUserResult(value: unknown): Record<string, unknown> | null {
  const node = asRecord(value);
  if (!node) return null;

  const legacy = asRecord(node.legacy);
  const core = asRecord(node.core);
  if (legacy?.screen_name || core?.screen_name || node.screen_name) return node;

  return (
    normalizeUserResult(node.result) ??
    normalizeUserResult(node.user) ??
    normalizeUserResult(asRecord(node.user_results)?.result)
  );
}

function normalizeTweetResult(value: unknown): Record<string, unknown> | null {
  const node = asRecord(value);
  if (!node) return null;

  const legacy = asRecord(node.legacy);
  if (legacy && (node.rest_id || legacy.id_str || legacy.conversation_id_str))
    return node;

  return (
    normalizeTweetResult(node.result) ??
    normalizeTweetResult(node.tweet) ??
    normalizeTweetResult(asRecord(node.tweet_results)?.result)
  );
}

function tweetUserResult(
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  return normalizeUserResult(
    asRecord(asRecord(result.core)?.user_results)?.result,
  );
}

function repostedTweetResult(
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  const legacy = asRecord(result.legacy);
  return (
    normalizeTweetResult(asRecord(legacy?.retweeted_status_result)?.result) ??
    normalizeTweetResult(legacy?.retweeted_status_result) ??
    normalizeTweetResult(asRecord(result.retweeted_status_result)?.result) ??
    normalizeTweetResult(result.retweeted_status_result)
  );
}

function quotedTweetResult(
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  const legacy = asRecord(result.legacy);
  return (
    normalizeTweetResult(asRecord(legacy?.quoted_status_result)?.result) ??
    normalizeTweetResult(legacy?.quoted_status_result) ??
    normalizeTweetResult(asRecord(result.quoted_status_result)?.result) ??
    normalizeTweetResult(result.quoted_status_result)
  );
}

function parseUserResult(
  result: Record<string, unknown>,
  rank: number,
): XPeopleCandidate | null {
  const legacy = asRecord(result.legacy);
  const core = asRecord(result.core);
  const avatar = asRecord(result.avatar);
  const verification = asRecord(result.verification);
  const handle = normalizeHandle(
    stringOrNull(legacy?.screen_name) ??
      stringOrNull(core?.screen_name) ??
      stringOrNull(result.screen_name),
  );
  if (!handle) return null;

  return {
    handle,
    displayName:
      stringOrNull(legacy?.name) ??
      stringOrNull(core?.name) ??
      stringOrNull(result.name),
    avatarUrl: normalizeAvatarUrl(
      stringOrNull(legacy?.profile_image_url_https) ??
        stringOrNull(legacy?.profile_image_url) ??
        stringOrNull(avatar?.image_url) ??
        stringOrNull(result.profile_image_url_https),
    ),
    bio: stringOrNull(legacy?.description),
    followerCount: numberOrNull(legacy?.followers_count),
    followingCount: numberOrNull(legacy?.friends_count),
    postsCount: numberOrNull(legacy?.statuses_count),
    verified:
      verification?.verified === true ||
      result.is_blue_verified === true ||
      legacy?.verified === true,
    rank,
    sourceUrl: `https://x.com/${handle}`,
  };
}

function selectVideoSources(item: Record<string, unknown>) {
  const videoInfo = asRecord(item.video_info);
  const variants = Array.isArray(videoInfo?.variants) ? videoInfo.variants : [];
  const normalized = variants
    .map((variant) => asRecord(variant))
    .filter((variant): variant is Record<string, unknown> => Boolean(variant))
    .map((variant) => {
      const url = stringOrNull(variant.url);
      if (!url) return null;
      const rawType = stringOrNull(variant.content_type);
      const type =
        rawType ??
        (url.includes(".m3u8")
          ? "application/x-mpegURL"
          : url.includes(".mp4")
            ? "video/mp4"
            : null);
      if (!type) return null;
      const bitrate = numberOrNull(variant.bitrate);
      return {
        ...(bitrate !== null && bitrate > 0 ? { bitrate } : {}),
        type,
        url,
      };
    })
    .filter(
      (source): source is { bitrate?: number; type: string; url: string } =>
        Boolean(source),
    );

  const hls = normalized.filter(
    (source) =>
      source.type === "application/x-mpegURL" || source.url.includes(".m3u8"),
  );
  const mp4 = normalized
    .filter(
      (source) => source.type === "video/mp4" || source.url.includes(".mp4"),
    )
    .sort(
      (a, b) =>
        (b.bitrate ?? Number.NEGATIVE_INFINITY) -
        (a.bitrate ?? Number.NEGATIVE_INFINITY),
    );
  return [...hls, ...mp4];
}

function selectVideoUrl(item: Record<string, unknown>): string | null {
  const videoInfo = asRecord(item.video_info);
  const variants = Array.isArray(videoInfo?.variants) ? videoInfo.variants : [];
  const mp4Variants = variants
    .map((variant) => asRecord(variant))
    .filter((variant): variant is Record<string, unknown> => Boolean(variant))
    .filter(
      (variant) =>
        stringOrNull(variant.content_type) === "video/mp4" ||
        stringOrNull(variant.url)?.includes(".mp4"),
    )
    .sort((a, b) => {
      const aBitrate = numberOrNull(a.bitrate);
      const bBitrate = numberOrNull(b.bitrate);
      return (
        (aBitrate !== null && aBitrate > 0
          ? aBitrate
          : Number.POSITIVE_INFINITY) -
        (bBitrate !== null && bBitrate > 0
          ? bBitrate
          : Number.POSITIVE_INFINITY)
      );
    });
  const cappedVariant = mp4Variants
    .filter((variant) => {
      const bitrate = numberOrNull(variant.bitrate);
      return bitrate !== null && bitrate > 0 && bitrate <= maxVideoBitrate;
    })
    .at(-1);

  return stringOrNull((cappedVariant ?? mp4Variants[0])?.url);
}

function parseMedia(row: unknown): XLatestPostResult["media"][number] | null {
  const item = asRecord(row);
  if (!item) return null;

  const type = stringOrNull(item.type);
  const imageValue = asRecord(item.image_value);
  const rawImageUrl = stringOrNull(imageValue?.url);
  const imageUrl = rawImageUrl?.includes("/card_img/") ? rawImageUrl : null;
  const videoUrl =
    type === "video" || type === "animated_gif" ? selectVideoUrl(item) : null;
  const mediaUrl =
    videoUrl ??
    stringOrNull(item.media_url_https) ??
    stringOrNull(item.media_url) ??
    imageUrl;
  if (!mediaUrl) return null;

  const sizes = asRecord(item.sizes);
  const large = asRecord(sizes?.large) ?? asRecord(sizes?.medium);
  const durationMillis = numberOrNull(
    asRecord(item.video_info)?.duration_millis,
  );
  const sources =
    type === "video" || type === "animated_gif" ? selectVideoSources(item) : [];
  return {
    mediaType:
      type === "video" || type === "animated_gif"
        ? "video"
        : type === "photo" || imageUrl
          ? "photo"
          : "unknown",
    mediaUrl,
    thumbnailUrl:
      stringOrNull(item.media_url_https) ??
      stringOrNull(item.media_url) ??
      mediaUrl,
    width: numberOrNull(large?.w) ?? numberOrNull(imageValue?.width),
    height: numberOrNull(large?.h) ?? numberOrNull(imageValue?.height),
    durationSeconds: durationMillis != null ? durationMillis / 1000 : null,
    ...(sources.length ? { sources } : {}),
  };
}

function mediaEntityUrls(rows: readonly unknown[]): string[] {
  return rows
    .map((row) => stringOrNull(asRecord(row)?.url))
    .filter((url): url is string => Boolean(url));
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function bindingValueString(value: unknown): string | null {
  const entry = asRecord(value);
  if (!entry) return null;
  const innerValue = asRecord(entry.value);
  return (
    stringOrNull(innerValue?.string_value) ??
    stringOrNull(innerValue?.stringValue) ??
    stringOrNull(entry.value)
  );
}

function cardBindingValues(result: Record<string, unknown>): unknown[] {
  const card = asRecord(result.card);
  const legacy = asRecord(card?.legacy);
  return Array.isArray(legacy?.binding_values)
    ? legacy.binding_values
    : Array.isArray(card?.binding_values)
      ? card.binding_values
      : [];
}

function unifiedCardPayloads(
  result: Record<string, unknown>,
): Record<string, unknown>[] {
  return cardBindingValues(result)
    .filter((value) => stringOrNull(asRecord(value)?.key) === "unified_card")
    .map((value) => parseJsonRecord(bindingValueString(value)))
    .filter((value): value is Record<string, unknown> => Boolean(value));
}

function directCardImageRows(
  result: Record<string, unknown>,
): Record<string, unknown>[] {
  const candidates = cardBindingValues(result)
    .map((binding) => {
      const entry = asRecord(binding);
      const key = stringOrNull(entry?.key)?.toLowerCase() ?? "";
      const value = asRecord(entry?.value);
      const media = parseMedia(value);
      return key.includes("image") && media
        ? { row: value, area: (media.width ?? 0) * (media.height ?? 0) }
        : null;
    })
    .filter(
      (
        candidate,
      ): candidate is { row: Record<string, unknown>; area: number } =>
        Boolean(candidate),
    )
    .sort((a, b) => b.area - a.area);

  return candidates[0] ? [candidates[0].row] : [];
}

function mediaRowsFromUnifiedCard(
  result: Record<string, unknown>,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const payload of [
    ...unifiedCardPayloads(result),
    ...directCardImageRows(result),
  ]) {
    walkGraph(payload, (node) => {
      const media = parseMedia(node);
      if (!media) return false;

      const key = `${media.mediaType}:${media.mediaUrl}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(node);
      }
      return false;
    });
  }

  return rows;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanPostText(rawText: string | null, mediaUrls: readonly string[]) {
  if (!rawText) return null;

  let text = rawText;
  for (const url of mediaUrls) {
    text = text.replace(new RegExp(`\\s*${escapeRegExp(url)}`, "g"), "");
  }

  const normalized = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized ? normalized : null;
}

function parseLatestPostResult(
  result: Record<string, unknown>,
  rank: number,
  fallbackUserResult: Record<string, unknown> | null = null,
  options: { readonly isPinned?: boolean } = {},
): XLatestPostResult | null {
  const repostedResult = repostedTweetResult(result);
  const contentResult = repostedResult ?? result;
  const legacy = asRecord(contentResult.legacy);
  if (!legacy) return null;

  const externalId =
    stringOrNull(contentResult.rest_id) ??
    stringOrNull(legacy.id_str) ??
    stringOrNull(legacy.conversation_id_str);
  if (!externalId) return null;

  const userResult = tweetUserResult(contentResult) ?? fallbackUserResult;
  const reposterResult = repostedResult ? tweetUserResult(result) : null;
  const userLegacy = asRecord(userResult?.legacy);
  const reposterLegacy = asRecord(reposterResult?.legacy);
  const authorHandle = normalizeHandle(
    stringOrNull(userLegacy?.screen_name) ??
      stringOrNull(asRecord(userResult?.core)?.screen_name) ??
      stringOrNull(userResult?.screen_name),
  );
  const repostedByHandle = normalizeHandle(
    stringOrNull(reposterLegacy?.screen_name) ??
      stringOrNull(asRecord(reposterResult?.core)?.screen_name) ??
      stringOrNull(reposterResult?.screen_name),
  );
  const entities = asRecord(legacy.entities);
  const extendedEntities = asRecord(legacy.extended_entities);
  const mediaRows = Array.isArray(extendedEntities?.media)
    ? extendedEntities.media
    : Array.isArray(entities?.media)
      ? entities.media
      : [];
  const cardMediaRows = mediaRowsFromUnifiedCard(contentResult);
  const allMediaRows = [...mediaRows, ...cardMediaRows];
  const text = cleanPostText(
    stringOrNull(legacy.full_text) ?? stringOrNull(legacy.text),
    [
      ...mediaEntityUrls(mediaRows),
      ...(cardMediaRows.length > 0 && Array.isArray(entities?.urls)
        ? mediaEntityUrls(entities.urls)
        : []),
    ],
  );
  const quotedPostResult = quotedTweetResult(contentResult);
  const quotedPost = quotedPostResult
    ? parseLatestPostResult(quotedPostResult, rank)
    : null;

  return {
    externalId,
    sourceUrl: authorHandle
      ? `https://x.com/${authorHandle}/status/${externalId}`
      : `https://x.com/i/web/status/${externalId}`,
    authorHandle,
    authorDisplayName:
      stringOrNull(userLegacy?.name) ??
      stringOrNull(asRecord(userResult?.core)?.name) ??
      stringOrNull(userResult?.name),
    authorAvatarUrl: normalizeAvatarUrl(
      stringOrNull(userLegacy?.profile_image_url_https) ??
        stringOrNull(userLegacy?.profile_image_url) ??
        stringOrNull(asRecord(userResult?.avatar)?.image_url) ??
        stringOrNull(userResult?.profile_image_url_https),
    ),
    isPinned: options.isPinned === true,
    isRepost: Boolean(repostedResult),
    repostedByHandle,
    repostedByDisplayName: repostedResult
      ? (stringOrNull(reposterLegacy?.name) ??
        stringOrNull(asRecord(reposterResult?.core)?.name) ??
        stringOrNull(reposterResult?.name))
      : null,
    repostedByAvatarUrl: repostedResult
      ? normalizeAvatarUrl(
          stringOrNull(reposterLegacy?.profile_image_url_https) ??
            stringOrNull(reposterLegacy?.profile_image_url) ??
            stringOrNull(asRecord(reposterResult?.avatar)?.image_url) ??
            stringOrNull(reposterResult?.profile_image_url_https),
        )
      : null,
    text,
    postedAt: parseDateOrNull(legacy.created_at),
    replyCount: numberOrNull(legacy.reply_count),
    repostCount: numberOrNull(legacy.retweet_count),
    likeCount: numberOrNull(legacy.favorite_count),
    viewCount: numberOrNull(
      legacy.view_count ?? asRecord(contentResult.views)?.count,
    ),
    quoteCount: numberOrNull(legacy.quote_count),
    media: allMediaRows
      .map(parseMedia)
      .filter((item): item is XLatestPostResult["media"][number] =>
        Boolean(item),
      ),
    quotedPost: quotedPost
      ? {
          externalId: quotedPost.externalId,
          sourceUrl: quotedPost.sourceUrl,
          authorHandle: quotedPost.authorHandle,
          authorDisplayName: quotedPost.authorDisplayName,
          authorAvatarUrl: quotedPost.authorAvatarUrl,
          text: quotedPost.text,
          postedAt: quotedPost.postedAt,
          replyCount: quotedPost.replyCount,
          repostCount: quotedPost.repostCount,
          likeCount: quotedPost.likeCount,
          viewCount: quotedPost.viewCount,
          quoteCount: quotedPost.quoteCount,
          media: quotedPost.media,
        }
      : null,
    rank,
  };
}

function timelineContextText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return typeof value === "string" ? value : null;
  }

  return (
    stringOrNull(record.text) ??
    stringOrNull(record.context) ??
    stringOrNull(record.contextText) ??
    stringOrNull(record.label) ??
    stringOrNull(record.type)
  );
}

function hasPinnedTimelineContext(node: Record<string, unknown>): boolean {
  const itemContent = asRecord(asRecord(node.content)?.itemContent);
  const candidates = [
    node.socialContext,
    node.social_context,
    node.context,
    asRecord(node.content)?.socialContext,
    itemContent?.socialContext,
    itemContent?.social_context,
    itemContent?.context,
  ];

  return candidates.some((candidate) =>
    timelineContextText(candidate)?.toLowerCase().includes("pinned"),
  );
}

export function parsePeopleFromSearch(
  data: unknown,
  limit = 20,
): XSearchParseResult<XPeopleCandidate> {
  const seen = new Set<string>();
  const items: XPeopleCandidate[] = [];

  walkGraph(data, (node) => {
    if (items.length >= limit) return true;

    const userResult =
      normalizeUserResult(asRecord(node.user_results)?.result) ??
      normalizeUserResult(asRecord(node.user)?.result);
    if (!userResult) return false;

    const candidate = parseUserResult(userResult, items.length + 1);
    if (!candidate || seen.has(candidate.handle)) return false;
    seen.add(candidate.handle);
    items.push(candidate);
    return items.length >= limit;
  });

  const nextCursor = extractBottomCursor(data);
  return { items, nextCursor, hasMore: nextCursor !== null };
}

export function parseLatestPostsFromSearch(
  data: unknown,
  limit = 20,
): XSearchParseResult<XLatestPostResult> {
  const seen = new Set<string>();
  const items: XLatestPostResult[] = [];
  const profileUserResult = normalizeUserResult(
    asRecord(asRecord(data)?.data)?.user,
  );

  walkGraph(data, (node) => {
    if (items.length >= limit) return true;

    const tweetResult =
      normalizeTweetResult(asRecord(node.tweet_results)?.result) ??
      normalizeTweetResult(asRecord(node.tweet)?.result);
    if (!tweetResult) return false;

    const post = parseLatestPostResult(
      tweetResult,
      items.length + 1,
      profileUserResult,
      { isPinned: hasPinnedTimelineContext(node) },
    );
    if (!post?.externalId || seen.has(post.externalId)) return false;
    seen.add(post.externalId);
    items.push(post);
    return items.length >= limit;
  });

  const nextCursor = extractBottomCursor(data);
  return { items, nextCursor, hasMore: nextCursor !== null };
}

export function summarizeLatestSearchPayloadForDebug(
  data: unknown,
  limit = 20,
): Record<string, unknown> {
  let tweetContainers = 0;
  let normalizedTweets = 0;
  let parsedPosts = 0;
  let duplicatePosts = 0;
  let missingLegacy = 0;
  let missingId = 0;
  let missingText = 0;
  let missingAuthor = 0;
  const seen = new Set<string>();
  const profileUserResult = normalizeUserResult(
    asRecord(asRecord(data)?.data)?.user,
  );

  walkGraph(data, (node) => {
    if (parsedPosts >= limit) return true;

    if (asRecord(node.tweet_results) || asRecord(node.tweet)) {
      tweetContainers += 1;
    }

    const tweetResult =
      normalizeTweetResult(asRecord(node.tweet_results)?.result) ??
      normalizeTweetResult(asRecord(node.tweet)?.result);
    if (!tweetResult) return false;

    normalizedTweets += 1;
    const repostedResult = repostedTweetResult(tweetResult);
    const contentResult = repostedResult ?? tweetResult;
    const legacy = asRecord(contentResult.legacy);
    if (!legacy) {
      missingLegacy += 1;
      return false;
    }

    const externalId =
      stringOrNull(contentResult.rest_id) ??
      stringOrNull(legacy.id_str) ??
      stringOrNull(legacy.conversation_id_str);
    if (!externalId) {
      missingId += 1;
      return false;
    }

    const userResult = tweetUserResult(contentResult) ?? profileUserResult;
    const userLegacy = asRecord(userResult?.legacy);
    const authorHandle = normalizeHandle(
      stringOrNull(userLegacy?.screen_name) ??
        stringOrNull(asRecord(userResult?.core)?.screen_name) ??
        stringOrNull(userResult?.screen_name),
    );
    if (!authorHandle) {
      missingAuthor += 1;
    }

    const post = parseLatestPostResult(
      tweetResult,
      parsedPosts + 1,
      profileUserResult,
    );
    if (!post?.externalId) return false;
    if (seen.has(post.externalId)) {
      duplicatePosts += 1;
      return false;
    }
    if (!post.text) {
      missingText += 1;
    }

    seen.add(post.externalId);
    parsedPosts += 1;
    return parsedPosts >= limit;
  });

  return {
    payloadKind: Array.isArray(data) ? "array" : typeof data,
    bottomCursorPresent: Boolean(extractBottomCursor(data)),
    tweetContainers,
    normalizedTweets,
    parsedPosts,
    duplicatePosts,
    missingLegacy,
    missingId,
    missingText,
    missingAuthor,
  };
}

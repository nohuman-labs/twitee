import type { XSearchIntentResult, XSearchMode } from "./search-types.js";

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
]);
const X_HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;
const X_RESERVED = new Set([
  "home",
  "login",
  "signup",
  "search",
  "explore",
  "i",
  "settings",
]);

function normalizeHandle(value: string): string | null {
  const handle = value.trim().replace(/^@+/, "").toLowerCase();
  if (!handle || !X_HANDLE_PATTERN.test(handle) || X_RESERVED.has(handle))
    return null;
  return handle;
}

export function detectXSearchIntent(rawQuery: string): XSearchIntentResult {
  const raw = rawQuery.trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;

  if (raw.startsWith("@")) {
    const handle = normalizeHandle(raw);
    return {
      rawQuery,
      normalizedQuery: handle ?? raw.toLowerCase(),
      intent: "profile",
      handle,
      profileUrl: handle ? `https://x.com/${handle}` : null,
    };
  }

  if (raw.includes("/") || /(?:^|\.)x\.com|twitter\.com/i.test(raw)) {
    try {
      const url = new URL(withProtocol);
      const host = url.hostname.toLowerCase();
      const handle = normalizeHandle(
        url.pathname.split("/").filter(Boolean)[0] ?? "",
      );
      if (host && X_HOSTS.has(host) && handle) {
        return {
          rawQuery,
          normalizedQuery: handle,
          intent: "profile",
          handle,
          profileUrl: `https://x.com/${handle}`,
        };
      }
    } catch {
      // Fall through to unified search.
    }
  }

  return {
    rawQuery,
    normalizedQuery: raw.toLowerCase(),
    intent: "unified",
    handle: null,
    profileUrl: null,
  };
}

export function xSearchUrl(query: string, mode: XSearchMode): string {
  if (mode === "latest") {
    const params = new URLSearchParams({
      q: query,
      vertical: "trends",
    });
    return `https://x.com/search?${params.toString()}`;
  }

  const f = "user";
  const params = new URLSearchParams({
    q: query,
    src: "typed_query",
    f,
  });
  return `https://x.com/search?${params.toString()}`;
}

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { RuntimeBrowserContext, RuntimeStorageState } from "./browser.js";
import {
  normalizeHandle,
  parseCursor,
  parsePostId,
  parseQuery,
  type ApiErrorCode,
} from "./contracts.js";
import type { LoginService } from "./login-runner.js";
import {
  ProviderCaptureTimeoutError,
  type ProviderCallContext,
  type ProviderOutcome,
  type XProvider,
} from "./provider/types.js";
import { QueueFullError, RequestTimeoutError } from "./request-gate.js";

type RequestGate = {
  run<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
};

type BrowserHost = {
  newCredentialContext(input: {
    readonly storageState: RuntimeStorageState;
  }): Promise<RuntimeBrowserContext>;
};

export function createTwiteeServer(options: {
  readonly apiKey: string;
  readonly noVncBaseUrl: string;
  readonly loginService: LoginService;
  readonly provider: XProvider;
  readonly browserHost: BrowserHost;
  readonly browserReady: () => Promise<boolean>;
  readonly requestGate: RequestGate;
}): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(response, 200, { ok: true, service: "twitee" });
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        let ready = false;
        try {
          ready =
            options.loginService.get().status === "ready" &&
            (await options.browserReady()) &&
            (await options.loginService.storageState()) !== null;
        } catch {
          ready = false;
        }
        return json(response, ready ? 200 : 503, { ok: ready });
      }
      if (!url.pathname.startsWith("/v1/")) {
        return failure(response, 404, "not_found", "Route not found.");
      }
      if (!authorized(request.headers.authorization, options.apiKey)) {
        return failure(response, 401, "unauthorized", "A valid Bearer API key is required.");
      }

      if (request.method === "POST" && url.pathname === "/v1/session/login") {
        const login = options.loginService.start();
        const loginUrl = new URL(options.noVncBaseUrl);
        loginUrl.searchParams.set("capability", login.capability);
        return success(response, 202, {
          status: "login_pending",
          expires_at: login.expiresAt,
          no_vnc_url: loginUrl.toString(),
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/session") {
        return success(response, 200, options.loginService.get());
      }
      if (request.method === "DELETE" && url.pathname === "/v1/session") {
        await options.loginService.remove();
        return success(response, 200, options.loginService.get());
      }

      const operation = routeOperation(request.method ?? "GET", url, options.provider);
      if (!operation) return failure(response, 404, "not_found", "Route not found.");
      const storageState = await options.loginService.storageState();
      if (!storageState) {
        return failure(response, 401, "not_authenticated", "Log in to X before crawling.");
      }
      const aborted = new AbortController();
      request.once("aborted", () => aborted.abort());
      const outcome = await options.requestGate.run(aborted.signal, async (signal) => {
        const context = await options.browserHost.newCredentialContext({ storageState });
        const closeOnAbort = () => void context.close().catch(() => undefined);
        signal.addEventListener("abort", closeOnAbort, { once: true });
        try {
          const page = context.pages()[0] ?? (await context.newPage());
          const providerContext: ProviderCallContext = {
            browserContext: { context, page, release: () => context.close() },
            continuation: { cursor: operation.cursor, pageDepth: null },
          };
          return await operation.run(providerContext);
        } finally {
          signal.removeEventListener("abort", closeOnAbort);
          await context.close().catch(() => undefined);
        }
      });
      return sendOutcome(response, operation.collection, outcome);
    } catch (error) {
      if (isInputError(error)) return failure(response, 400, "invalid_input", error.message);
      if (error instanceof QueueFullError) return failure(response, 503, "queue_full", "Crawler queue is full.");
      if (error instanceof RequestTimeoutError || error instanceof ProviderCaptureTimeoutError) {
        return failure(response, 504, "upstream_timeout", "X did not respond before the deadline.");
      }
      return failure(response, 500, "internal_error", "The request could not be completed.");
    }
  });
}

function routeOperation(method: string, url: URL, provider: XProvider): {
  readonly collection: boolean;
  readonly cursor: string | null;
  run(context: ProviderCallContext): Promise<ProviderOutcome<unknown>>;
} | null {
  if (method !== "GET") return null;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  if (parts[0] !== "v1") return null;
  if (parts[1] === "profiles" && parts.length === 3) {
    const handle = normalizeHandle(parts[2] ?? "");
    return { collection: false, cursor, run: (context) => provider.openProfile(handle, context) };
  }
  if (parts[1] === "profiles" && parts[3] === "posts" && parts.length === 4) {
    const handle = normalizeHandle(parts[2] ?? "");
    return { collection: true, cursor, run: (context) => provider.listPosts(handle, context) };
  }
  if (parts[1] === "posts" && parts.length === 4) {
    const handle = normalizeHandle(parts[2] ?? "");
    const postId = parsePostId(parts[3] ?? "");
    return { collection: false, cursor, run: (context) => provider.openPost(handle, postId, context) };
  }
  if (parts[1] === "search" && parts[2] === "posts" && parts.length === 3) {
    const query = parseQuery(url.searchParams.get("q") ?? "");
    return { collection: true, cursor, run: (context) => provider.searchLatest(query, context) };
  }
  if (parts[1] === "search" && parts[2] === "people" && parts.length === 3) {
    const query = parseQuery(url.searchParams.get("q") ?? "");
    return { collection: true, cursor, run: (context) => provider.searchPeople(query, context) };
  }
  return null;
}

function sendOutcome(response: Parameters<typeof json>[0], collection: boolean, outcome: ProviderOutcome<unknown>) {
  switch (outcome.type) {
    case "success": return success(response, 200, outcome.data, outcome.nextCursor ?? null);
    case "temporary_empty": return collection
      ? success(response, 200, [])
      : failure(response, 502, "upstream_changed", "X returned an unexpected empty response.");
    case "protected": return failure(response, 403, "protected_account", "This X account is protected.");
    case "not_found":
    case "deleted_or_suspended": return failure(response, 404, "not_found", "The requested X resource was not found.");
    case "provider_rate_limited": return failure(response, 429, "rate_limited", "X rate limited this session.");
    case "browser_crash": return failure(response, 503, "browser_unavailable", "The browser is unavailable.");
  }
}

function authorized(header: string | undefined, expected: string): boolean {
  const value = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isInputError(error: unknown): error is Error {
  return error instanceof Error &&
    (error.name === "ZodError" || error instanceof URIError || /^(invalid|query|cursor)/.test(error.message));
}

function success(response: Parameters<typeof json>[0], status: number, data: unknown, nextCursor: string | null = null) {
  return json(response, status, { ok: true, data, next_cursor: nextCursor, error: null });
}

function failure(response: Parameters<typeof json>[0], status: number, code: ApiErrorCode, message: string) {
  return json(response, status, { ok: false, data: null, next_cursor: null, error: { code, message } });
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

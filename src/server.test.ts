import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStorageState } from "./browser.js";
import type { LoginService } from "./login-runner.js";
import type { XProvider } from "./provider/types.js";
import { createTwiteeServer } from "./server.js";

const servers: ReturnType<typeof createTwiteeServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("Twitee HTTP API", () => {
  it("serves health without exposing session state", async () => {
    const fixture = await startServer();

    const response = await fetch(`${fixture.baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "twitee" });
  });

  it("protects every v1 route with a bearer key", async () => {
    const fixture = await startServer();

    for (const path of [
      "/v1/session",
      "/v1/profiles/openai",
      "/v1/search/posts?q=x",
    ]) {
      const response = await fetch(fixture.baseUrl + path);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "unauthorized" },
      });
    }
  });

  it("reports readiness only with a stored session and usable browser", async () => {
    const missing = await startServer({ sessionStatus: "missing" });
    const unavailable = await fetch(`${missing.baseUrl}/readyz`);
    expect(unavailable.status).toBe(503);

    const ready = await startServer({ sessionStatus: "ready" });
    const available = await fetch(`${ready.baseUrl}/readyz`);
    expect(available.status).toBe(200);

    const corrupt = await startServer({ sessionStatus: "ready", storageError: true });
    expect((await fetch(`${corrupt.baseUrl}/readyz`)).status).toBe(503);
  });

  it("starts login without putting the API key in its URL", async () => {
    const fixture = await startServer();

    const response = await fixture.authorizedFetch("/v1/session/login", {
      method: "POST",
    });
    const body = (await response.json()) as {
      data: { no_vnc_url: string };
    };

    expect(response.status).toBe(202);
    expect(body.data.no_vnc_url).toContain("capability=login-capability");
    expect(body.data.no_vnc_url).not.toContain(fixture.apiKey);
  });

  it("returns a normalized profile synchronously", async () => {
    const fixture = await startServer({ sessionStatus: "ready" });

    const response = await fixture.authorizedFetch("/v1/profiles/@OpenAI");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        handle: "openai",
        displayName: "OpenAI",
        availabilityStatus: "available",
      },
      next_cursor: null,
      error: null,
    });
  });

  it("keeps the browser context open until provider work completes", async () => {
    const release = Promise.withResolvers<void>();
    const fixture = await startServer({
      sessionStatus: "ready",
      beforeProfileReturn: () => release.promise,
    });

    const pending = fixture.authorizedFetch("/v1/profiles/openai");
    await vi.waitFor(() => expect(fixture.provider.openProfile).toHaveBeenCalled());
    expect(fixture.browserContext.close).not.toHaveBeenCalled();

    release.resolve();
    expect((await pending).status).toBe(200);
    expect(fixture.browserContext.close).toHaveBeenCalledOnce();
  });

  it("rejects invalid route input before browser work", async () => {
    const fixture = await startServer({ sessionStatus: "ready" });

    const response = await fixture.authorizedFetch("/v1/profiles/not-valid!");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});

async function startServer(input: {
  sessionStatus?: "missing" | "ready";
  storageError?: boolean;
  beforeProfileReturn?: () => Promise<void>;
} = {}) {
  const apiKey = "a".repeat(32);
  const storageState: RuntimeStorageState = { cookies: [], origins: [] };
  const loginService: LoginService = {
    initialize: vi.fn(async () => undefined),
    start: vi.fn(() => ({
      capability: "login-capability",
      expiresAt: "2026-09-08T00:10:00.000Z",
    })),
    get: vi.fn(() => ({
      status: input.sessionStatus ?? "missing",
      startedAt: null,
      expiresAt: null,
      readyAt: null,
      error: null,
    })),
    authorizeCapability: vi.fn(() => false),
    storageState: vi.fn(async () => {
      if (input.storageError) throw new Error("credential decrypt failed");
      return input.sessionStatus === "ready" ? storageState : null;
    }),
    remove: vi.fn(async () => undefined),
  };
  const provider: XProvider = {
    openProfile: vi.fn(async (handle) => {
      await input.beforeProfileReturn?.();
      return {
        type: "success",
        data: {
          handle,
          displayName: "OpenAI",
          availabilityStatus: "available",
        },
      } as const;
    }),
    listPosts: vi.fn(async () => ({ type: "success", data: [] }) as const),
    openPost: vi.fn(async () => ({ type: "not_found" }) as const),
    searchLatest: vi.fn(async () => ({ type: "success", data: [] }) as const),
    searchPeople: vi.fn(async () => ({ type: "success", data: [] }) as const),
  };
  const browserContext = {
    pages: vi.fn(() => []),
    newPage: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
    browser: vi.fn(() => null),
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const server = createTwiteeServer({
    apiKey,
    noVncBaseUrl: "http://127.0.0.1:6080",
    loginService,
    provider,
    browserHost: {
      newCredentialContext: vi.fn(async () => browserContext),
    },
    browserReady: vi.fn(async () => true),
    requestGate: {
      run: async (_signal, operation) => operation(new AbortController().signal),
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    apiKey,
    baseUrl,
    provider,
    browserContext,
    authorizedFetch: (path: string, init: RequestInit = {}) =>
      fetch(baseUrl + path, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${apiKey}` },
      }),
  };
}

import type { RuntimeStorageState } from "./browser.js";
import type { CloakBrowserRuntime } from "./browser.js";
import type { CredentialStore } from "./credential-store.js";
import {
  type LoginSession,
  createLoginSession,
  isLoginCapabilityAuthorized,
} from "./login-session.js";

export type PublicSessionState = {
  readonly status: "missing" | "login_pending" | "ready" | "invalid" | "error";
  readonly startedAt: string | null;
  readonly expiresAt: string | null;
  readonly readyAt: string | null;
  readonly error: string | null;
};

export type LoginService = {
  initialize(): Promise<void>;
  start(): { readonly capability: string; readonly expiresAt: string };
  get(): PublicSessionState;
  authorizeCapability(value: string): boolean;
  storageState(): Promise<RuntimeStorageState | null>;
  remove(): Promise<void>;
};

type LoginPage = {
  goto(
    url: string,
    options: { readonly waitUntil: "domcontentloaded"; readonly timeout: number },
  ): Promise<unknown>;
  url(): string;
};

type LoginContext = {
  storageState(): Promise<RuntimeStorageState>;
};

export function createLoginService(options: {
  readonly browserRuntime: CloakBrowserRuntime;
  readonly credentialStore: CredentialStore;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly ttlMs?: number;
}): LoginService {
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let current: LoginSession | undefined;
  let runner: Promise<void> | undefined;
  let hasCredential = false;
  let state: PublicSessionState = publicState("missing");

  async function initialize(): Promise<void> {
    try {
      hasCredential = isUsableStorageState(await options.credentialStore.read());
      state = publicState(hasCredential ? "ready" : "missing");
    } catch {
      hasCredential = false;
      state = publicState("invalid", "Stored X session could not be decrypted.");
    }
  }

  function start(): { readonly capability: string; readonly expiresAt: string } {
    if (current?.status === "login_pending") {
      throw new Error("X login is already pending");
    }
    const session = createLoginSession(now(), options.ttlMs);
    current = session;
    state = {
      status: "login_pending",
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      readyAt: null,
      error: null,
    };
    const pending = run(session);
    runner = pending;
    void pending.finally(() => {
      if (runner === pending) runner = undefined;
    });
    return { capability: session.capability, expiresAt: session.expiresAt };
  }

  async function run(session: LoginSession): Promise<void> {
    let runtime:
      | { context: LoginContext; page: LoginPage; release(): Promise<void> }
      | undefined;
    try {
      runtime = (await options.browserRuntime.openPersistentCredentialContext({
        purpose: "credential_login",
        credentialId: "single-account",
        sessionId: session.capability,
        attemptId: "login",
        headless: false,
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
      })) as unknown as typeof runtime;
      if (!runtime) throw new Error("browser unavailable");
      await runtime.page.goto("https://x.com/login", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      while (current === session && now().getTime() <= Date.parse(session.expiresAt)) {
        if (isXHome(runtime.page.url())) {
          const storageState = await runtime.context.storageState();
          if (!hasRequiredCookies(storageState)) {
            throw new Error("unusable X session");
          }
          await options.credentialStore.write(JSON.stringify(storageState));
          if (current !== session) return;
          hasCredential = true;
          session.status = "ready";
          state = {
            status: "ready",
            startedAt: session.startedAt,
            expiresAt: null,
            readyAt: now().toISOString(),
            error: null,
          };
          return;
        }
        await sleep(options.pollMs ?? 2_000);
      }

      if (current === session) {
        session.status = "error";
        state = hasCredential
          ? { ...publicState("ready"), error: "X login session timed out." }
          : publicState("error", "X login session timed out.");
      }
    } catch {
      if (current === session) {
        session.status = "error";
        state = hasCredential
          ? {
              ...publicState("ready"),
              error: "X login did not return a usable session.",
            }
          : publicState("error", "X login did not return a usable session.");
      }
    } finally {
      await runtime?.release().catch(() => undefined);
    }
  }

  return {
    initialize,
    start,
    get: () => state,
    authorizeCapability(value) {
      return current
        ? isLoginCapabilityAuthorized(current, value, now())
        : false;
    },
    async storageState() {
      const serialized = await options.credentialStore.read();
      return parseStorageState(serialized);
    },
    async remove() {
      current = undefined;
      await runner;
      await options.credentialStore.remove();
      hasCredential = false;
      state = publicState("missing");
    },
  };
}

function publicState(
  status: PublicSessionState["status"],
  error: string | null = null,
): PublicSessionState {
  return {
    status,
    startedAt: null,
    expiresAt: null,
    readyAt: status === "ready" ? new Date().toISOString() : null,
    error,
  };
}

function parseStorageState(value: string | null): RuntimeStorageState | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as RuntimeStorageState;
    return hasRequiredCookies(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isUsableStorageState(value: string | null): boolean {
  return parseStorageState(value) !== null;
}

function hasRequiredCookies(value: RuntimeStorageState): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("cookies" in value) ||
    !Array.isArray(value.cookies)
  ) {
    return false;
  }
  const names = new Set(
    value.cookies
      .map((cookie: unknown) =>
          typeof cookie === "object" &&
          cookie !== null &&
          "name" in cookie &&
          typeof cookie.name === "string"
            ? cookie.name
            : null,
      )
      .filter((name): name is string => name !== null),
  );
  return names.has("auth_token") && names.has("ct0");
}

function isXHome(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.hostname === "x.com" || url.hostname.endsWith(".x.com")) &&
      url.pathname === "/home"
    );
  } catch {
    return false;
  }
}

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  binaryInfo,
  ensureBinary,
  launch,
  launchPersistentContext,
} from "cloakbrowser";

type LaunchPersistentContextInput = Parameters<
  typeof launchPersistentContext
>[0];
type LaunchOptions = Omit<LaunchPersistentContextInput, "userDataDir">;

export type RuntimePage = {
  close(): Promise<void>;
};

export type RuntimeStorageState = NonNullable<
  NonNullable<
    NonNullable<LaunchPersistentContextInput>["contextOptions"]
  >["storageState"]
>;

export type RuntimeBrowser = {
  newContext(options: {
    readonly storageState: RuntimeStorageState;
  }): Promise<RuntimeBrowserContext>;
  isConnected(): boolean;
  on(event: "disconnected", listener: () => void): void;
  close(): Promise<void>;
};

export type RuntimeBrowserContext = {
  pages(): RuntimePage[];
  newPage(): Promise<RuntimePage>;
  browser(): RuntimeBrowser | null;
  on(event: "close", listener: () => void): void;
  close(): Promise<void>;
};

export type RuntimeContext = {
  readonly context: RuntimeBrowserContext;
  readonly page: RuntimePage;
  readonly userDataDir?: string;
  release(): Promise<void>;
};

export type RuntimeContextPurpose =
  | "credential_login"
  | "credential_relogin"
  | "credential_validation";

export type CredentialContextInput = {
  readonly purpose: RuntimeContextPurpose;
  readonly credentialId: string;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly headless?: boolean;
  readonly humanize?: boolean;
  readonly proxy?: string;
  readonly locale?: string;
  readonly timezone?: string;
  readonly userAgent?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
};

export type BinaryHealth = {
  readonly version: string;
  readonly platform: string;
  readonly installed: boolean;
  readonly binaryPath: "[REDACTED]";
  readonly cacheDir: "[REDACTED]";
  readonly downloadUrl: "[REDACTED]";
};

export type CloakBrowserRuntime = {
  openPersistentCredentialContext(
    input: CredentialContextInput,
  ): Promise<RuntimeContext>;
  verifyBinary(): Promise<BinaryHealth>;
  close(): Promise<void>;
};

export type CloakBrowserRuntimeEnv = {
  readonly CLOAKBROWSER_CACHE_DIR: string;
  readonly CLOAKBROWSER_AUTO_UPDATE?: boolean;
  readonly TWITEE_PROFILE_ROOT: string;
  readonly TWITEE_HEADLESS: boolean;
  readonly TWITEE_HUMANIZE: boolean;
};

export type CrawlBrowserHost = {
  start(): Promise<void>;
  isConnected(): boolean;
  beginDraining(): void;
  newCredentialContext(input: {
    readonly storageState: RuntimeStorageState;
  }): Promise<RuntimeBrowserContext>;
  onDisconnected(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
};

export type CrawlBrowserHostDependencies = {
  readonly launchBrowser: () => Promise<RuntimeBrowser>;
};

const redacted = "[REDACTED]" as const;

export function createCrawlBrowserHost(
  env: CloakBrowserRuntimeEnv,
  dependencies: CrawlBrowserHostDependencies = {
    launchBrowser: () => launch() as Promise<RuntimeBrowser>,
  },
): CrawlBrowserHost {
  configureCloakBrowserEnvironment(env);

  const disconnectedListeners = new Set<(error: Error) => void>();
  let browserPromise: Promise<RuntimeBrowser> | undefined;
  let browser: RuntimeBrowser | undefined;
  let draining = false;
  let disconnected = false;
  let closed = false;

  async function start(): Promise<void> {
    if (closed) {
      throw new Error("crawl browser host is closed");
    }
    if (disconnected) {
      throw new Error("crawl browser host is disconnected");
    }

    browserPromise ??= dependencies.launchBrowser().then((launchedBrowser) => {
      const runtimeBrowser = launchedBrowser as RuntimeBrowser;
      browser = runtimeBrowser;
      runtimeBrowser.on("disconnected", () => {
        if (disconnected || closed) {
          return;
        }

        disconnected = true;
        const error = new Error("crawl browser disconnected");
        for (const listener of disconnectedListeners) {
          listener(error);
        }
      });
      return runtimeBrowser;
    });

    await browserPromise;
  }

  function isConnected(): boolean {
    return !closed && !disconnected && (browser?.isConnected() ?? false);
  }

  function beginDraining(): void {
    draining = true;
  }

  async function newCredentialContext(input: {
    readonly storageState: RuntimeStorageState;
  }): Promise<RuntimeBrowserContext> {
    if (draining) {
      throw new Error("crawl browser host is draining");
    }
    if (!browserPromise) {
      throw new Error("crawl browser host has not started");
    }

    const runtimeBrowser = await browserPromise;
    if (!isConnected()) {
      throw new Error("crawl browser host is not connected");
    }

    return runtimeBrowser.newContext({ storageState: input.storageState });
  }

  function onDisconnected(listener: (error: Error) => void): () => void {
    disconnectedListeners.add(listener);
    return () => disconnectedListeners.delete(listener);
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;

    if (browserPromise) {
      await (await browserPromise).close();
    }
  }

  return {
    start,
    isConnected,
    beginDraining,
    newCredentialContext,
    onDisconnected,
    close,
  };
}

export function createCloakBrowserRuntime(
  env: CloakBrowserRuntimeEnv,
): CloakBrowserRuntime {
  configureCloakBrowserEnvironment(env);

  const active = new Set<RuntimeContext>();
  const activeCredentialProfiles = new Set<string>();

  async function openPersistentCredentialContext(
    input: CredentialContextInput,
  ): Promise<RuntimeContext> {
    if (activeCredentialProfiles.has(input.credentialId)) {
      throw new Error(
        `credential profile is already active: ${input.credentialId}`,
      );
    }

    activeCredentialProfiles.add(input.credentialId);
    const userDataDir = createCredentialUserDataDir(
      env.TWITEE_PROFILE_ROOT,
      input,
    );

    try {
      await mkdir(userDataDir, { recursive: true });
      const context = (await launchPersistentContext({
        ...createLaunchOptions(env, input),
        userDataDir,
      } satisfies LaunchPersistentContextInput)) as RuntimeBrowserContext;
      const opened = await createRuntimeContext(context, active, {
        userDataDir,
        onRelease: () => activeCredentialProfiles.delete(input.credentialId),
      });
      active.add(opened);
      return opened;
    } catch (error) {
      activeCredentialProfiles.delete(input.credentialId);
      throw error;
    }
  }

  async function verifyBinary(): Promise<BinaryHealth> {
    await ensureBinary();
    return redactBinaryInfo(binaryInfo());
  }

  async function close(): Promise<void> {
    await closeAll([...active].map((context) => ({ close: context.release })));
  }

  return {
    openPersistentCredentialContext,
    verifyBinary,
    close,
  };
}

function createLaunchOptions(
  env: CloakBrowserRuntimeEnv,
  input: CredentialContextInput,
): LaunchOptions {
  return {
    headless: input.headless ?? env.TWITEE_HEADLESS,
    humanize: input.humanize ?? env.TWITEE_HUMANIZE,
    ...(input.proxy ? { proxy: input.proxy } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    ...(input.viewport ? { viewport: input.viewport } : {}),
  };
}

function createCredentialUserDataDir(
  profileRoot: string,
  input: CredentialContextInput,
): string {
  return join(
    profileRoot,
    `credential-${safePathSegment(input.credentialId)}`,
    `session-${safePathSegment(input.sessionId)}`,
    `attempt-${safePathSegment(input.attemptId)}`,
  );
}

async function createRuntimeContext(
  context: RuntimeBrowserContext,
  active: Set<RuntimeContext>,
  options: {
    readonly userDataDir?: string;
    readonly onRelease?: () => void;
  } = {},
): Promise<RuntimeContext> {
  const browser = context.browser();
  let page: RuntimePage;

  try {
    page = context.pages()[0] ?? (await context.newPage());
  } catch (error) {
    await closeAll([context, browser].filter(isCloseable));
    throw error;
  }

  let released = false;

  const runtimeContext: RuntimeContext = {
    context,
    page,
    ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
    async release() {
      if (released) {
        return;
      }
      released = true;

      try {
        await closeAll([page, context, browser].filter(isCloseable));
      } finally {
        try {
          if (options.userDataDir) {
            await rm(options.userDataDir, { recursive: true, force: true });
          }
        } finally {
          active.delete(runtimeContext);
          options.onRelease?.();
        }
      }
    },
  };

  return runtimeContext;
}

async function closeAll(resources: readonly { close(): Promise<void> }[]) {
  const failures: unknown[] = [];

  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to close browser resources");
  }
}

function isCloseable<T extends { close(): Promise<void> }>(
  resource: T | null,
): resource is T {
  return Boolean(resource);
}

function redactBinaryInfo(info: ReturnType<typeof binaryInfo>): BinaryHealth {
  return {
    version: info.version,
    platform: info.platform,
    installed: info.installed,
    binaryPath: redacted,
    cacheDir: redacted,
    downloadUrl: redacted,
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function configureCloakBrowserEnvironment(env: CloakBrowserRuntimeEnv): void {
  process.env.CLOAKBROWSER_CACHE_DIR = env.CLOAKBROWSER_CACHE_DIR;
  if (env.CLOAKBROWSER_AUTO_UPDATE !== undefined) {
    process.env.CLOAKBROWSER_AUTO_UPDATE = String(env.CLOAKBROWSER_AUTO_UPDATE);
  }
}

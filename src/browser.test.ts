import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCloakBrowserRuntime,
  createCrawlBrowserHost,
} from "./browser.js";

const cloakBrowser = vi.hoisted(() => ({
  binaryInfo: vi.fn(),
  ensureBinary: vi.fn(),
  launch: vi.fn(),
  launchPersistentContext: vi.fn(),
}));

vi.mock("cloakbrowser", () => cloakBrowser);

const env = {
  CLOAKBROWSER_CACHE_DIR: "/tmp/twitee-cloak-cache",
  TWITEE_PROFILE_ROOT: "/tmp/twitee-cloak-profiles",
  TWITEE_HEADLESS: true,
  TWITEE_HUMANIZE: true,
};

beforeEach(() => vi.clearAllMocks());

describe("browser host", () => {
  it("reuses one browser process for authenticated contexts", async () => {
    const browser = mockBrowser();
    const launchBrowser = vi.fn(async () => browser);
    const host = createCrawlBrowserHost(env, { launchBrowser });

    await host.start();
    await host.start();
    await host.newCredentialContext({
      storageState: { cookies: [], origins: [] },
    });
    await host.newCredentialContext({
      storageState: { cookies: [], origins: [] },
    });

    expect(launchBrowser).toHaveBeenCalledOnce();
    expect(browser.newContext).toHaveBeenCalledTimes(2);
  });

  it("rejects new contexts after draining begins", async () => {
    const host = createCrawlBrowserHost(env, {
      launchBrowser: vi.fn(async () => mockBrowser()),
    });
    await host.start();

    host.beginDraining();

    await expect(
      host.newCredentialContext({
        storageState: { cookies: [], origins: [] },
      }),
    ).rejects.toThrow("draining");
  });
});

describe("persistent login browser", () => {
  it("prevents two contexts from using the same credential profile", async () => {
    const context = mockContext();
    cloakBrowser.launchPersistentContext.mockResolvedValue(context);
    const runtime = createCloakBrowserRuntime(env);
    const input = {
      purpose: "credential_login" as const,
      credentialId: "single-account",
      sessionId: "login-1",
      attemptId: "login",
    };

    const opened = await runtime.openPersistentCredentialContext(input);

    await expect(
      runtime.openPersistentCredentialContext(input),
    ).rejects.toThrow("already active");
    await opened.release();
  });

  it("removes the plaintext browser profile after login closes", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "twitee-profile-test-"));
    cloakBrowser.launchPersistentContext.mockResolvedValue(mockContext());
    const runtime = createCloakBrowserRuntime({
      ...env,
      TWITEE_PROFILE_ROOT: profileRoot,
    });
    const opened = await runtime.openPersistentCredentialContext({
      purpose: "credential_login",
      credentialId: "single-account",
      sessionId: "login-1",
      attemptId: "login",
    });
    const cookieFile = join(opened.userDataDir ?? "", "Cookies");
    await writeFile(cookieFile, "plaintext-cookie-fixture");

    await opened.release();

    await expect(writeFile(cookieFile, "still present", { flag: "r+" })).rejects.toThrow();
    await rm(profileRoot, { recursive: true, force: true });
  });
});

function mockBrowser() {
  return {
    newContext: vi.fn(async () => mockContext()),
    isConnected: vi.fn(() => true),
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function mockContext() {
  const page = { close: vi.fn(async () => undefined) };
  return {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    browser: vi.fn(() => null),
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

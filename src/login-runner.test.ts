import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "./credential-store.js";
import { createLoginService } from "./login-runner.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("login service", () => {
  it("persists storage state only after X home and required cookies", async () => {
    const fixture = await createFixture({
      url: "https://x.com/home",
      cookies: [
        { name: "auth_token", value: "auth" },
        { name: "ct0", value: "csrf" },
      ],
    });

    const started = fixture.service.start();
    await vi.waitFor(() => expect(fixture.service.get().status).toBe("ready"));

    expect(fixture.service.authorizeCapability(started.capability)).toBe(false);
    expect(await fixture.store.read()).toContain('"auth_token"');
  });

  it("does not persist a login missing required cookies", async () => {
    const fixture = await createFixture({
      url: "https://x.com/home",
      cookies: [{ name: "auth_token", value: "auth" }],
    });

    fixture.service.start();
    await vi.waitFor(() => expect(fixture.service.get().status).toBe("error"));

    await expect(fixture.store.read()).resolves.toBeNull();
    expect(fixture.service.get().error).toBe("X login did not return a usable session.");
  });

  it("loads an existing encrypted credential on startup", async () => {
    const fixture = await createFixture({ url: "https://x.com/login", cookies: [] });
    await fixture.store.write(
      JSON.stringify({
        cookies: [
          { name: "auth_token", value: "auth" },
          { name: "ct0", value: "csrf" },
        ],
        origins: [],
      }),
    );

    await fixture.service.initialize();

    expect(fixture.service.get().status).toBe("ready");
    await expect(fixture.service.storageState()).resolves.toMatchObject({
      cookies: expect.any(Array),
    });
  });

  it("removes the credential after an in-flight login stops", async () => {
    const sleep = Promise.withResolvers<void>();
    const fixture = await createFixture({
      url: "https://x.com/login",
      cookies: [],
      sleep: () => sleep.promise,
    });
    fixture.service.start();

    const removal = fixture.service.remove();
    sleep.resolve();
    await removal;

    expect(fixture.service.get().status).toBe("missing");
    await expect(fixture.store.read()).resolves.toBeNull();
  });
});

async function createFixture(input: {
  url: string;
  cookies: Array<{ name: string; value: string }>;
  sleep?: (ms: number) => Promise<void>;
}) {
  const directory = await mkdtemp(join(tmpdir(), "twitee-login-"));
  directories.push(directory);
  const store = createCredentialStore({
    path: join(directory, "credential.json.enc"),
    encryptionKey: "k".repeat(32),
  });
  const page = {
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => input.url),
    close: vi.fn(async () => undefined),
  };
  const context = {
    storageState: vi.fn(async () => ({ cookies: input.cookies, origins: [] })),
  };
  const release = vi.fn(async () => undefined);
  const browserRuntime = {
    openPersistentCredentialContext: vi.fn(async () => ({
      context,
      page,
      release,
    })),
    verifyBinary: vi.fn(),
    close: vi.fn(),
  };
  const service = createLoginService({
    browserRuntime: browserRuntime as never,
    credentialStore: store,
    sleep: input.sleep ?? (async () => undefined),
    pollMs: 0,
  });
  return { service, store, release };
}

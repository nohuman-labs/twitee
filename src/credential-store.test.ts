import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "./credential-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function testPath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "twitee-credential-"));
  directories.push(directory);
  return { directory, path: join(directory, "credential.json.enc") };
}

describe("credential store", () => {
  it("round-trips storage state without plaintext on disk", async () => {
    const { path } = await testPath();
    const store = createCredentialStore({
      path,
      encryptionKey: "k".repeat(32),
    });
    const state = JSON.stringify({
      cookies: [{ name: "auth_token", value: "plain-secret" }],
    });

    await store.write(state);

    expect(await readFile(path, "utf8")).not.toContain("plain-secret");
    expect(await store.read()).toBe(state);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("returns null when no credential exists", async () => {
    const { path } = await testPath();
    const store = createCredentialStore({
      path,
      encryptionKey: "k".repeat(32),
    });

    await expect(store.read()).resolves.toBeNull();
  });

  it("rejects a credential encrypted with another key", async () => {
    const { path } = await testPath();
    await createCredentialStore({
      path,
      encryptionKey: "a".repeat(32),
    }).write("secret-state");

    await expect(
      createCredentialStore({
        path,
        encryptionKey: "b".repeat(32),
      }).read(),
    ).rejects.toThrow("decrypt");
  });

  it("keeps the previous credential when a replacement write fails", async () => {
    const { directory, path } = await testPath();
    const store = createCredentialStore({
      path,
      encryptionKey: "k".repeat(32),
    });
    await store.write("old-state");
    await chmod(directory, 0o500);

    await expect(store.write("new-state")).rejects.toThrow();

    await chmod(directory, 0o700);
    await expect(store.read()).resolves.toBe("old-state");
  });

  it("removes an existing credential and ignores a missing one", async () => {
    const { path } = await testPath();
    const store = createCredentialStore({
      path,
      encryptionKey: "k".repeat(32),
    });
    await store.write("state");

    await store.remove();
    await store.remove();

    await expect(store.read()).resolves.toBeNull();
  });
});

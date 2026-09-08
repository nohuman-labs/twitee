import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoginService } from "./login-runner.js";
import { createNoVncProxy } from "./novnc-proxy.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

describe("noVNC login proxy", () => {
  it("requires a valid login capability and carries it in an HttpOnly cookie", async () => {
    const root = await mkdtemp(join(tmpdir(), "twitee-novnc-"));
    await writeFile(join(root, "vnc.html"), "login screen");
    const loginService = {
      authorizeCapability: vi.fn((value: string) => value === "valid-capability"),
    } as unknown as LoginService;
    const server = createNoVncProxy({ loginService, assetRoot: root, targetPort: 1 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      },
      () => rm(root, { recursive: true, force: true }),
    );
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/vnc.html`)).status).toBe(401);
    expect((await fetch(`${base}/vnc.html?capability=wrong`)).status).toBe(401);

    const authorized = await fetch(`${base}/vnc.html?capability=valid-capability`);
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toBe("login screen");
    const cookie = authorized.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");

    const reconnect = await fetch(`${base}/vnc.html`, {
      headers: { cookie: cookie?.split(";")[0] ?? "" },
    });
    expect(reconnect.status).toBe(200);
    expect((await fetch(`${base}/%zz?capability=valid-capability`)).status).toBe(404);
    expect((await fetch(`${base}/vnc.html`, { headers: { cookie: "twitee_login_cap=%zz" } })).status).toBe(401);
  });
});

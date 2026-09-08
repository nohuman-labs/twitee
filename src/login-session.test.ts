import { describe, expect, it } from "vitest";
import {
  createLoginSession,
  isLoginCapabilityAuthorized,
} from "./login-session.js";

describe("login capability", () => {
  it("has at least 128 bits of entropy and authorizes only while pending", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    const session = createLoginSession(now, 600_000);

    expect(session.capability).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(isLoginCapabilityAuthorized(session, session.capability, now)).toBe(
      true,
    );
    expect(isLoginCapabilityAuthorized(session, "wrong", now)).toBe(false);
    expect(
      isLoginCapabilityAuthorized(
        session,
        session.capability,
        new Date("2026-09-08T00:10:00.001Z"),
      ),
    ).toBe(false);
    session.status = "ready";
    expect(isLoginCapabilityAuthorized(session, session.capability, now)).toBe(
      false,
    );
  });
});

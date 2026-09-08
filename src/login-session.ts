import { randomBytes, timingSafeEqual } from "node:crypto";

export type LoginStatus = "login_pending" | "ready" | "error";

export type LoginSession = {
  readonly capability: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  status: LoginStatus;
};

export function createLoginSession(
  now = new Date(),
  ttlMs = 10 * 60 * 1000,
): LoginSession {
  return {
    capability: randomBytes(16).toString("base64url"),
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    status: "login_pending",
  };
}

export function isLoginCapabilityAuthorized(
  session: LoginSession,
  candidate: string,
  now = new Date(),
): boolean {
  if (
    session.status !== "login_pending" ||
    now.getTime() > Date.parse(session.expiresAt)
  ) {
    return false;
  }
  const expected = Buffer.from(session.capability);
  const received = Buffer.from(candidate);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

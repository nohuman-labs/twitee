const secretKeys = new Set([
  "storage_state",
  "storageState",
  "auth_token",
  "authToken",
  "ct0",
  "cookies",
  "cookie",
  "Authorization",
  "authorization",
  "Set-Cookie",
  "set-cookie",
  "apiKey",
  "api_key",
  "loginCapability",
  "login_capability",
]);

export function sanitizePayload<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSecretKey(key))
        .map(([key, item]) => [key, sanitizePayload(item)]),
    ) as T;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return [...secretKeys].some(
    (candidate) =>
      candidate.toLowerCase().replace(/[-_\s]/g, "") === normalized,
  );
}

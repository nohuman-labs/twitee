import { describe, expect, it } from "vitest";
import { createEnv } from "./env.js";

describe("environment", () => {
  it("requires both 32-character keys", () => {
    expect(() => createEnv({})).toThrow("TWITEE_API_KEY");
    expect(() =>
      createEnv({
        TWITEE_API_KEY: "a".repeat(32),
        TWITEE_ENCRYPTION_KEY: "short",
      }),
    ).toThrow("TWITEE_ENCRYPTION_KEY");
  });

  it("uses standalone defaults", () => {
    expect(
      createEnv({
        TWITEE_API_KEY: "a".repeat(32),
        TWITEE_ENCRYPTION_KEY: "e".repeat(32),
      }),
    ).toMatchObject({
      PORT: 8080,
      NOVNC_PORT: 6080,
      TWITEE_NOVNC_URL: "http://127.0.0.1:6080",
      TWITEE_DATA_DIR: "/data",
      TWITEE_HEADLESS: true,
      TWITEE_HUMANIZE: true,
    });
  });
});

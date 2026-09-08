import { expect, it } from "vitest";
import { sanitizePayload } from "./sanitize.js";

it("removes nested credential and authorization values", () => {
  expect(
    sanitizePayload({
      authorization: "Bearer secret",
      nested: { auth_token: "cookie", safe: "visible" },
      list: [{ ct0: "csrf", count: 2 }],
    }),
  ).toEqual({ nested: { safe: "visible" }, list: [{ count: 2 }] });
});

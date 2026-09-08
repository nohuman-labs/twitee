import { describe, expect, it } from "vitest";
import {
  normalizeHandle,
  parseCursor,
  parsePostId,
  parseQuery,
} from "./contracts.js";

describe("public input contracts", () => {
  it("normalizes an X handle", () => {
    expect(normalizeHandle(" @OpenAI ")).toBe("openai");
  });

  it("rejects an invalid handle", () => {
    expect(() => normalizeHandle("a-b")).toThrow("handle");
  });

  it("accepts decimal post ids", () => {
    expect(parsePostId("123456")).toBe("123456");
  });

  it("rejects an empty query", () => {
    expect(() => parseQuery("  ")).toThrow("query");
  });

  it("preserves an opaque cursor", () => {
    expect(parseCursor("AA%2Fbb==")).toBe("AA%2Fbb==");
  });
});

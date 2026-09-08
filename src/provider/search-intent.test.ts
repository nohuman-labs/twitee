import { expect, it } from "vitest";
import { xSearchUrl } from "./search-intent.js";

it("builds people search URLs with the X people filter", () => {
  expect(xSearchUrl("argentina", "people")).toBe(
    "https://x.com/search?q=argentina&src=typed_query&f=user",
  );
});

it("builds latest search URLs from the X top results source", () => {
  expect(xSearchUrl("argentina", "latest")).toBe(
    "https://x.com/search?q=argentina&vertical=trends",
  );
});

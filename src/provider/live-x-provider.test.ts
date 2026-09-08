import { describe, expect, it, vi } from "vitest";
import {
  gotoPageForTest,
  mapProfileForTest,
  postDetailUnavailableForTest,
  shouldCapturePostDetailGraphqlUrlForTest,
  shouldCaptureProfileTimelineGraphqlUrlForTest,
  shouldCaptureSearchGraphqlUrlForTest,
} from "./live-x-provider.js";

describe("live X provider boundaries", () => {
  it("retries a navigation aborted by an X redirect", async () => {
    const page = {
      goto: vi
        .fn()
        .mockRejectedValueOnce(new Error("net::ERR_ABORTED; maybe frame was detached?"))
        .mockResolvedValueOnce(undefined),
    };

    await gotoPageForTest(page as never, "https://x.com/openai", 30_000);

    expect(page.goto).toHaveBeenCalledTimes(2);
  });

  it("does not treat a protected false field as a protected post", () => {
    expect(
      postDetailUnavailableForTest({ legacy: { protected: false } }),
    ).toBeNull();
    expect(
      postDetailUnavailableForTest("These posts are protected"),
    ).toEqual({ type: "protected" });
  });

  it("captures only X search GraphQL operations", () => {
    expect(
      shouldCaptureSearchGraphqlUrlForTest(
        "https://x.com/i/api/graphql/id/SearchTimeline?variables=x",
      ),
    ).toBe(true);
    expect(
      shouldCaptureSearchGraphqlUrlForTest(
        "https://example.com/i/api/graphql/id/SearchTimeline",
      ),
    ).toBe(false);
  });

  it("recognizes profile timeline and post detail operations", () => {
    expect(
      shouldCaptureProfileTimelineGraphqlUrlForTest(
        "https://x.com/i/api/graphql/id/UserTweets?variables=x",
      ),
    ).toBe(true);
    expect(
      shouldCapturePostDetailGraphqlUrlForTest(
        "https://x.com/i/api/graphql/id/TweetDetail?variables=x",
      ),
    ).toBe(true);
  });

  it("maps complete profile evidence to the public contract", () => {
    expect(
      mapProfileForTest("openai", {
        username: "openai",
        sourceProfileId: "1",
        displayName: "OpenAI",
        bio: "AI research and deployment company",
        followerCount: 10,
        followingCount: 2,
        postsCount: 3,
        listedCount: 1,
        location: null,
        joinedAt: null,
        avatarUrl: "https://pbs.twimg.com/avatar.jpg",
        coverUrl: null,
        websiteUrl: "https://openai.com",
        isVerified: true,
        sensitiveLabel: null,
      }),
    ).toMatchObject({
      handle: "openai",
      displayName: "OpenAI",
      availabilityStatus: "available",
      stats: { followersCount: 10, followingCount: 2, postsCount: 3 },
    });
  });
});

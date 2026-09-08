import { describe, expect, it } from "vitest";
import {
  extractXProfileEvidence,
  parseProfileFromGraphQLForTests,
  startXProfileGraphqlCapture,
} from "./profile-extraction.js";

describe("X profile GraphQL extraction", () => {
  it("returns complete GraphQL evidence without waiting for DOM fallback", async () => {
    let domWaits = 0;
    let attributeReads = 0;
    const page = {
      waitForLoadState: async () => {
        domWaits += 1;
      },
      waitForTimeout: async () => {
        domWaits += 1;
      },
      title: async () => "",
      url: () => "https://x.com/joinember",
      locator: (selector: string) => ({
        innerText: async () => (selector === "body" ? "" : null),
        first: () => ({
          getAttribute: async () => {
            attributeReads += 1;
            return null;
          },
        }),
      }),
    };
    const graphProfile = {
      displayName: "Ember",
      avatarUrl: "https://pbs.twimg.com/profile_images/ember.jpg",
      coverUrl: "https://pbs.twimg.com/profile_banners/ember.jpg",
      bio: "A gaming platform.",
      followerCount: 76_056,
      followingCount: 934,
      postsCount: 1_639,
    };

    const evidence = await extractXProfileEvidence({
      page: page as never,
      handle: "joinember",
      graphCaptureTimeoutMs: 10_000,
      domStabilizationMs: 1_500,
      evidenceTimeoutMs: 6_000,
      graphProfilePromise: Promise.resolve(graphProfile),
    });

    expect(evidence.graphProfile).toEqual(graphProfile);
    expect(domWaits).toBe(0);
    expect(attributeReads).toBe(0);
  });

  it("stops rendered media fallback when GraphQL becomes complete", async () => {
    let resolveGraphProfile: (profile: {
      displayName: string;
      avatarUrl: string;
      coverUrl: string;
      followerCount: number;
      followingCount: number;
      postsCount: number;
    }) => void = () => undefined;
    const graphProfilePromise = new Promise<{
      displayName: string;
      avatarUrl: string;
      coverUrl: string;
      followerCount: number;
      followingCount: number;
      postsCount: number;
    }>((resolve) => {
      resolveGraphProfile = resolve;
    });
    const graphProfile = {
      displayName: "Ember",
      avatarUrl: "https://pbs.twimg.com/profile_images/ember.jpg",
      coverUrl: "https://pbs.twimg.com/profile_banners/ember.jpg",
      followerCount: 76_056,
      followingCount: 934,
      postsCount: 1_639,
    };
    let attributeReads = 0;
    const page = {
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      title: async () => "",
      url: () => "https://x.com/joinember",
      locator: (selector: string) => ({
        innerText: async () => (selector === "body" ? "" : null),
        first: () => ({
          getAttribute: async () => {
            attributeReads += 1;
            if (attributeReads === 1) resolveGraphProfile(graphProfile);
            return null;
          },
        }),
      }),
    };

    const evidence = await extractXProfileEvidence({
      page: page as never,
      handle: "joinember",
      graphCaptureTimeoutMs: 10_000,
      domStabilizationMs: 1_500,
      evidenceTimeoutMs: 6_000,
      graphProfilePromise,
    });

    expect(evidence.graphProfile).toEqual(graphProfile);
    expect(attributeReads).toBe(1);
  });

  it("reports profile response status, headers, data, and response latency", async () => {
    const responseHandlers: Array<(response: unknown) => void | Promise<void>> =
      [];
    const page = {
      on: (_event: string, handler: (response: unknown) => void) => {
        responseHandlers.push(handler);
      },
      off: () => undefined,
    };
    const diagnostics: unknown[] = [];
    const capture = startXProfileGraphqlCapture(
      page as never,
      "joinember",
      100,
      (diagnostic) => diagnostics.push(diagnostic),
    );

    const response = {
      url: () => "https://x.com/i/api/graphql/abc/UserByScreenName",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      json: async () => ({
        data: {
          user: {
            result: {
              legacy: {
                name: "Ember",
                screen_name: "joinember",
                description: "A gaming platform.",
                followers_count: 76056,
                friends_count: 934,
                statuses_count: 1639,
              },
            },
          },
        },
      }),
      request: () => ({
        timing: () => ({ startTime: 100, responseStart: 135 }),
      }),
    };

    await responseHandlers[0]?.(response);
    await capture;

    expect(diagnostics).toEqual([
      expect.objectContaining({
        status: 200,
        responseHeaders: { "content-type": "application/json" },
        responseData: expect.objectContaining({ data: expect.any(Object) }),
        responseLatencyMs: 35,
        parseResult: "accepted",
        accepted: true,
      }),
    ]);
  });

  it("extracts current UserByScreenName profile fields", () => {
    const parsed = parseProfileFromGraphQLForTests(
      {
        data: {
          user: {
            result: {
              rest_id: "1168277200103071744",
              is_blue_verified: true,
              core: {
                created_at: "Sun Sep 01 21:39:33 +0000 2019",
                name: "Ember",
                screen_name: "joinember",
              },
              location: { location: "Los Angeles, CA" },
              verification: { verified: false },
              privacy: { protected: false },
              avatar: {
                image_url:
                  "https://pbs.twimg.com/profile_images/1489291456032358401/LinINZ_D_normal.jpg",
              },
              legacy: {
                description: "A gaming platform.",
                entities: {
                  url: {
                    urls: [
                      {
                        expanded_url:
                          "https://emberfund.onelink.me/ljTI/twitterpro",
                        display_url: "emberfund.onelink.me/ljTI/twitterpro",
                        url: "https://t.co/NsecZhWWZZ",
                      },
                    ],
                  },
                },
                followers_count: 76056,
                friends_count: 934,
                listed_count: 52,
                possibly_sensitive: false,
                profile_banner_url:
                  "https://pbs.twimg.com/profile_banners/1168277200103071744/1767727399",
                profile_interstitial_type: "",
                statuses_count: 1639,
                url: "https://t.co/NsecZhWWZZ",
              },
            },
          },
        },
      },
      "joinember",
    );

    expect(parsed).toMatchObject({
      sourceProfileId: "1168277200103071744",
      displayName: "Ember",
      avatarUrl:
        "https://pbs.twimg.com/profile_images/1489291456032358401/LinINZ_D.jpg",
      coverUrl:
        "https://pbs.twimg.com/profile_banners/1168277200103071744/1767727399",
      bio: "A gaming platform.",
      followerCount: 76056,
      followingCount: 934,
      postsCount: 1639,
      listedCount: 52,
      location: "Los Angeles, CA",
      websiteUrl: "https://emberfund.onelink.me/ljTI/twitterpro",
      isVerified: true,
      sensitiveLabel: null,
    });
    expect(parsed?.joinedAt).toBe("2019-09-01T21:39:33.000Z");
  });

  it("extracts the schema without a legacy profile node", () => {
    const parsed = parseProfileFromGraphQLForTests(
      {
        data: {
          user: {
            result: {
              rest_id: "763094579491008512",
              core: {
                created_at: "Tue Aug 09 19:28:20 +0000 2016",
                name: "Eric Daugherty",
                screen_name: "EricLDaugh",
              },
              profile_bio: {
                description: "Chief Content Officer @RightLineNews",
              },
              relationship_counts: { followers: 1_156_693, following: 2_657 },
              tweet_counts: { tweets: 92_634 },
              location: { location: "Maryland" },
              avatar: {
                image_url:
                  "https://pbs.twimg.com/profile_images/eric_normal.jpg",
              },
              banner: {
                image_url: "https://pbs.twimg.com/profile_banners/eric.jpg",
              },
              website: { url: "https://example.com" },
              is_blue_verified: true,
              privacy: { protected: false },
            },
          },
        },
      },
      "ericldaugh",
    );

    expect(parsed).toMatchObject({
      sourceProfileId: "763094579491008512",
      displayName: "Eric Daugherty",
      bio: "Chief Content Officer @RightLineNews",
      followerCount: 1_156_693,
      followingCount: 2_657,
      postsCount: 92_634,
      location: "Maryland",
      websiteUrl: "https://example.com",
      isVerified: true,
    });
    expect(parsed?.joinedAt).toBe("2016-08-09T19:28:20.000Z");
  });

  it("normalizes empty public X profile fields to null", () => {
    const parsed = parseProfileFromGraphQLForTests(
      {
        data: {
          user: {
            result: {
              rest_id: "1657042698543546368",
              core: { name: "Em Be Dao", screen_name: "Peachy1006" },
              legacy: {
                description: "https://t.co/yTL9VL0eJA",
                entities: {},
                followers_count: 152267,
                friends_count: 1,
                profile_banner_url: "",
                statuses_count: 25,
                url: "",
              },
            },
          },
        },
      },
      "peachy1006",
    );

    expect(parsed).toMatchObject({
      coverUrl: null,
      location: null,
      websiteUrl: null,
      sourceProfileId: "1657042698543546368",
    });
  });
});

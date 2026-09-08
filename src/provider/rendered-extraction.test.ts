import { describe, expect, it } from "vitest";
import {
  type RenderedSearchSnapshot,
  collectRenderedSearchSnapshot,
  extractLatestFromSnapshot,
  extractPeopleFromSnapshot,
  mergeLatestResults,
  mergePeopleResults,
} from "./rendered-extraction.js";

const snapshot: RenderedSearchSnapshot = {
  links: [
    {
      href: "https://x.com/maggi_13",
      text: "Just Smile :) @maggi_13 Public X profile",
      imageSrc: "https://pbs.twimg.com/profile_images/maggi.jpg",
    },
    { href: "https://x.com/search?q=maggi_13", text: "Search", imageSrc: null },
    {
      href: "https://x.com/maggi_13/status/123",
      text: "post link",
      imageSrc: null,
    },
    {
      href: "https://x.com/alt_user",
      text: "Alt User @alt_user",
      imageSrc: null,
    },
  ],
  articles: [
    {
      text: "A creator @a Latest post mentioning maggi_13 12 likes 1.2K views",
      links: ["https://x.com/a/status/123"],
      imageSrcs: ["https://pbs.twimg.com/media/post.jpg"],
    },
    {
      text: "B creator @b Another post",
      links: ["https://x.com/b/status/456"],
      imageSrcs: [],
    },
  ],
  mainText: "Search timeline visible text",
  bodyText: "Document body visible text",
};

const noisySnapshot: RenderedSearchSnapshot = {
  links: [
    {
      href: "https://x.com/logged_in_user",
      text: "Logged In @logged_in_user",
      imageSrc: "https://pbs.twimg.com/profile_images/self.jpg",
    },
    { href: "https://x.com/i/flow/login", text: "Log in", imageSrc: null },
    {
      href: "https://x.com/who_to_follow",
      text: "Who to follow",
      imageSrc: null,
    },
  ],
  peopleRows: [
    {
      text: "Just Smile :) @maggi_13 Public X profile",
      links: [
        {
          href: "https://x.com/maggi_13",
          text: "Just Smile :) @maggi_13 Public X profile",
          imageSrc: "https://pbs.twimg.com/profile_images/maggi.jpg",
        },
      ],
    },
  ],
  articles: [
    {
      text: "A creator @a Latest post mentioning maggi_13 12 likes 1.2K views",
      links: ["https://x.com/a/status/123"],
      imageSrcs: [
        "https://pbs.twimg.com/profile_images/avatar.jpg",
        "https://pbs.twimg.com/media/post.jpg",
      ],
    },
  ],
  mainText: "Noisy search timeline",
  bodyText: "Noisy page",
};

describe("rendered X extraction", () => {
  it("collects profile links inside the isolated browser context", async () => {
    const anchors = [
      "https://x.com/maggi_13",
      "https://x.com/@alt_user",
      "https://x.com/search",
      "https://x.com/maggi_13/status/123",
      "https://example.com/not_an_x_profile",
    ].map((href) => ({
      href,
      textContent: href,
      querySelector: () => null,
    }));
    const article = {
      textContent: "Just Smile :) @maggi_13",
      querySelector: () => null,
      querySelectorAll: (selector: string) => (selector === "a" ? anchors : []),
    };
    const documentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        body: { textContent: "Rendered body" },
        querySelector: () => ({ textContent: "Rendered main" }),
        querySelectorAll: (selector: string) =>
          selector === "main article" ? [article] : [],
      },
    });

    try {
      const page = {
        evaluate: async (callback: () => unknown) =>
          Function(`return (${callback.toString()})`)()(),
      } as Parameters<typeof collectRenderedSearchSnapshot>[0];

      await expect(collectRenderedSearchSnapshot(page)).resolves.toMatchObject({
        articles: [
          {
            profileLinks: [
              expect.objectContaining({ href: "https://x.com/maggi_13" }),
              expect.objectContaining({ href: "https://x.com/@alt_user" }),
            ],
          },
        ],
      });
    } finally {
      if (documentDescriptor) {
        Object.defineProperty(globalThis, "document", documentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });

  it("extracts people from rendered profile links while ignoring search and status links", () => {
    expect(extractPeopleFromSnapshot(snapshot, 5).items).toEqual([
      expect.objectContaining({
        handle: "maggi_13",
        displayName: "Just Smile :)",
        avatarUrl: "https://pbs.twimg.com/profile_images/maggi.jpg",
        sourceUrl: "https://x.com/maggi_13",
      }),
      expect.objectContaining({
        handle: "alt_user",
        sourceUrl: "https://x.com/alt_user",
      }),
    ]);
  });

  it("extracts latest posts from rendered status links", () => {
    expect(extractLatestFromSnapshot(snapshot, 20).items).toEqual([
      expect.objectContaining({
        externalId: "123",
        sourceUrl: "https://x.com/a/status/123",
        authorHandle: "a",
        text: expect.stringContaining("Latest post mentioning maggi_13"),
      }),
      expect.objectContaining({
        externalId: "456",
        sourceUrl: "https://x.com/b/status/456",
        authorHandle: "b",
      }),
    ]);
  });

  it("separates repost context from the original author in the rendered fallback", () => {
    const repostArticle = {
      text: "Elon Musk repostedTyler Bruno@tylerbruno05Original post text",
      links: ["https://x.com/tylerbruno05/status/789"],
      imageSrcs: [
        "https://pbs.twimg.com/profile_images/elon.jpg",
        "https://pbs.twimg.com/profile_images/tyler.jpg",
      ],
      profileLinks: [
        {
          href: "https://x.com/tylerbruno05",
          text: "Tyler Bruno @tylerbruno05",
          imageSrc: "https://pbs.twimg.com/profile_images/tyler.jpg",
        },
      ],
      repostContext: {
        text: "Elon Musk reposted",
        profileLinks: [
          {
            href: "https://x.com/elonmusk",
            text: "Elon Musk @elonmusk",
            imageSrc: "https://pbs.twimg.com/profile_images/elon.jpg",
          },
        ],
      },
    };
    const result = extractLatestFromSnapshot(
      Object.assign({}, snapshot, { articles: [repostArticle] }),
      20,
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        authorHandle: "tylerbruno05",
        authorDisplayName: "Tyler Bruno",
        authorAvatarUrl: "https://pbs.twimg.com/profile_images/tyler.jpg",
        isRepost: true,
        repostedByHandle: "elonmusk",
        repostedByDisplayName: "Elon Musk",
        repostedByAvatarUrl: "https://pbs.twimg.com/profile_images/elon.jpg",
      }),
    ]);
  });

  it("prefers the richest identity link when X renders duplicate profile anchors", () => {
    const result = extractLatestFromSnapshot(
      Object.assign({}, snapshot, {
        articles: [
          {
            text: "Elon Musk repostedTyler Bruno@tylerbruno05Original post text",
            links: ["https://x.com/tylerbruno05/status/791"],
            imageSrcs: [
              "https://pbs.twimg.com/profile_images/elon.jpg",
              "https://pbs.twimg.com/profile_images/tyler.jpg",
            ],
            profileLinks: [
              {
                href: "https://x.com/tylerbruno05",
                text: "",
                imageSrc: "https://pbs.twimg.com/profile_images/tyler.jpg",
              },
              {
                href: "https://x.com/tylerbruno05",
                text: "Tyler Bruno @tylerbruno05",
                imageSrc: null,
              },
            ],
            repostContext: {
              text: "Elon Musk reposted",
              profileLinks: [
                {
                  href: "https://x.com/elonmusk",
                  text: "",
                  imageSrc: "https://pbs.twimg.com/profile_images/elon.jpg",
                },
                {
                  href: "https://x.com/elonmusk",
                  text: "Elon Musk @elonmusk",
                  imageSrc: null,
                },
              ],
            },
          },
        ],
      }),
      20,
    );

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        authorDisplayName: "Tyler Bruno",
        repostedByDisplayName: "Elon Musk",
      }),
    );
  });

  it("preserves self-repost context instead of dropping it", () => {
    const result = extractLatestFromSnapshot(
      Object.assign({}, snapshot, {
        articles: [
          {
            text: "Elon Musk repostedElon Musk@elonmuskOriginal post text",
            links: ["https://x.com/elonmusk/status/792"],
            imageSrcs: ["https://pbs.twimg.com/profile_images/elon.jpg"],
            profileLinks: [
              {
                href: "https://x.com/elonmusk",
                text: "Elon Musk @elonmusk",
                imageSrc: "https://pbs.twimg.com/profile_images/elon.jpg",
              },
            ],
            repostContext: {
              text: "Elon Musk reposted",
              profileLinks: [
                {
                  href: "https://x.com/elonmusk",
                  text: "Elon Musk @elonmusk",
                  imageSrc: "https://pbs.twimg.com/profile_images/elon.jpg",
                },
              ],
            },
          },
        ],
      }),
      20,
    );

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        authorHandle: "elonmusk",
        isRepost: true,
        repostedByHandle: "elonmusk",
      }),
    );
  });

  it("does not infer reposts from an ordinary display name containing reposted", () => {
    const ordinaryArticle = {
      text: "Reposted Studio@repostedstudioOriginal post text",
      links: ["https://x.com/repostedstudio/status/790"],
      imageSrcs: ["https://pbs.twimg.com/profile_images/studio.jpg"],
      profileLinks: [
        {
          href: "https://x.com/repostedstudio",
          text: "Reposted Studio @repostedstudio",
          imageSrc: "https://pbs.twimg.com/profile_images/studio.jpg",
        },
      ],
    };
    const result = extractLatestFromSnapshot(
      Object.assign({}, snapshot, { articles: [ordinaryArticle] }),
      20,
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        authorHandle: "repostedstudio",
        authorDisplayName: "Reposted Studio",
        isRepost: false,
        repostedByHandle: null,
        repostedByDisplayName: null,
        repostedByAvatarUrl: null,
      }),
    ]);
  });

  it("prefers people result rows over noisy nav and sidebar profile links", () => {
    expect(extractPeopleFromSnapshot(noisySnapshot, 5).items).toEqual([
      expect.objectContaining({
        handle: "maggi_13",
        displayName: "Just Smile :)",
        avatarUrl: "https://pbs.twimg.com/profile_images/maggi.jpg",
        sourceUrl: "https://x.com/maggi_13",
      }),
    ]);
  });

  it("ignores non-result one-segment X route links in legacy link snapshots", () => {
    const routeOnlySnapshot: RenderedSearchSnapshot = {
      links: [
        {
          href: "https://x.com/who_to_follow",
          text: "Who to follow",
          imageSrc: null,
        },
        { href: "https://x.com/explore", text: "Explore", imageSrc: null },
      ],
      articles: [],
      mainText: "Who to follow Explore",
      bodyText: "Who to follow Explore",
    };

    expect(extractPeopleFromSnapshot(routeOnlySnapshot, 5).items).toEqual([]);
  });

  it("filters article avatars out of latest post media", () => {
    expect(extractLatestFromSnapshot(noisySnapshot, 20).items).toEqual([
      expect.objectContaining({
        authorAvatarUrl: "https://pbs.twimg.com/profile_images/avatar.jpg",
        media: [
          expect.objectContaining({
            mediaUrl: "https://pbs.twimg.com/media/post.jpg",
          }),
        ],
      }),
    ]);
  });

  it("keeps rendered X link preview card images as post media", () => {
    const result = extractLatestFromSnapshot(
      {
        links: [],
        articles: [
          {
            text: "MINING.COM@mining·1hBHP Invent, MIT spinout trial copper and gold recovery technology from waste streamsFrom mining.com0K0K3K865",
            links: ["https://x.com/mining/status/1234567890"],
            imageSrcs: [
              "https://pbs.twimg.com/profile_images/mining.jpg",
              "https://pbs.twimg.com/card_img/1939426190141362176/wKgbCL4L?format=jpg&name=small",
            ],
          },
        ],
        mainText: "",
        bodyText: "",
      },
      20,
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        externalId: "1234567890",
        authorHandle: "mining",
        text: "BHP Invent, MIT spinout trial copper and gold recovery technology from waste streams",
        media: [
          expect.objectContaining({
            mediaUrl:
              "https://pbs.twimg.com/card_img/1939426190141362176/wKgbCL4L?format=jpg&name=small",
          }),
        ],
      }),
    ]);
  });

  it("keeps From-prefixed words in rendered post text", () => {
    const result = extractLatestFromSnapshot(
      {
        links: [],
        articles: [
          {
            text: "Ada@ada·1hLearning From iOS26 changes0K0K1K2K",
            links: ["https://x.com/ada/status/1234567890"],
            imageSrcs: [],
          },
        ],
        mainText: "",
        bodyText: "",
      },
      20,
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        externalId: "1234567890",
        authorHandle: "ada",
        text: "Learning From iOS26 changes",
      }),
    ]);
  });

  it("cleans rendered profile posts that include X header and metric text", () => {
    const result = extractLatestFromSnapshot(
      {
        links: [],
        articles: [
          {
            text: "Donald J. Trump@realDonaldTrump·Nov 25, 2025I am asking all America First Patriots in Tennessee’s 7th Congressional District, who haven’t voted yet, to please GET OUT AND VOTE for MAGA Warrior Matt Van Epps, tomorrow, November 26th, the last day to vote early in person. You can win this Election for Matt! PLEASE VOTE FORShow moreTENNESSEE: MAKE A PLAN TO VOTE!From swampthevoteusa.com16K37K162K26M",
            links: ["https://x.com/realDonaldTrump/status/2057968277062582378"],
            imageSrcs: [
              "https://pbs.twimg.com/profile_images/trump.jpg",
              "https://pbs.twimg.com/media/trump-post.jpg",
            ],
          },
        ],
        mainText: "",
        bodyText: "",
      },
      20,
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        externalId: "2057968277062582378",
        authorHandle: "realdonaldtrump",
        authorDisplayName: "Donald J. Trump",
        text: "I am asking all America First Patriots in Tennessee’s 7th Congressional District, who haven’t voted yet, to please GET OUT AND VOTE for MAGA Warrior Matt Van Epps, tomorrow, November 26th, the last day to vote early in person. You can win this Election for Matt! PLEASE VOTE FOR TENNESSEE: MAKE A PLAN TO VOTE!",
        replyCount: 16_000,
        repostCount: 37_000,
        likeCount: 162_000,
        viewCount: 26_000_000,
      }),
    ]);
  });

  it("dedupes mixed GraphQL and DOM People by handle", () => {
    const merged = mergePeopleResults(
      [
        {
          handle: "maggi_13",
          displayName: "Graph Name",
          avatarUrl: null,
          bio: null,
          followerCount: 1,
          followingCount: null,
          postsCount: null,
          verified: false,
          rank: 1,
          sourceUrl: "https://x.com/maggi_13",
        },
      ],
      [
        {
          handle: "maggi_13",
          displayName: "DOM Name",
          avatarUrl: "avatar.jpg",
          bio: null,
          followerCount: null,
          followingCount: null,
          postsCount: null,
          verified: false,
          rank: 1,
          sourceUrl: "https://x.com/maggi_13",
        },
      ],
      5,
    );

    expect(merged).toEqual([
      expect.objectContaining({
        handle: "maggi_13",
        displayName: "Graph Name",
        avatarUrl: "avatar.jpg",
      }),
    ]);
  });

  it("dedupes mixed GraphQL and DOM latest posts by status id", () => {
    const merged = mergeLatestResults(
      [
        {
          externalId: "123",
          sourceUrl: "https://x.com/a/status/123",
          authorHandle: "a",
          authorDisplayName: null,
          authorAvatarUrl: null,
          text: "Graph text",
          postedAt: null,
          replyCount: null,
          repostCount: null,
          quoteCount: null,
          likeCount: 1,
          viewCount: null,
          media: [],
          rank: 1,
        },
      ],
      [
        {
          externalId: "123",
          sourceUrl: "https://x.com/a/status/123",
          authorHandle: "a",
          authorDisplayName: null,
          authorAvatarUrl: null,
          text: "DOM text",
          postedAt: null,
          replyCount: null,
          repostCount: null,
          quoteCount: null,
          likeCount: null,
          viewCount: 10,
          media: [],
          rank: 1,
        },
      ],
      20,
    );

    expect(merged).toEqual([
      expect.objectContaining({
        externalId: "123",
        text: "Graph text",
        viewCount: 10,
      }),
    ]);
  });
});

import { expect, it } from "vitest";
import {
  parseLatestPostsFromSearch,
  parsePeopleFromSearch,
} from "./search-parsers.js";

function userResult(
  handle: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    legacy: {
      screen_name: handle,
      name: handle ? `User ${handle}` : "No Handle",
      profile_image_url_https: handle
        ? `https://pbs.twimg.com/profile_images/${handle}_normal.jpg`
        : undefined,
    },
    ...overrides,
  };
}

function peoplePayload(entries: unknown[], cursor: string | null = null) {
  return {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  ...entries,
                  ...(cursor
                    ? [
                        {
                          content: {
                            entryType: "TimelineTimelineCursor",
                            cursorType: "Bottom",
                            value: cursor,
                          },
                        },
                      ]
                    : []),
                ],
              },
            ],
          },
        },
      },
    },
  };
}

function peopleEntry(kind: "user_results" | "user", result: unknown) {
  return {
    content: {
      itemContent: {
        [kind]: { result },
      },
    },
  };
}

function tweetResult(
  id: string,
  authorHandle: string | null,
  legacy: Record<string, unknown> = {},
  result: Record<string, unknown> = {},
) {
  return {
    rest_id: id,
    core: {
      user_results: {
        result: userResult(authorHandle, {
          legacy: {
            screen_name: authorHandle,
            name: "Author One",
            profile_image_url_https:
              "https://pbs.twimg.com/profile_images/u_normal.jpg",
          },
        }),
      },
    },
    legacy: {
      full_text: `post ${id}`,
      created_at: "Tue May 12 04:31:00 +0000 2026",
      reply_count: 1,
      retweet_count: 2,
      favorite_count: 3,
      ...legacy,
    },
    ...result,
  };
}

function tweetEntry(kind: "tweet_results" | "tweet", result: unknown) {
  return {
    content: {
      itemContent: {
        [kind]: { result },
      },
    },
  };
}

it("parses people candidates from nested X search payload", () => {
  const result = parsePeopleFromSearch({
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  {
                    content: {
                      itemContent: {
                        user_results: {
                          result: {
                            core: {
                              screen_name: "maggi_13",
                              name: "Just Smile :)",
                            },
                            avatar: {
                              image_url:
                                "https://pbs.twimg.com/profile_images/a_normal.jpg",
                            },
                            legacy: {
                              screen_name: "maggi_13",
                              name: "Just Smile :)",
                              description: "Fan account",
                              followers_count: 1423,
                              friends_count: 1223,
                              statuses_count: 520797,
                            },
                            verification: { verified: true },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  });

  expect(result.items).toEqual([
    expect.objectContaining({
      handle: "maggi_13",
      displayName: "Just Smile :)",
      avatarUrl: "https://pbs.twimg.com/profile_images/a.jpg",
      followerCount: 1423,
      rank: 1,
      sourceUrl: "https://x.com/maggi_13",
    }),
  ]);
});

it("parses latest posts with video media from X search payload", () => {
  const result = parseLatestPostsFromSearch({
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  {
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            rest_id: "123",
                            core: {
                              user_results: {
                                result: {
                                  legacy: {
                                    screen_name: "author_1",
                                    name: "Author One",
                                    profile_image_url_https:
                                      "https://pbs.twimg.com/profile_images/u_normal.jpg",
                                  },
                                },
                              },
                            },
                            legacy: {
                              full_text: "hello fightmyworlds",
                              created_at: "Tue May 12 04:31:00 +0000 2026",
                              reply_count: 1,
                              retweet_count: 2,
                              favorite_count: 3,
                              extended_entities: {
                                media: [
                                  {
                                    type: "video",
                                    media_url_https:
                                      "https://pbs.twimg.com/media/thumb.jpg",
                                    video_info: {
                                      duration_millis: 12000,
                                      variants: [
                                        {
                                          content_type: "video/mp4",
                                          bitrate: 832000,
                                          url: "https://video.twimg.com/a.mp4",
                                        },
                                      ],
                                    },
                                    sizes: { large: { w: 1280, h: 720 } },
                                  },
                                ],
                              },
                            },
                            views: { count: "100" },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  });

  expect(result.items).toEqual([
    expect.objectContaining({
      externalId: "123",
      sourceUrl: "https://x.com/author_1/status/123",
      authorHandle: "author_1",
      text: "hello fightmyworlds",
      likeCount: 3,
      viewCount: 100,
      media: [
        expect.objectContaining({
          mediaType: "video",
          mediaUrl: "https://video.twimg.com/a.mp4",
        }),
      ],
    }),
  ]);
});

it("unwraps reposted tweets and keeps the reposter metadata", () => {
  const result = parseLatestPostsFromSearch({
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  entries: [
                    tweetEntry(
                      "tweet_results",
                      tweetResult(
                        "repost-wrapper",
                        "kmbappe",
                        {
                          full_text: "RT @realmadrid: original text",
                          reply_count: 0,
                          retweet_count: 1480,
                          favorite_count: 0,
                          retweeted_status_result: {
                            result: tweetResult(
                              "original-1",
                              "realmadrid",
                              {
                                full_text: "original text",
                                reply_count: 992,
                                retweet_count: 1600,
                                favorite_count: 16000,
                              },
                              { views: { count: "509000" } },
                            ),
                          },
                        },
                        {
                          views: { count: "10" },
                        },
                      ),
                    ),
                  ],
                },
              ],
            },
          },
        },
      },
    },
  });

  expect(result.items).toEqual([
    expect.objectContaining({
      externalId: "original-1",
      sourceUrl: "https://x.com/realmadrid/status/original-1",
      authorHandle: "realmadrid",
      authorDisplayName: "Author One",
      text: "original text",
      replyCount: 992,
      repostCount: 1600,
      likeCount: 16000,
      viewCount: 509000,
      isRepost: true,
      repostedByHandle: "kmbappe",
      repostedByDisplayName: "Author One",
    }),
  ]);
});

it("preserves post line breaks and removes only extracted media URLs", () => {
  const result = parseLatestPostsFromSearch({
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  tweetEntry(
                    "tweet_results",
                    tweetResult("media-text-1", "author_1", {
                      full_text:
                        "Line one\nLine two https://t.co/media123\nKeep link https://t.co/story456",
                      entities: {
                        urls: [
                          {
                            url: "https://t.co/story456",
                            expanded_url: "https://example.com/story",
                          },
                        ],
                        media: [
                          {
                            type: "photo",
                            media_url_https:
                              "https://pbs.twimg.com/media/media123.jpg",
                            url: "https://t.co/media123",
                          },
                        ],
                      },
                    }),
                  ),
                ],
              },
            ],
          },
        },
      },
    },
  });

  expect(result.items[0]?.text).toBe(
    "Line one\nLine two\nKeep link https://t.co/story456",
  );
  expect(result.items[0]?.media).toEqual([
    expect.objectContaining({
      mediaType: "photo",
      mediaUrl: "https://pbs.twimg.com/media/media123.jpg",
    }),
  ]);
});

it("parses posts from profile timeline GraphQL payloads", () => {
  const result = parseLatestPostsFromSearch({
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  entries: [
                    {
                      content: {
                        itemContent: {
                          tweet_results: {
                            result: tweetResult("profile-1", "openai", {
                              full_text: "Hello from profile timeline",
                              favorite_count: 10,
                              retweet_count: 2,
                              reply_count: 1,
                              quote_count: 0,
                            }),
                          },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  });

  expect(result.items).toEqual([
    expect.objectContaining({
      externalId: "profile-1",
      authorHandle: "openai",
      text: "Hello from profile timeline",
      likeCount: 10,
    }),
  ]);
});

it("keeps quoted tweet snapshots on quote posts", () => {
  const result = parseLatestPostsFromSearch({
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  tweetEntry(
                    "tweet_results",
                    tweetResult(
                      "quote-1",
                      "elonmusk",
                      {
                        full_text: "Interesting",
                        quote_count: 1,
                        quoted_status_id_str: "quoted-1",
                      },
                      {
                        quoted_status_result: {
                          result: tweetResult("quoted-1", "arctotherium42", {
                            full_text: "Original quoted post",
                            favorite_count: 42,
                            retweet_count: 7,
                            reply_count: 3,
                          }),
                        },
                      },
                    ),
                  ),
                ],
              },
            ],
          },
        },
      },
    },
  });

  expect(result.items[0]).toMatchObject({
    externalId: "quote-1",
    text: "Interesting",
    quoteCount: 1,
    quotedPost: {
      externalId: "quoted-1",
      authorHandle: "arctotherium42",
      authorDisplayName: "Author One",
      text: "Original quoted post",
    },
  });
});

it("uses profile user context for profile timeline tweets without embedded author core", () => {
  const result = parseLatestPostsFromSearch({
    data: {
      user: {
        result: {
          legacy: {
            screen_name: "cristiano",
            name: "Cristiano Ronaldo",
            profile_image_url_https:
              "https://pbs.twimg.com/profile_images/cristiano_normal.jpg",
          },
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  entries: [
                    {
                      content: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              rest_id: "profile-context-1",
                              legacy: {
                                full_text: "Profile timeline post",
                                created_at: "Tue May 12 04:31:00 +0000 2026",
                                reply_count: 4,
                                retweet_count: 5,
                                favorite_count: 6,
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  });

  expect(result.items).toEqual([
    expect.objectContaining({
      externalId: "profile-context-1",
      sourceUrl: "https://x.com/cristiano/status/profile-context-1",
      authorHandle: "cristiano",
      authorDisplayName: "Cristiano Ronaldo",
      authorAvatarUrl: "https://pbs.twimg.com/profile_images/cristiano.jpg",
      text: "Profile timeline post",
      likeCount: 6,
    }),
  ]);
});

it("parses people from user.result and nested result wrappers", () => {
  const result = parsePeopleFromSearch(
    peoplePayload([
      peopleEntry("user", { result: userResult("wrapped_1") }),
      peopleEntry("user_results", {
        result: { result: userResult("wrapped_2") },
      }),
    ]),
  );

  expect(result.items.map((item) => item.handle)).toEqual([
    "wrapped_1",
    "wrapped_2",
  ]);
});

it("extracts bottom cursor from search payloads", () => {
  const result = parsePeopleFromSearch(
    peoplePayload(
      [peopleEntry("user_results", userResult("cursor_user"))],
      "cursor-bottom-1",
    ),
  );

  expect(result.nextCursor).toBe("cursor-bottom-1");
  expect(result.hasMore).toBe(true);
});

it("extracts bottom cursor from alternate X cursor fields", () => {
  const result = parseLatestPostsFromSearch({
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  tweetEntry("tweet_results", tweetResult("130", "author_1")),
                  {
                    entryId: "cursor-bottom-130",
                    content: {
                      __typename: "TimelineTimelineCursor",
                      cursor_type: "Bottom",
                      cursor: "cursor-bottom-alias",
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  });

  expect(result.nextCursor).toBe("cursor-bottom-alias");
  expect(result.hasMore).toBe(true);
});

it("extracts bottom cursor from SearchTimeline replace entry payloads", () => {
  const result = parseLatestPostsFromSearch({
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  tweetEntry("tweet_results", tweetResult("133", "author_1")),
                ],
              },
              {
                type: "TimelineReplaceEntry",
                entry: {
                  entryId: "cursor-bottom-0",
                  content: {
                    __typename: "TimelineTimelineCursor",
                    entryType: "TimelineTimelineCursor",
                    cursorType: "Bottom",
                    value: "cursor-bottom-replace",
                  },
                },
              },
            ],
          },
        },
      },
    },
  });

  expect(result.items.map((item) => item.externalId)).toEqual(["133"]);
  expect(result.nextCursor).toBe("cursor-bottom-replace");
});

it("keeps people bottom cursor when item limit is reached first", () => {
  const result = parsePeopleFromSearch(
    peoplePayload(
      [
        peopleEntry("user_results", userResult("limit_user_1")),
        peopleEntry("user_results", userResult("limit_user_2")),
      ],
      "cursor-after-people-limit",
    ),
    1,
  );

  expect(result.items.map((item) => item.handle)).toEqual(["limit_user_1"]);
  expect(result.nextCursor).toBe("cursor-after-people-limit");
  expect(result.hasMore).toBe(true);
});

it("dedupes people by handle while keeping stable ranks", () => {
  const result = parsePeopleFromSearch(
    peoplePayload([
      peopleEntry("user_results", userResult("dupe_user")),
      peopleEntry("user", userResult("DUPE_USER")),
      peopleEntry("user_results", userResult("second_user")),
    ]),
  );

  expect(result.items.map((item) => [item.handle, item.rank])).toEqual([
    ["dupe_user", 1],
    ["second_user", 2],
  ]);
  expect(result.hasMore).toBe(false);
});

it("ignores tombstone, unavailable, and no-handle people nodes", () => {
  const result = parsePeopleFromSearch(
    peoplePayload([
      peopleEntry("user_results", { __typename: "UserUnavailable" }),
      peopleEntry("user", userResult(null)),
      peopleEntry("user_results", userResult("valid_user")),
    ]),
  );

  expect(result.items.map((item) => item.handle)).toEqual(["valid_user"]);
});

it("stops collecting people after the requested limit", () => {
  const result = parsePeopleFromSearch(
    peoplePayload([
      peopleEntry("user_results", userResult("first_user")),
      peopleEntry("user_results", userResult("second_user")),
    ]),
    1,
  );

  expect(result.items.map((item) => item.handle)).toEqual(["first_user"]);
});

it("parses latest posts from tweet.result and nested result wrappers", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry("tweet", { result: tweetResult("124", "author_2") }),
      tweetEntry("tweet_results", {
        result: { result: tweetResult("125", "author_3") },
      }),
    ]),
  );

  expect(
    result.items.map((item) => [item.externalId, item.authorHandle, item.rank]),
  ).toEqual([
    ["124", "author_2", 1],
    ["125", "author_3", 2],
  ]);
});

it("dedupes latest posts by external id while keeping stable ranks", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry("tweet_results", tweetResult("126", "author_1")),
      tweetEntry(
        "tweet",
        tweetResult("126", "author_1", { full_text: "duplicate" }),
      ),
      tweetEntry("tweet_results", tweetResult("127", "author_1")),
    ]),
  );

  expect(result.items.map((item) => [item.externalId, item.rank])).toEqual([
    ["126", 1],
    ["127", 2],
  ]);
});

it("keeps latest bottom cursor when item limit is reached first", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload(
      [
        tweetEntry("tweet_results", tweetResult("131", "author_1")),
        tweetEntry("tweet_results", tweetResult("132", "author_1")),
      ],
      "cursor-after-latest-limit",
    ),
    1,
  );

  expect(result.items.map((item) => item.externalId)).toEqual(["131"]);
  expect(result.nextCursor).toBe("cursor-after-latest-limit");
  expect(result.hasMore).toBe(true);
});

it("chooses the highest mp4 video variant within the bitrate cap", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry(
        "tweet_results",
        tweetResult("128", "author_1", {
          extended_entities: {
            media: [
              {
                type: "video",
                media_url_https: "https://pbs.twimg.com/media/thumb.jpg",
                video_info: {
                  variants: [
                    {
                      content_type: "application/x-mpegURL",
                      url: "https://video.twimg.com/stream.m3u8",
                    },
                    {
                      content_type: "video/mp4",
                      bitrate: 0,
                      url: "https://video.twimg.com/no-bitrate.mp4",
                    },
                    {
                      content_type: "video/mp4",
                      bitrate: 832000,
                      url: "https://video.twimg.com/low.mp4",
                    },
                    {
                      content_type: "video/mp4",
                      bitrate: 2176000,
                      url: "https://video.twimg.com/high.mp4",
                    },
                    {
                      content_type: "video/mp4",
                      bitrate: 8000000,
                      url: "https://video.twimg.com/too-large.mp4",
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    ]),
  );

  expect(result.items[0]?.media[0]?.sources).toEqual([
    {
      type: "application/x-mpegURL",
      url: "https://video.twimg.com/stream.m3u8",
    },
    {
      bitrate: 8000000,
      type: "video/mp4",
      url: "https://video.twimg.com/too-large.mp4",
    },
    {
      bitrate: 2176000,
      type: "video/mp4",
      url: "https://video.twimg.com/high.mp4",
    },
    {
      bitrate: 832000,
      type: "video/mp4",
      url: "https://video.twimg.com/low.mp4",
    },
    {
      type: "video/mp4",
      url: "https://video.twimg.com/no-bitrate.mp4",
    },
  ]);
  expect(result.items[0]?.media[0]?.mediaUrl).toBe(
    "https://video.twimg.com/high.mp4",
  );
  expect(result.items[0]?.media).toEqual([
    expect.objectContaining({
      mediaType: "video",
      mediaUrl: "https://video.twimg.com/high.mp4",
    }),
  ]);
});

it("preserves all video sources while keeping legacy all-over-cap fallback", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry(
        "tweet_results",
        tweetResult("over-cap-video", "author_1", {
          extended_entities: {
            media: [
              {
                type: "video",
                media_url_https: "https://pbs.twimg.com/media/thumb.jpg",
                video_info: {
                  variants: [
                    {
                      content_type: "video/mp4",
                      url: "https://video.twimg.com/no-bitrate.mp4",
                    },
                    {
                      content_type: "video/mp4",
                      bitrate: 8000000,
                      url: "https://video.twimg.com/over-high.mp4",
                    },
                    {
                      content_type: "video/mp4",
                      bitrate: 4000000,
                      url: "https://video.twimg.com/over-low.mp4",
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    ]),
  );

  expect(result.items[0]?.media[0]?.sources).toEqual([
    {
      bitrate: 8000000,
      type: "video/mp4",
      url: "https://video.twimg.com/over-high.mp4",
    },
    {
      bitrate: 4000000,
      type: "video/mp4",
      url: "https://video.twimg.com/over-low.mp4",
    },
    {
      type: "video/mp4",
      url: "https://video.twimg.com/no-bitrate.mp4",
    },
  ]);
  expect(result.items[0]?.media[0]?.mediaUrl).toBe(
    "https://video.twimg.com/over-low.mp4",
  );
});

it("extracts video media from unified card bindings", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry(
        "tweet_results",
        tweetResult(
          "card-video-1",
          "spacex",
          {
            full_text:
              "Watch Falcon 9 launch the @SiriusXM SXM-11 mission to orbit https://t.co/DqCgyTsEny",
            entities: {
              urls: [
                {
                  url: "https://t.co/DqCgyTsEny",
                  expanded_url: "https://x.com/i/broadcasts/example",
                },
              ],
            },
          },
          {
            card: {
              legacy: {
                binding_values: [
                  {
                    key: "unified_card",
                    value: {
                      string_value: JSON.stringify({
                        media_entities: {
                          "2071416671156183352": {
                            type: "video",
                            media_url_https:
                              "https://pbs.twimg.com/amplify_video_thumb/card/img.jpg",
                            video_info: {
                              variants: [
                                {
                                  content_type: "video/mp4",
                                  bitrate: 832000,
                                  url: "https://video.twimg.com/amplify_video/card/vid/avc1/640x360/video.mp4",
                                },
                              ],
                              duration_millis: 45000,
                            },
                            sizes: { large: { w: 640, h: 360 } },
                          },
                        },
                      }),
                    },
                  },
                ],
              },
            },
          },
        ),
      ),
    ]),
  );

  expect(result.items[0]).toMatchObject({
    externalId: "card-video-1",
    text: "Watch Falcon 9 launch the @SiriusXM SXM-11 mission to orbit",
    media: [
      {
        mediaType: "video",
        mediaUrl:
          "https://video.twimg.com/amplify_video/card/vid/avc1/640x360/video.mp4",
        thumbnailUrl: "https://pbs.twimg.com/amplify_video_thumb/card/img.jpg",
        width: 640,
        height: 360,
        durationSeconds: 45,
      },
    ],
  });
});

it("extracts image media from unified card image bindings", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry(
        "tweet_results",
        tweetResult(
          "card-image-1",
          "mining",
          {
            full_text:
              "BHP Invent, MIT spinout trial copper and gold recovery technology from waste streams https://t.co/YOJoVYfGfq",
            entities: {
              urls: [
                {
                  url: "https://t.co/YOJoVYfGfq",
                  expanded_url:
                    "https://www.mining.com/bhp-invent-mit-spinout-trial-copper-and-gold-recovery-technology-from-waste-streams/",
                },
              ],
            },
          },
          {
            card: {
              legacy: {
                binding_values: [
                  {
                    key: "unified_card",
                    value: {
                      string_value: JSON.stringify({
                        destination_objects: {
                          browser: {
                            data: {
                              url_data: {
                                url: "https://www.mining.com/bhp-invent-mit-spinout-trial-copper-and-gold-recovery-technology-from-waste-streams/",
                              },
                            },
                          },
                        },
                        media_entities: {},
                        component_objects: {
                          media: {
                            data: {
                              type: "media",
                              media: {
                                image_value: {
                                  url: "https://pbs.twimg.com/card_img/1939426190141362176/wKgbCL4L?format=jpg&name=small",
                                  width: 680,
                                  height: 340,
                                },
                              },
                            },
                          },
                        },
                      }),
                    },
                  },
                ],
              },
            },
          },
        ),
      ),
    ]),
  );

  expect(result.items[0]).toMatchObject({
    externalId: "card-image-1",
    text: "BHP Invent, MIT spinout trial copper and gold recovery technology from waste streams",
    media: [
      {
        mediaType: "photo",
        mediaUrl:
          "https://pbs.twimg.com/card_img/1939426190141362176/wKgbCL4L?format=jpg&name=small",
        thumbnailUrl:
          "https://pbs.twimg.com/card_img/1939426190141362176/wKgbCL4L?format=jpg&name=small",
        width: 680,
        height: 340,
        durationSeconds: null,
      },
    ],
  });
});

it("extracts image media from direct card image bindings", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry(
        "tweet_results",
        tweetResult(
          "card-direct-image-1",
          "mining",
          {
            full_text:
              "BHP Invent, MIT spinout trial copper and gold recovery technology from waste streams https://t.co/YOJoVYfGfq",
            entities: {
              urls: [
                {
                  url: "https://t.co/YOJoVYfGfq",
                  expanded_url:
                    "https://www.mining.com/bhp-invent-mit-spinout-trial-copper-and-gold-recovery-technology-from-waste-streams/",
                },
              ],
            },
          },
          {
            card: {
              legacy: {
                binding_values: [
                  {
                    key: "thumbnail_image",
                    value: {
                      image_value: {
                        url: "https://pbs.twimg.com/card_img/1939426190141362176/wKgbCL4L?format=jpg&name=small",
                        width: 320,
                        height: 160,
                      },
                    },
                  },
                  {
                    key: "thumbnail_image_large",
                    value: {
                      image_value: {
                        url: "https://pbs.twimg.com/card_img/1939426190141362176/wKgbCL4L?format=jpg&name=large",
                        width: 680,
                        height: 340,
                      },
                    },
                  },
                ],
              },
            },
          },
        ),
      ),
    ]),
  );

  expect(result.items[0]).toMatchObject({
    externalId: "card-direct-image-1",
    text: "BHP Invent, MIT spinout trial copper and gold recovery technology from waste streams",
    media: [
      {
        mediaType: "photo",
        mediaUrl:
          "https://pbs.twimg.com/card_img/1939426190141362176/wKgbCL4L?format=jpg&name=large",
        thumbnailUrl:
          "https://pbs.twimg.com/card_img/1939426190141362176/wKgbCL4L?format=jpg&name=large",
        width: 680,
        height: 340,
        durationSeconds: null,
      },
    ],
  });
});

it("ignores non-card image_value bindings", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry(
        "tweet_results",
        tweetResult(
          "card-icon-image-1",
          "mining",
          {
            full_text:
              "BHP Invent, MIT spinout trial copper and gold recovery technology from waste streams https://t.co/YOJoVYfGfq",
            entities: {
              urls: [
                {
                  url: "https://t.co/YOJoVYfGfq",
                  expanded_url:
                    "https://www.mining.com/bhp-invent-mit-spinout-trial-copper-and-gold-recovery-technology-from-waste-streams/",
                },
              ],
            },
          },
          {
            card: {
              legacy: {
                binding_values: [
                  {
                    key: "app_image",
                    value: {
                      image_value: {
                        url: "https://example.com/icon.png",
                        width: 1024,
                        height: 1024,
                      },
                    },
                  },
                ],
              },
            },
          },
        ),
      ),
    ]),
  );

  expect(result.items[0]).toMatchObject({
    externalId: "card-icon-image-1",
    media: [],
  });
});

it("marks timeline posts with pinned context", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      {
        content: {
          itemContent: {
            socialContext: {
              type: "TimelineGeneralContext",
              text: "Pinned",
            },
            tweet_results: {
              result: tweetResult("pinned-1", "elonmusk", {
                full_text: "Pinned update",
              }),
            },
          },
        },
      },
    ]),
  );

  expect(result.items[0]).toMatchObject({
    externalId: "pinned-1",
    text: "Pinned update",
    isPinned: true,
  });
});

it("falls back to photo media URLs", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry(
        "tweet_results",
        tweetResult("129", "author_1", {
          entities: {
            media: [
              {
                type: "photo",
                media_url: "https://pbs.twimg.com/media/photo.jpg",
                sizes: { medium: { w: 600, h: 400 } },
              },
            ],
          },
        }),
      ),
    ]),
  );

  expect(result.items[0]?.media).toEqual([
    expect.objectContaining({
      mediaType: "photo",
      mediaUrl: "https://pbs.twimg.com/media/photo.jpg",
      width: 600,
      height: 400,
    }),
  ]);
});

it("ignores null and missing media fields without crashing", () => {
  const result = parseLatestPostsFromSearch(
    peoplePayload([
      tweetEntry(
        "tweet_results",
        tweetResult("130", "author_1", {
          extended_entities: {
            media: [
              null,
              {},
              {
                type: "video",
                video_info: {
                  variants: [
                    {
                      content_type: "application/x-mpegURL",
                      url: "https://video.twimg.com/a.m3u8",
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    ]),
  );

  expect(result.items[0]?.media).toEqual([]);
});

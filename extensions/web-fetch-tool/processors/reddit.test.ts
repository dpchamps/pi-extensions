import { describe, it, expect } from "vitest";
import processReddit from "./reddit";

describe("extractPost", () => {
  it("extracts essential fields from a post", () => {
    const json = {
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t3",
            data: {
              title: "Test Post",
              author: "testuser",
              selftext: "Post content",
              score: 100,
              upvote_ratio: 0.95,
              num_comments: 42,
              link_flair_text: "Discussion",
              author_flair_text: "FLAIR",
              created_utc: 1234567890,
              permalink: "/r/test/comments/abc123/test_post",
              url: "https://example.com",
              subreddit: "test",
            },
          },
        ],
        after: "t3_nextpost",
      },
    };

    const result = processReddit(json, "https://reddit.com/r/test.json");

    expect(result).toMatchObject({
      meta: {
        subreddit: "test",
        after: "t3_nextpost",
      },
      posts: [
        {
          title: "Test Post",
          author: "testuser",
          selftext: "Post content",
          score: 100,
          upvote_ratio: 0.95,
          num_comments: 42,
          link_flair_text: "Discussion",
          author_flair_text: "FLAIR",
          created_utc: 1234567890,
          permalink: "/r/test/comments/abc123/test_post",
          url: "https://example.com",
        },
      ],
    });
  });

  it("handles posts without optional fields", () => {
    const json = {
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t3",
            data: {
              title: "Minimal Post",
              author: "user",
              selftext: "",
              score: 1,
              upvote_ratio: 0.5,
              num_comments: 0,
              created_utc: 1234567890,
              permalink: "/r/test/comments/xyz/minimal_post",
              url: "https://example.com",
            },
          },
        ],
      },
    };

    const result = processReddit(json, "https://reddit.com/r/test.json");

    expect(result.posts[0]).toMatchObject({
      title: "Minimal Post",
      author: "user",
      selftext: undefined,
      link_flair_text: undefined,
      author_flair_text: undefined,
    });
  });

  it("filters out non-t3 children", () => {
    const json = {
      kind: "Listing",
      data: {
        children: [
          { kind: "t1", data: {} }, // comment, should be filtered
          {
            kind: "t3",
            data: {
              title: "Valid Post",
              author: "user",
              selftext: "",
              score: 1,
              upvote_ratio: 0.5,
              num_comments: 0,
              created_utc: 1234567890,
              permalink: "/r/test/comments/xyz/valid_post",
              url: "https://example.com",
            },
          },
        ],
      },
    };

    const result = processReddit(json, "https://reddit.com/r/test.json");

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].title).toBe("Valid Post");
  });
});

describe("flattenComments", () => {
  it("extracts comments from a thread", () => {
    const commentThread = [
      {
        kind: "t1",
        data: {
          id: "comment1",
          parent_id: "t3_post123",
          author: "commenter1",
          body: "First comment",
          score: 10,
          depth: 0,
          is_submitter: false,
          created_utc: 1234567891,
          replies: {},
        },
      },
      {
        kind: "t1",
        data: {
          id: "comment2",
          parent_id: "t3_post123",
          author: "commenter2",
          body: "Reply to post",
          score: 5,
          depth: 0,
          is_submitter: false,
          created_utc: 1234567892,
          replies: {
            data: {
              children: [
                {
                  kind: "t1",
                  data: {
                    id: "comment3",
                    parent_id: "t1_comment2",
                    author: "commenter3",
                    body: "Nested reply",
                    score: 2,
                    depth: 1,
                    is_submitter: false,
                    created_utc: 1234567893,
                    replies: {},
                  },
                },
              ],
            },
          },
        },
      },
    ];

    const json = [
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t3",
              data: {
                title: "Test Post",
                author: "OP",
                selftext: "Post body",
                score: 100,
                upvote_ratio: 0.95,
                num_comments: 2,
                created_utc: 1234567890,
                permalink: "/r/test/comments/post123/test_post",
                url: "https://example.com",
              },
            },
          ],
        },
      },
      {
        kind: "Listing",
        data: {
          children: commentThread,
        },
      },
    ];

    const result = processReddit(json, "https://reddit.com/r/test/comments/post123/test_post");

    expect(result).toMatchObject({
      title: "Test Post",
      author: "OP",
      comments: expect.arrayContaining([
        expect.objectContaining({
          id: "comment1",
          author: "commenter1",
          body: "First comment",
          depth: 0,
          is_submitter: false,
        }),
        expect.objectContaining({
          id: "comment2",
          author: "commenter2",
          body: "Reply to post",
          depth: 0,
        }),
        expect.objectContaining({
          id: "comment3",
          author: "commenter3",
          body: "Nested reply",
          depth: 1,
          is_submitter: false,
        }),
      ]),
    });
    expect(result.comments).toHaveLength(3);
  });

  it("handles 'more' comments", () => {
    const json = [
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t3",
              data: {
                title: "Post",
                author: "user",
                selftext: "",
                score: 1,
                upvote_ratio: 0.5,
                num_comments: 0,
                created_utc: 1234567890,
                permalink: "/r/test/comments/post/post",
                url: "https://example.com",
              },
            },
          ],
        },
      },
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "more",
              data: {
                count: 5,
                children: ["id1", "id2", "id3"],
              },
            },
          ],
        },
      },
    ];

    const result = processReddit(json, "https://reddit.com/r/test/comments/post/post");

    expect(result.comments).toContainEqual({
      kind: "more",
      count: 5,
      children: ["id1", "id2", "id3"],
    });
  });

  it("handles deeply nested comments", () => {
    const deepNested = {
      kind: "t1",
      data: {
        id: "deep",
        parent_id: "parent",
        author: "deep_user",
        body: "Deep comment",
        score: 1,
        depth: 5,
        is_submitter: true,
        created_utc: 1234567890,
        replies: {},
      },
    };

    let current = deepNested;
    // Build nesting: reply -> reply -> reply
    for (let i = 2; i >= 0; i--) {
      current = {
        kind: "t1",
        data: {
          id: `level${i}`,
          parent_id: `level${i + 1}`,
          author: `user${i}`,
          body: `Level ${i} comment`,
          score: i,
          depth: i,
          is_submitter: false,
          created_utc: 1234567890 + i,
          replies: { data: { children: [current] } },
        },
      };
    }

    const json = [
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t3",
              data: {
                title: "Deep Post",
                author: "user",
                selftext: "",
                score: 1,
                upvote_ratio: 0.5,
                num_comments: 0,
                created_utc: 1234567890,
                permalink: "/r/test/comments/post/post",
                url: "https://example.com",
              },
            },
          ],
        },
      },
      { kind: "Listing", data: { children: [current] } },
    ];

    const result = processReddit(json, "https://reddit.com/r/test/comments/post/post");

    // Should have 4 comments total (3 nesting levels + 1 deep)
    expect(result.comments).toHaveLength(4);
    expect(result.comments[3]).toMatchObject({
      id: "deep",
      depth: 5,
      is_submitter: true,
    });
  });
});

describe("fallback handling", () => {
  it("returns input as-is for unrecognized formats", () => {
    const unknownFormat = {
      kind: "unknown",
      data: { something: "else" },
    };

    const result = processReddit(unknownFormat, "https://reddit.com/r/test.json");

    expect(result).toEqual(unknownFormat);
  });

  it("handles empty subreddit listing", () => {
    const emptyJson = {
      kind: "Listing",
      data: {
        children: [],
      },
    };

    const result = processReddit(emptyJson, "https://reddit.com/r/empty.json");

    expect(result).toEqual({
      meta: {
        subreddit: undefined,
        after: undefined,
      },
      posts: [],
    });
  });
});

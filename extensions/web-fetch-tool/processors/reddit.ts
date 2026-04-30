/**
 * Reddit processor — transforms raw Reddit JSON into clean, compact output.
 *
 * Handles two response shapes:
 *   1. Subreddit listing: array of posts
 *   2. Comment thread: post + nested comments
 */

interface RedditPost {
  title: string;
  author: string;
  selftext: string | undefined;
  score: number;
  upvote_ratio: number;
  num_comments: number;
  link_flair_text: string | undefined;
  author_flair_text: string | undefined;
  created_utc: number;
  permalink: string;
  url: string;
}

interface RedditComment {
  author: string;
  body: string;
  score: number;
  depth: number;
  is_submitter: boolean;
  created_utc: number;
  id: string;
  parent_id: string;
}

interface MoreComments {
  kind: "more";
  count: number;
  children: string[];
}

interface RedditChild {
  kind: string;
  data: Record<string, unknown> & { subreddit?: string };
}

interface RedditListing {
  kind: "Listing";
  data: {
    children: RedditChild[];
    after?: string;
  };
}

function isRedditListing(value: unknown): value is RedditListing {
  if (!value || typeof value !== "object") return false;
  const obj = value as { kind?: unknown; data?: { children?: unknown } };
  return obj.kind === "Listing" && Array.isArray(obj.data?.children);
}

/**
 * Extract the essential fields from a Reddit post (t3) object.
 */
function extractPost(data: Record<string, unknown>): RedditPost {
  return {
    title: data.title as string,
    author: data.author as string,
    selftext: (data.selftext as string) || undefined,
    score: data.score as number,
    upvote_ratio: data.upvote_ratio as number,
    num_comments: data.num_comments as number,
    link_flair_text: (data.link_flair_text as string) || undefined,
    author_flair_text: (data.author_flair_text as string) || undefined,
    created_utc: data.created_utc as number,
    permalink: data.permalink as string,
    url: data.url as string,
  };
}

/**
 * Flatten a nested comment tree into a flat array, keeping depth for structure.
 */
function flattenComments(
  children: RedditChild[],
  result: (RedditComment | MoreComments)[] = [],
): (RedditComment | MoreComments)[] {
  for (const child of children) {
    if (child.kind === "t1") {
      const d = child.data as Record<string, unknown> & {
        replies?: { data?: { children?: RedditChild[] } };
      };
      const comment: RedditComment = {
        author: d.author as string,
        body: d.body as string,
        score: d.score as number,
        depth: d.depth as number,
        is_submitter: d.is_submitter as boolean,
        created_utc: d.created_utc as number,
        id: d.id as string,
        parent_id: d.parent_id as string,
      };
      result.push(comment);
      if (d.replies && typeof d.replies === "object" && d.replies?.data) {
        flattenComments(d.replies.data.children || [], result);
      }
    } else if (child.kind === "more") {
      const moreData = child.data as { count: number; children: string[] };
      result.push({
        kind: "more",
        count: moreData.count,
        children: moreData.children,
      });
    }
  }
  return result;
}

/**
 * Main processor entry point. Receives the parsed JSON from Reddit's API
 * and the original URL, returns a clean object to be serialized as JSON.
 */
export default function processReddit(
  json: unknown,
  _originalUrl: string,
): any {
  // Comment thread: array of 2 listings [post, comments]
  if (
    Array.isArray(json) &&
    json.length === 2 &&
    isRedditListing(json[0]) &&
    isRedditListing(json[1])
  ) {
    const postChildren = json[0].data.children;
    const commentChildren = json[1].data.children;

    if (postChildren.length === 1 && postChildren[0].kind === "t3") {
      const post = extractPost(postChildren[0].data);
      const comments = flattenComments(commentChildren);
      return { ...post, comments };
    }
  }

  // Subreddit listing: single listing of posts
  if (isRedditListing(json)) {
    const posts = json.data.children
      .map((child: RedditChild) =>
        child.kind === "t3" ? extractPost(child.data) : null
      )
      .filter((p: RedditPost | null): p is RedditPost => p !== null);

    const firstPostData = json.data.children[0]?.kind === "t3"
      ? (json.data.children[0].data as Record<string, unknown> & {
          subreddit?: string;
        })
      : null;
    const meta = {
      subreddit: firstPostData?.subreddit,
      after: json.data.after || undefined,
    };

    return { meta, posts };
  }

  // Fallback: return as-is
  return json;
}

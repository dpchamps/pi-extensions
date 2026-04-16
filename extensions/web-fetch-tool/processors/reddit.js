/**
 * Reddit processor — transforms raw Reddit JSON into clean, compact output.
 *
 * Handles two response shapes:
 *   1. Subreddit listing: array of posts
 *   2. Comment thread: post + nested comments
 */

/**
 * Extract the essential fields from a Reddit post (t3) object.
 */
function extractPost(data) {
  return {
    title: data.title,
    author: data.author,
    selftext: data.selftext || undefined,
    score: data.score,
    upvote_ratio: data.upvote_ratio,
    num_comments: data.num_comments,
    link_flair_text: data.link_flair_text || undefined,
    author_flair_text: data.author_flair_text || undefined,
    created_utc: data.created_utc,
    permalink: data.permalink,
    url: data.url,
  };
}

/**
 * Flatten a nested comment tree into a flat array, keeping depth for structure.
 */
function flattenComments(children, result = []) {
  for (const child of children) {
    if (child.kind === "t1") {
      const d = child.data;
      result.push({
        author: d.author,
        body: d.body,
        score: d.score,
        depth: d.depth,
        is_submitter: d.is_submitter,
        created_utc: d.created_utc,
        id: d.id,
        parent_id: d.parent_id,
      });
      if (d.replies && typeof d.replies === "object" && d.replies?.data) {
        flattenComments(d.replies.data.children, result);
      }
    } else if (child.kind === "more") {
      result.push({
        kind: "more",
        count: child.data.count,
        children: child.data.children,
      });
    }
  }
  return result;
}

/**
 * Main processor entry point. Receives the parsed JSON from Reddit's API
 * and the original URL, returns a clean object to be serialized as JSON.
 */
export default function processReddit(json, originalUrl) {
  // Comment thread: array of 2 listings [post, comments]
  if (Array.isArray(json) && json.length === 2 && json[0].kind === "Listing") {
    const postChildren = json[0].data.children;
    const commentChildren = json[1].data.children;

    if (postChildren.length === 1 && postChildren[0].kind === "t3") {
      const post = extractPost(postChildren[0].data);
      const comments = flattenComments(commentChildren);
      return { ...post, comments };
    }
  }

  // Subreddit listing: single listing of posts
  if (json.kind === "Listing" && json.data?.children?.[0]?.kind === "t3") {
    const posts = json.data.children
      .map((child) => extractPost(child.data))
      .filter(Boolean);

    const meta = {
      subreddit: json.data.children[0]?.data?.subreddit,
      after: json.data.after || undefined,
    };

    return { meta, posts };
  }

  // Fallback: return as-is
  return json;
}

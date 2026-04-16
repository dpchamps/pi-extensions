/**
 * Imgur processor — extracts image URLs from Imgur albums and single images.
 *
 * Uses the public Imgur API (no auth required for public content).
 * Handles:
 *   - Albums: https://imgur.com/a/{albumId}
 *   - Single images: https://imgur.com/{imageId}
 *   - Direct links: https://i.imgur.com/{imageId}.jpeg  (passed through)
 */

const CLIENT_ID = "546c25a59c58ad7";
const API_BASE = "https://api.imgur.com/3";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Parse an Imgur URL and return its type and ID.
 */
function parseImgurUrl(url) {
  // Direct image link: i.imgur.com/{imageId}.{ext}
  const directMatch = url.match(/i\.imgur\.com\/([A-Za-z0-9]+)(?:\.[a-z]+)?/);
  if (directMatch) {
    return { type: "direct", id: directMatch[1] };
  }

  // Album: imgur.com/a/{albumId}
  const albumMatch = url.match(/imgur\.com\/a\/([A-Za-z0-9]+)/);
  if (albumMatch) {
    return { type: "album", id: albumMatch[1] };
  }

  // Single image page: imgur.com/{imageId}
  const imageMatch = url.match(/imgur\.com\/([A-Za-z0-9]+)/);
  if (imageMatch) {
    return { type: "image", id: imageMatch[1] };
  }

  return null;
}

/**
 * Extract essential fields from an Imgur image object.
 */
function extractImage(img) {
  return {
    id: img.id,
    link: img.link,
    type: img.type,
    width: img.width,
    height: img.height,
    size: img.size,
    title: img.title || undefined,
    description: img.description || undefined,
  };
}

/**
 * Main processor entry point.
 * When no `fetch` config is present in the domain config, the pipeline
 * passes the original URL instead of parsed JSON.
 */
export default async function processImgur(input, originalUrl) {
  // If input is already parsed JSON (shouldn't happen for Imgur, but safety check)
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    if (input.data) return shapeResponse(input);
  }

  const parsed = parseImgurUrl(originalUrl);
  if (!parsed) {
    return { error: "Could not parse Imgur URL", url: originalUrl };
  }

  // Direct link — just return it
  if (parsed.type === "direct") {
    return {
      type: "direct",
      images: [
        {
          id: parsed.id,
          link: originalUrl,
        },
      ],
    };
  }

  // Album or single image — call the API
  const endpoint =
    parsed.type === "album"
      ? `${API_BASE}/album/${parsed.id}`
      : `${API_BASE}/image/${parsed.id}`;

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Client-ID ${CLIENT_ID}`,
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    return {
      error: `Imgur API returned HTTP ${response.status}`,
      url: originalUrl,
    };
  }

  const json = await response.json();

  if (!json.success) {
    return {
      error: "Imgur API returned unsuccessful response",
      status: json.status,
      url: originalUrl,
    };
  }

  const data = json.data;

  // Album
  if (parsed.type === "album" && data.images) {
    return {
      type: "album",
      id: data.id,
      title: data.title || undefined,
      description: data.description || undefined,
      image_count: data.images_count || data.images.length,
      images: data.images.map(extractImage),
    };
  }

  // Single image
  if (parsed.type === "image") {
    return {
      type: "image",
      id: data.id,
      title: data.title || undefined,
      description: data.description || undefined,
      images: [extractImage(data)],
    };
  }

  return { error: "Unknown Imgur response format", url: originalUrl };
}

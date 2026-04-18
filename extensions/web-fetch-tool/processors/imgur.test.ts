import { describe, it, expect, vi, beforeEach } from "vitest";
import processImgur from "./imgur";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe("parseImgurUrl", () => {
  it("parses direct image links", async () => {
    const result = await processImgur({}, "https://i.imgur.com/abc123.jpg");
    expect(result).toEqual({
      type: "direct",
      images: [{ id: "abc123", link: "https://i.imgur.com/abc123.jpg" }],
    });
  });

  it("parses direct image links without extension", async () => {
    const result = await processImgur({}, "https://i.imgur.com/xyz789");
    expect(result).toEqual({
      type: "direct",
      images: [{ id: "xyz789", link: "https://i.imgur.com/xyz789" }],
    });
  });

  it("parses album links", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          status: 200,
          data: {
            id: "album123",
            title: "My Album",
            images_count: 2,
            images: [
              {
                id: "img1",
                link: "https://i.imgur.com/img1.jpg",
                type: "image/jpeg",
                width: 1920,
                height: 1080,
                size: 102400,
              },
              {
                id: "img2",
                link: "https://i.imgur.com/img2.png",
                type: "image/png",
                width: 800,
                height: 600,
                size: 51200,
              },
            ],
          },
        }),
    });

    const result = await processImgur({}, "https://imgur.com/a/album123");
    expect(result).toMatchObject({
      type: "album",
      id: "album123",
      title: "My Album",
      image_count: 2,
      images: expect.arrayContaining([
        expect.objectContaining({ id: "img1", link: "https://i.imgur.com/img1.jpg" }),
        expect.objectContaining({ id: "img2", link: "https://i.imgur.com/img2.png" }),
      ]),
    });
  });

  it("parses single image page links", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          status: 200,
          data: {
            id: "single123",
            link: "https://i.imgur.com/single123.jpg",
            type: "image/jpeg",
            width: 1920,
            height: 1080,
            size: 102400,
            title: "Single Image",
          },
        }),
    });

    const result = await processImgur({}, "https://imgur.com/single123");
    expect(result).toMatchObject({
      type: "image",
      id: "single123",
      title: "Single Image",
      description: undefined,
      images: [
        expect.objectContaining({
          id: "single123",
          link: "https://i.imgur.com/single123.jpg",
          type: "image/jpeg",
          width: 1920,
          height: 1080,
          size: 102400,
        }),
      ],
    });
  });

  it("returns error for invalid URLs", async () => {
    const result = await processImgur({}, "https://example.com/image");
    expect(result).toEqual({
      error: "Could not parse Imgur URL",
      url: "https://example.com/image",
    });
  });
});

describe("API responses", () => {
  it("handles HTTP errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
    });

    const result = await processImgur({}, "https://imgur.com/a/album123");
    expect(result).toEqual({
      error: "Imgur API returned HTTP 429",
      url: "https://imgur.com/a/album123",
    });
  });

  it("handles unsuccessful API responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          success: false,
          status: 403,
        }),
    });

    const result = await processImgur({}, "https://imgur.com/a/album123");
    expect(result).toMatchObject({
      error: "Imgur API returned unsuccessful response",
      status: 403,
    });
  });

  it("handles unknown response format", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          status: 200,
          data: {
            id: "unknown",
            // missing expected fields
          },
        }),
    });

    const result = await processImgur({}, "https://imgur.com/a/album123");
    expect(result).toEqual({
      error: "Unknown Imgur response format",
      url: "https://imgur.com/a/album123",
    });
  });
});

describe("pre-parsed JSON input", () => {
  it("handles already parsed album data", async () => {
    const preParsedData = {
      success: true,
      status: 200,
      data: {
        id: "album456",
        title: "Pre-parsed Album",
        images_count: 1,
        images: [
          {
            id: "img3",
            link: "https://i.imgur.com/img3.jpg",
            type: "image/jpeg",
            width: 1024,
            height: 768,
            size: 25600,
          },
        ],
      },
    };

    // Import shapeResponse directly to test pre-parsed handling
    const { shapeResponse } = await import("./imgur");
    const result = shapeResponse(preParsedData);
    expect(result).toMatchObject({
      type: "album",
      id: "album456",
      title: "Pre-parsed Album",
    });
  });
});

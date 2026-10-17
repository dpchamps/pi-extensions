import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ModelsPublication,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createRunInfraProvider, fetchRunInfraModels } from "./provider";
import { toPiModels, type RunInfraModelsResponse } from "./models";

const mockFetch = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = mockFetch;

const CATALOG: RunInfraModelsResponse = {
  object: "list",
  data: [
    {
      id: "deepseek-v4-flash",
      availability: "available",
      max_output_tokens: 32768,
      context_window: 1048576,
      pricing: { input: 0.13, output: 0.27 },
    },
  ],
};

function jsonBody(body: unknown, ok = true, status = 200, statusText = "OK") {
  return {
    ok,
    status,
    statusText,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: async () => body as any,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("fetchRunInfraModels", () => {
  it("sends the Bearer key and returns the parsed catalog", async () => {
    mockFetch.mockResolvedValueOnce(jsonBody(CATALOG));
    const result = await fetchRunInfraModels("test-key");
    expect(result).toEqual(CATALOG);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.runinfra.ai/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
    expect(init.method).toBe("GET");
  });

  it("throws a descriptive error on non-2xx responses", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonBody(
        { error: { message: "Invalid API key", code: "auth_error" } },
        false,
        401,
        "Unauthorized",
      ),
    );
    await expect(fetchRunInfraModels("bad-key")).rejects.toThrow(/HTTP 401/);
  });

  it("forwards the abort signal", async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(jsonBody(CATALOG));
    await fetchRunInfraModels("k", controller.signal);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe("createRunInfraProvider().refreshModels", () => {
  function makeContext(overrides: Partial<RefreshModelsContext> = {}) {
    const publications: ModelsPublication[] = [];
    const ctx: RefreshModelsContext = {
      credential: { type: "api_key", key: "test-key" },
      publish: async (publication) => {
        publications.push(publication);
        publication.update?.();
        return true;
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      ...overrides,
    };
    return { ctx, publications };
  }

  it("fetches and publishes models when a key is present", async () => {
    mockFetch.mockResolvedValueOnce(jsonBody(CATALOG));
    const provider = createRunInfraProvider();
    const { ctx, publications } = makeContext();

    await provider.refreshModels!(ctx);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(provider.getModels()).toHaveLength(1);
    expect(provider.getModels()[0].id).toBe("deepseek-v4-flash");
    // Catalog persistence and the in-memory update use the same publication.
    expect(publications[0].persist?.models).toHaveLength(1);
    expect(publications[0].update).toBeTypeOf("function");
  });

  it("does not hit the network when not logged in", async () => {
    const provider = createRunInfraProvider();
    const { ctx } = makeContext({ credential: undefined });

    await provider.refreshModels!(ctx);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("preserves the cached catalog when not logged in", async () => {
    const provider = createRunInfraProvider();
    const { ctx } = makeContext({
      credential: undefined,
      stored: { models: toPiModels(CATALOG), checkedAt: 1 },
    });

    await provider.refreshModels!(ctx);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(provider.getModels().map((m) => m.id)).toEqual([
      "deepseek-v4-flash",
    ]);
  });

  it("restores the cached catalog without fetching when offline", async () => {
    const provider = createRunInfraProvider();
    const { ctx, publications } = makeContext({
      allowNetwork: false,
      stored: { models: toPiModels(CATALOG), checkedAt: 1 },
    });

    await provider.refreshModels!(ctx);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(provider.getModels().map((m) => m.id)).toEqual([
      "deepseek-v4-flash",
    ]);
    expect(
      publications.every((publication) => publication.persist === undefined),
    ).toBe(true);
  });

  it("keeps the cached catalog when fetching fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network unavailable"));
    const provider = createRunInfraProvider();
    const { ctx, publications } = makeContext({
      stored: { models: toPiModels(CATALOG), checkedAt: 1 },
    });

    await expect(provider.refreshModels!(ctx)).rejects.toThrow(
      "network unavailable",
    );

    expect(provider.getModels().map((m) => m.id)).toEqual([
      "deepseek-v4-flash",
    ]);
    expect(
      publications.every((publication) => publication.persist === undefined),
    ).toBe(true);
  });

  it("does not fetch or publish a new catalog when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createRunInfraProvider();
    const { ctx, publications } = makeContext({ signal: controller.signal });

    await provider.refreshModels!(ctx);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(publications).toEqual([]);
  });
});

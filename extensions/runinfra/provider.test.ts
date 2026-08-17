import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRunInfraProvider, fetchRunInfraModels } from "./provider";
import type { RunInfraModelsResponse } from "./models";

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
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(init.method).toBe("GET");
  });

  it("throws a descriptive error on non-2xx responses", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonBody({ error: { message: "Invalid API key", code: "auth_error" } }, false, 401, "Unauthorized"),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeContext(overrides: Record<string, any> = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const written: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = {
      credential: { type: "api_key", key: "test-key" },
      store: {
        read: async () => overrides.stored ?? undefined,
        write: async (entry: unknown) => {
          written.push(entry);
        },
        delete: async () => {},
      },
      allowNetwork: true,
      signal: undefined,
      ...overrides,
    };
    return { ctx, written };
  }

  it("fetches and publishes models when a key is present", async () => {
    mockFetch.mockResolvedValueOnce(jsonBody(CATALOG));
    const provider = createRunInfraProvider();
    const { ctx, written } = makeContext();

    await provider.refreshModels!(ctx);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(provider.getModels()).toHaveLength(1);
    expect(provider.getModels()[0].id).toBe("deepseek-v4-flash");
    // Persisted to the models store.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((written[0] as any).models).toHaveLength(1);
  });

  it("does not hit the network when not logged in", async () => {
    const provider = createRunInfraProvider();
    const { ctx } = makeContext({ credential: undefined });

    await provider.refreshModels!(ctx);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("preserves the cached catalog when not logged in", async () => {
    const cached = { id: "deepseek-v4-flash", provider: "runinfra" };
    const provider = createRunInfraProvider();
    const { ctx } = makeContext({ credential: undefined, stored: { models: [cached], checkedAt: 1 } });

    await provider.refreshModels!(ctx);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(provider.getModels().map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
  });

  it("restores the cached catalog without fetching when offline", async () => {
    const cached = { id: "deepseek-v4-flash", provider: "runinfra" };
    const provider = createRunInfraProvider();
    const { ctx } = makeContext({ allowNetwork: false, stored: { models: [cached], checkedAt: 1 } });

    await provider.refreshModels!(ctx);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(provider.getModels().map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
  });
});

import { describe, it, expect } from "vitest";
import {
  RUNINFRA_BASE_URL,
  RUNINFRA_PROVIDER_ID,
  toPiModel,
  toPiModels,
  type RunInfraModelInfo,
  type RunInfraModelsResponse,
} from "./models";

/**
 * Shape mirrors the live `GET /v1/models` response (see the RunInfer API
 * reference). Values below are taken from a real catalog snapshot.
 */
const CATALOG: RunInfraModelsResponse = {
  object: "list",
  data: [
    {
      id: "deepseek-v4-flash",
      object: "model",
      owned_by: "runinfra",
      created: 1785679270,
      availability: "available",
      max_request_bytes: 3670016,
      max_output_tokens: 32768,
      context_window: 1048576,
      context_length: 1048576,
      pricing: { input: 0.13, output: 0.27 },
      cached_input_price_usd_per_mtok: 0.01,
      max_concurrent_requests_per_api_key: 16,
      max_tokens_per_minute_per_workspace: 4000000,
    },
    {
      id: "qwen3-8-2-4t-a95b",
      availability: "available",
      max_output_tokens: 32768,
      context_window: 262144,
      pricing: { input: 2, output: 6 },
      cached_input_price_usd_per_mtok: 0.2,
    },
    {
      // A model not in the hand-maintained thinking table.
      id: "some-future-model",
      availability: "available",
      pricing: { input: 1, output: 2 },
    },
    // Malformed entry (no id) must be dropped.
    { object: "model" } as unknown as RunInfraModelInfo,
  ],
};

describe("toPiModels", () => {
  it("maps catalog entries to pi models using API-provided limits and pricing", () => {
    const models = toPiModels(CATALOG);
    expect(models).toHaveLength(3); // malformed entry filtered

    const flash = models.find((m) => m.id === "deepseek-v4-flash");
    expect(flash).toMatchObject({
      id: "deepseek-v4-flash",
      name: "deepseek-v4-flash",
      api: "openai-completions",
      provider: RUNINFRA_PROVIDER_ID,
      baseUrl: RUNINFRA_BASE_URL,
      reasoning: true,
      input: ["text"],
      contextWindow: 1048576,
      maxTokens: 32768,
    });
    expect(flash?.cost).toEqual({ input: 0.13, output: 0.27, cacheRead: 0.01, cacheWrite: 0.13 });
    expect(flash?.thinkingLevelMap?.off).toBe("none");
  });

  it("applies provider-level OpenAI compat settings", () => {
    const [flash] = toPiModels(CATALOG);
    expect(flash?.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: "openai",
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
    });
  });

  it("marks models that refuse to disable reasoning", () => {
    const qwen = toPiModels(CATALOG).find((m) => m.id === "qwen3-8-2-4t-a95b");
    expect(qwen?.thinkingLevelMap?.off).toBeNull();
    expect(qwen?.contextWindow).toBe(262144);
    expect(qwen?.cost).toEqual({ input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2 });
  });

  it("uses safe defaults for unknown models", () => {
    const future = toPiModels(CATALOG).find((m) => m.id === "some-future-model");
    expect(future?.reasoning).toBe(true);
    expect(future?.thinkingLevelMap).toBeUndefined();
    expect(future?.contextWindow).toBe(131072); // fallback
    expect(future?.maxTokens).toBe(32768); // fallback
  });

  it("keeps paused models in the list", () => {
    const models = toPiModels({
      data: [{ id: "paused-model", availability: "paused", context_window: 4096 }],
    });
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("paused-model");
  });
});

describe("toPiModel cost fallbacks", () => {
  it("bills cache reads/writes at the input rate when no cache price is published", () => {
    const model = toPiModel({ id: "x", pricing: { input: 0.5, output: 1 } });
    expect(model.cost.cacheRead).toBe(0.5);
    expect(model.cost.cacheWrite).toBe(0.5);
  });

  it("zeroes cost when pricing is absent", () => {
    const model = toPiModel({ id: "y" });
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("falls back to context_length when context_window is absent", () => {
    const model = toPiModel({ id: "z", context_length: 55555 });
    expect(model.contextWindow).toBe(55555);
  });
});

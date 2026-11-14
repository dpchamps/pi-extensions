import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  cacheLifetimeMs,
  compactionDelayMs,
  resolveCacheLifetime,
} from "./cache.js";

function openai(id = "gpt-6.1-sol"): Model<any> {
  return {
    id,
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  } as Model<any>;
}

function codex(id = "gpt-6.1-sol"): Model<any> {
  return {
    ...openai(id),
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  };
}

describe("cache defaults", () => {
  it.each([
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6.1-sol-2026-10-01",
  ])(
    "uses a 30-minute default for %s, on both direct and Codex endpoints",
    (id) => {
      expect(resolveCacheLifetime(openai(id), {}, "short")).toEqual({
        ttlMs: 1_800_000,
        source: "OpenAI default",
      });
      expect(resolveCacheLifetime(codex(id), {}, "short")).toEqual({
        ttlMs: 1_800_000,
        source: "Codex default (estimate)",
      });
      expect(compactionDelayMs(cacheLifetimeMs(codex(id), {})!)).toBe(
        1_740_000,
      );
    },
  );

  it.each([
    "gpt-5",
    "gpt-5-codex",
    "gpt-5.1-codex-max",
    "gpt-5.2",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
  ])("uses a 30-minute default for older %s", (id) => {
    expect(cacheLifetimeMs(openai(id), {})).toBe(1_800_000);
    expect(cacheLifetimeMs(codex(id), {})).toBe(1_800_000);
  });

  it("honors actual API retention without treating a 24h upper bound as a TTL", () => {
    expect(
      cacheLifetimeMs(openai(), { prompt_cache_options: { ttl: "12h" } }),
    ).toBe(43_200_000);
    expect(
      cacheLifetimeMs(openai(), { prompt_cache_options: { ttl: "30m" } }),
    ).toBe(1_800_000);
    expect(
      cacheLifetimeMs(openai("gpt-5.4"), { prompt_cache_retention: "24h" }),
    ).toBe(1_800_000);
    expect(
      cacheLifetimeMs(openai("gpt-5.4"), {
        prompt_cache_retention: "in_memory",
      }),
    ).toBe(300_000);
    // An environment tier does not prove the provider actually requested 12h.
    expect(cacheLifetimeMs(openai(), {}, "long")).toBe(1_800_000);
    expect(cacheLifetimeMs(codex(), {}, "long")).toBe(1_800_000);
    expect(cacheLifetimeMs(codex("gpt-5.3-codex"), {}, "long")).toBe(1_800_000);
  });

  it("prioritizes catalog/override metadata per tier without mutating the model", () => {
    const model = { ...codex(), promptCache: { short: 600 } };
    const before = structuredClone(model);
    expect(resolveCacheLifetime(model, {}, "short")).toEqual({
      ttlMs: 600_000,
      source: "model metadata",
    });
    expect(resolveCacheLifetime(model, {}, "long")).toEqual({
      ttlMs: 1_800_000,
      source: "Codex default (estimate)",
    });
    expect(model).toEqual(before);
    const api = { ...openai(), promptCache: { long: 900 } };
    expect(
      resolveCacheLifetime(api, { prompt_cache_options: { ttl: "12h" } }),
    ).toEqual({ ttlMs: 900_000, source: "model metadata" });
  });

  it.each([0, -1, NaN, Infinity, Number.MAX_VALUE])(
    "does not hide invalid explicit metadata (%s) with a fallback",
    (short) => {
      expect(
        cacheLifetimeMs({ ...codex(), promptCache: { short } }, {}, "short"),
      ).toBeUndefined();
    },
  );

  it.each([
    { provider: "openrouter" },
    { provider: "azure" },
    { provider: "custom" },
    { baseUrl: "https://proxy.example/v1" },
    { baseUrl: "https://api.openai.com.evil.example/v1" },
    { baseUrl: "http://api.openai.com/v1" },
    { baseUrl: "https://api.openai.com:8443/v1" },
    { baseUrl: "https://api.openai.com/other-api" },
    { baseUrl: "https://user:secret@api.openai.com/v1" },
    { baseUrl: "https://api.openai.com/v1?upstream=elsewhere" },
    { baseUrl: "not a URL" },
  ])(
    "uses a generic estimate rather than OpenAI policy for %j",
    (overrides) => {
      expect(
        resolveCacheLifetime(
          { ...openai(), ...overrides },
          { prompt_cache_options: { ttl: "12h" } },
        ),
      ).toEqual({ ttlMs: 1_800_000, source: "default (estimate)" });
    },
  );

  it.each([
    { provider: "custom" },
    { api: "openai-responses" },
    { baseUrl: "https://proxy.example/backend-api" },
    { baseUrl: "https://chatgpt.com.evil.example/backend-api" },
    { baseUrl: "https://chatgpt.com/other-api" },
  ])("uses a generic estimate rather than Codex policy for %j", (overrides) => {
    expect(resolveCacheLifetime({ ...codex(), ...overrides }, {})).toEqual({
      ttlMs: 1_800_000,
      source: "default (estimate)",
    });
  });

  it.each([
    "gpt-4.1",
    "gpt-50",
    "gpt-7",
    "gpt-6.1.2",
    "gpt-6fake",
    "chat-latest",
    "some-future-model",
  ])("does not infer a model family from %s", (id) => {
    for (const model of [openai(id), codex(id)]) {
      expect(resolveCacheLifetime(model, {})).toEqual({
        ttlMs: 1_800_000,
        source: "default (estimate)",
      });
    }
  });

  it.each(["short", "long"])(
    "uses a 30-minute estimate for DeepSeek's missing %s tier",
    (tier) => {
      const model = {
        ...openai("deepseek-chat"),
        provider: "deepseek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
      } as Model<any>;
      expect(resolveCacheLifetime(model, {}, tier)).toEqual({
        ttlMs: 1_800_000,
        source: "default (estimate)",
      });
      expect(compactionDelayMs(cacheLifetimeMs(model, {}, tier)!)).toBe(
        1_740_000,
      );
      expect(
        resolveCacheLifetime(
          { ...model, promptCache: { short: 600 } },
          {},
          "short",
        ),
      ).toEqual({ ttlMs: 600_000, source: "model metadata" });
      expect(
        resolveCacheLifetime(
          { ...model, promptCache: { short: 0 } },
          {},
          "short",
        ),
      ).toBeUndefined();
      expect(
        resolveCacheLifetime(model, {
          prompt_cache_options: { mode: "explicit" },
        }),
      ).toBeUndefined();
    },
  );

  it("still allows explicit metadata for proxies and custom models", () => {
    expect(
      resolveCacheLifetime(
        {
          ...codex("custom"),
          baseUrl: "https://proxy.example",
          promptCache: { short: 120 },
        },
        {},
      ),
    ).toEqual({
      ttlMs: 120_000,
      source: "model metadata",
    });
  });

  it("skips cache-disabled requests even when a fallback or metadata is available", () => {
    const payload = { prompt_cache_options: { mode: "explicit" } };
    expect(cacheLifetimeMs(codex(), payload)).toBeUndefined();
    expect(cacheLifetimeMs(openai(), payload)).toBeUndefined();
    expect(
      cacheLifetimeMs({ ...openai(), promptCache: { short: 300 } }, payload),
    ).toBeUndefined();
  });

  it("does not silently accept an unknown API retention duration", () => {
    expect(
      cacheLifetimeMs(openai(), { prompt_cache_options: { ttl: "1h" } }),
    ).toBeUndefined();
    expect(
      cacheLifetimeMs(openai("gpt-5.4"), {
        prompt_cache_options: { ttl: "12h" },
      }),
    ).toBeUndefined();
  });

  it("accepts the built-in endpoint's trailing slash and normalized Codex URLs", () => {
    expect(
      cacheLifetimeMs(
        { ...openai(), baseUrl: "https://api.openai.com/v1/" },
        {},
      ),
    ).toBe(1_800_000);
    expect(
      cacheLifetimeMs(
        {
          ...codex(),
          baseUrl: "https://chatgpt.com/backend-api/codex/responses",
        },
        {},
      ),
    ).toBe(1_800_000);
  });
});

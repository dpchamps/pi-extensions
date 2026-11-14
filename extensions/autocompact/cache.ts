import process from "node:process";
import type { Model } from "@earendil-works/pi-ai";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

export interface CacheLifetime {
  ttlMs: number;
  source:
    | "model metadata"
    | "OpenAI default"
    | "Codex default (estimate)"
    | "default (estimate)";
}

const DEFAULT_LIFETIME: CacheLifetime = {
  ttlMs: 30 * 60 * 1000,
  source: "default (estimate)",
};

/** Local scheduling policy, not a provider cache-retention guarantee.
 * Explicit direct OpenAI retention is scoped to recognized models/endpoints:
 * https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime
 */
function defaultCacheLifetime(
  model: Model<any>,
  body: RecordValue | undefined,
): CacheLifetime | undefined {
  const generation = /^gpt-(5|6)(?:\.(\d+))?(?:-|$)/.exec(model.id);
  if (!generation) return DEFAULT_LIFETIME;
  let url: URL;
  try {
    url = new URL(model.baseUrl);
  } catch {
    return DEFAULT_LIFETIME;
  }
  if (url.username || url.password || url.search || url.hash)
    return DEFAULT_LIFETIME;
  const path = url.pathname.replace(/\/+$/, "");
  const codex =
    model.provider === "openai-codex" &&
    model.api === "openai-codex-responses" &&
    url.origin === "https://chatgpt.com" &&
    [
      "/backend-api",
      "/backend-api/codex",
      "/backend-api/codex/responses",
    ].includes(path);
  const openai =
    model.provider === "openai" &&
    ["openai-responses", "openai-completions"].includes(model.api) &&
    url.origin === "https://api.openai.com" &&
    path === "/v1";
  if (!codex && !openai) return DEFAULT_LIFETIME;

  const major = Number(generation[1]);
  const minor = Number(generation[2] ?? 0);
  const modern = major === 6 || minor >= 6;
  let seconds = DEFAULT_LIFETIME.ttlMs / 1000;
  if (openai) {
    const ttl = record(body?.prompt_cache_options)?.ttl;
    if (ttl !== undefined) {
      if (!modern || (ttl !== "30m" && ttl !== "12h")) return undefined;
      seconds = ttl === "12h" ? 43_200 : 1800;
    } else if (body?.prompt_cache_retention === "24h" && !modern) {
      // "24h" is an upper retention bound, not a guaranteed 24-hour TTL.
      seconds = 1800;
    } else if (body?.prompt_cache_retention === "in_memory" && !modern) {
      seconds = 300;
    }
  }
  // Codex does not send a retention duration. In particular, PI_CACHE_RETENTION
  // alone must not turn its estimate into a 12-hour or 24-hour clock.
  return {
    ttlMs: seconds * 1000,
    source: codex ? "Codex default (estimate)" : "OpenAI default",
  };
}

/** Declared metadata takes precedence; missing tiers use a 30-minute estimate. */
export function resolveCacheLifetime(
  model: Model<any>,
  payload: unknown,
  defaultRetention = process.env.PI_CACHE_RETENTION,
): CacheLifetime | undefined {
  const body = record(payload);
  const options = record(body?.prompt_cache_options);
  // OpenAI explicit mode without breakpoints is Pi's cacheRetention: "none".
  if (options?.mode === "explicit") return undefined;
  let tier: "short" | "long" = defaultRetention === "long" ? "long" : "short";
  if (body?.prompt_cache_retention === "in_memory") tier = "short";
  if (body?.prompt_cache_retention === "24h") tier = "long";
  if (options?.ttl === "30m") tier = "short";
  if (options?.ttl === "12h") tier = "long";

  // Anthropic: a trailing short-lived breakpoint is the conservative boundary
  // when one request mixes 5m and 1h cache entries.
  const controls: RecordValue[] = [];
  const collect = (value: unknown) => {
    const control = record(record(value)?.cache_control);
    if (control) controls.push(control);
  };
  collect(body);
  for (const key of ["tools", "system", "messages"]) {
    const blocks = body?.[key];
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      collect(block);
      const content = record(block)?.content;
      if (Array.isArray(content)) content.forEach(collect);
    }
  }
  if (controls.length) {
    tier = controls.every((control) => control.ttl === "1h") ? "long" : "short";
  }
  if (model.api === "anthropic-messages" && controls.length === 0)
    return undefined;
  const seconds = model.promptCache?.[tier];
  if (seconds === undefined) return defaultCacheLifetime(model, body);
  const milliseconds = typeof seconds === "number" ? seconds * 1000 : NaN;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? { ttlMs: milliseconds, source: "model metadata" }
    : undefined;
}

/** Numeric convenience for callers that do not need the policy's provenance. */
export function cacheLifetimeMs(
  model: Model<any>,
  payload: unknown,
  defaultRetention = process.env.PI_CACHE_RETENTION,
): number | undefined {
  return resolveCacheLifetime(model, payload, defaultRetention)?.ttlMs;
}

/** Start early enough to leave 10% headroom (at least 10s, at most 60s). */
export function compactionDelayMs(ttlMs: number): number | undefined {
  const margin = Math.max(10_000, Math.min(60_000, ttlMs * 0.1));
  return ttlMs > margin ? ttlMs - margin : undefined;
}

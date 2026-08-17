import type { Model, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai/compat";

/** Stable provider id used across pi (login, /model, models-store.json). */
export const RUNINFRA_PROVIDER_ID = "runinfra";
/** OpenAI-compatible base URL for the RunInfer Model APIs. */
export const RUNINFRA_BASE_URL = "https://api.runinfra.ai/v1";

// Safety-net fallbacks only. Every value below is taken from the live
// `GET /v1/models` response when present; these apply only if a field is
// absent for a given model.
const FALLBACK_CONTEXT_WINDOW = 131_072;
const FALLBACK_MAX_TOKENS = 32_768;

/**
 * Per-model thinking/reasoning behavior. RunInfer's `GET /v1/models` does not
 * publish capabilities, so this small table is maintained by hand (it changes
 * far less often than the catalog it overlays).
 *
 *  - `reasoning`: mark the model as a reasoning model so pi offers thinking
 *    levels. All current RunInfer models accept `reasoning_effort`, so default
 *    is `true`.
 *  - `thinkingLevelMap.off`: what pi sends for the `off` thinking level.
 *      - `"none"`  -> send `reasoning_effort:"none"` (model supports disabling
 *        reasoning; verified against the live API).
 *      - `null`    -> mark `off` as unsupported so pi never sends `none` (the
 *        model rejects disabling thinking with a 400).
 *      - omitted   -> `off` sends no `reasoning_effort` (model default applies).
 *    Unknown models fall back to `DEFAULT_THINKING` (safe: `off` sends nothing).
 */
interface ThinkingMeta {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

const THINKING: Record<string, ThinkingMeta> = {
  "deepseek-v4-flash": { reasoning: true, thinkingLevelMap: { off: "none" } },
  // "already off" by default; sending no effort keeps it off, sending one turns it on.
  "deepseek-v4-pro": { reasoning: true },
  "qwen3-8-27b": { reasoning: true, thinkingLevelMap: { off: "none" } },
  // Refuses `reasoning_effort:"none"` with "Disabling thinking is not supported".
  "qwen3-8-2-4t-a95b": { reasoning: true, thinkingLevelMap: { off: null } },
  "nemotron-3-5-lightning-30b": { reasoning: true, thinkingLevelMap: { off: "none" } },
};

const DEFAULT_THINKING: ThinkingMeta = { reasoning: true };

/** One entry from `GET /v1/models` -> `data[]`. */
export interface RunInfraModelInfo {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  availability?: "available" | "paused" | (string & {});
  max_request_bytes?: number;
  max_output_tokens?: number;
  context_window?: number;
  context_length?: number;
  pricing?: { input?: number; output?: number };
  cached_input_price_usd_per_mtok?: number;
  max_concurrent_requests_per_api_key?: number;
  max_tokens_per_minute_per_workspace?: number;
  paused_until?: string;
}

export interface RunInfraModelsResponse {
  object?: string;
  data?: RunInfraModelInfo[];
}

/**
 * Provider-level OpenAI-compat settings for the RunInfer gateway. These describe
 * how to talk to the API (a fixed contract), not per-model data.
 */
function runInfraCompat(): OpenAICompletionsCompat {
  return {
    // Gateway is a generic OpenAI-compatible proxy: use the `system` role.
    supportsDeveloperRole: false,
    // RunInfer honors `reasoning_effort` (the one spelled it accepts).
    supportsReasoningEffort: true,
    thinkingFormat: "openai",
    // RunInfer checks `max_tokens`; it also accepts `max_completion_tokens`.
    maxTokensField: "max_tokens",
    // Gateway always computes usage upstream; opt in to client-visible usage.
    supportsUsageInStreaming: true,
    // Don't emit `strict` on tool schemas; some upstream models reject it.
    supportsStrictMode: false,
  };
}

/** Map a live `/v1/models` entry to a pi model. All limits/pricing from the API. */
export function toPiModel(info: RunInfraModelInfo): Model<"openai-completions"> {
  const meta = THINKING[info.id] ?? DEFAULT_THINKING;
  const inputPrice = info.pricing?.input ?? 0;
  const model: Model<"openai-completions"> = {
    id: info.id,
    name: info.id,
    api: "openai-completions",
    provider: RUNINFRA_PROVIDER_ID,
    baseUrl: RUNINFRA_BASE_URL,
    reasoning: meta.reasoning,
    input: ["text"],
    cost: {
      input: inputPrice,
      output: info.pricing?.output ?? 0,
      // Discounted cache-read price when published, else cache reads bill at input rate.
      cacheRead: info.cached_input_price_usd_per_mtok ?? inputPrice,
      // No separate cache-write price is published; estimate at the input rate.
      cacheWrite: inputPrice,
    },
    contextWindow: info.context_window ?? info.context_length ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: info.max_output_tokens ?? FALLBACK_MAX_TOKENS,
    compat: runInfraCompat(),
  };
  if (meta.thinkingLevelMap) {
    model.thinkingLevelMap = meta.thinkingLevelMap;
  }
  return model;
}

/** Map the full `/v1/models` payload to pi models (keeps paused models listed). */
export function toPiModels(response: RunInfraModelsResponse): Model<"openai-completions">[] {
  const data = response.data ?? [];
  return data
    .filter((entry) => typeof entry?.id === "string" && entry.id.length > 0)
    .map(toPiModel);
}

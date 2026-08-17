import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import {
  RUNINFRA_BASE_URL,
  RUNINFRA_PROVIDER_ID,
  toPiModels,
  type RunInfraModelsResponse,
} from "./models.js";

const MODELS_PATH = "/models";

/**
 * Fetch the live model catalog from `GET {base}/models` using a workspace key.
 * Throws on any non-2xx so the caller (model refresh) can surface/cache it.
 */
export async function fetchRunInfraModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<RunInfraModelsResponse> {
  const response = await fetch(`${RUNINFRA_BASE_URL}${MODELS_PATH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? ` — ${body.slice(0, 300)}` : "";
    throw new Error(
      `RunInfer model list failed: HTTP ${response.status} ${response.statusText}${detail}`.trim(),
    );
  }
  return (await response.json()) as RunInfraModelsResponse;
}

/**
 * Build the RunInfer provider:
 *  - `/login` prompts for a workspace API key (stored via pi's credential store).
 *  - `fetchModels` pulls the live catalog on each model refresh, using the
 *    effective credential, and pi persists it to `models-store.json`.
 *  - Streaming uses pi's OpenAI-completions implementation against the
 *    OpenAI-compatible `chat/completions` endpoint.
 */
export function createRunInfraProvider() {
  return createProvider({
    id: RUNINFRA_PROVIDER_ID,
    name: "RunInfer",
    baseUrl: RUNINFRA_BASE_URL,
    auth: {
      apiKey: {
        name: "RunInfer workspace API key",
        login: async (interaction) => {
          interaction.notify({
            type: "info",
            message:
              "RunInfer hosts open-weight models behind an OpenAI-compatible API. " +
              "Create a workspace API key to continue (new accounts include $1 of credit).",
            links: [{ url: "https://runinfra.ai" }],
          });
          const key = (
            await interaction.prompt({
              type: "secret",
              message: "Enter your RunInfer workspace API key",
              placeholder: "rp_...",
            })
          )?.trim();
          if (!key) {
            throw new Error("RunInfer workspace API key is required");
          }
          return { type: "api_key", key };
        },
        check: async ({ credential }) =>
          credential?.key ? { type: "api_key", source: "stored credential" } : undefined,
        resolve: async ({ credential }) =>
          credential?.key
            ? {
                auth: { apiKey: credential.key },
                env: credential.env,
                source: "stored credential",
              }
            : undefined,
      },
    },
    // Purely dynamic: the catalog is populated by fetchModels from the API.
    models: [],
    fetchModels: async (context: RefreshModelsContext) => {
      if (!context.allowNetwork || context.signal?.aborted) {
        return [];
      }
      const credential = context.credential;
      const key = credential?.type === "api_key" ? credential.key : undefined;
      if (!key) {
        // Not logged in yet; keep the cached catalog (if any) instead of wiping it.
        const stored = await context.store.read();
        return stored?.models ?? [];
      }
      const response = await fetchRunInfraModels(key, context.signal);
      if (context.signal?.aborted) {
        return [];
      }
      return toPiModels(response);
    },
    api: openAICompletionsApi(),
  });
}

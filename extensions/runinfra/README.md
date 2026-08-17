# runinfra

A [pi](https://github.com/earendil-works/pi) provider extension for
[RunInfer](https://runinfra.ai) — hosted open-weight models behind an
OpenAI-compatible API.

The model catalog is **pulled live** from RunInfer's
[`GET /v1/models`](https://runinfra.ai/docs/api-reference/models) endpoint.
Context windows, output limits, and pricing come straight from the API, so
new models (and price/window changes) show up without any code change.

## Setup

1. Get a workspace API key at <https://runinfra.ai> (new accounts include
   $1 of credit).
2. In pi, run:

   ```
   /login runinfra
   ```

   and paste your key. It is stored in pi's credential store
   (`~/.pi/agent/auth.json`), the same as any other provider.
3. RunInfer's models now appear in `/model` (e.g. `runinfra/deepseek-v4-flash`).

To remove the key again: `/logout runinfra`.

## How it works

- `pi.registerProvider(...)` registers a dynamic provider (`id: "runinfra"`).
- On every model refresh pi calls the provider's `refreshModels` with the
  effective credential; this extension fetches `GET /v1/models` with
  `Authorization: Bearer <key>` and maps each entry to a pi model.
- pi persists the fetched catalog to `~/.pi/agent/models-store.json`, so
  models are still listed (from cache) if the API is briefly unreachable.
- Streaming uses pi's built-in OpenAI-completions implementation against
  `POST /v1/chat/completions`.

### What is fetched vs. maintained by hand

| Field                  | Source                                    |
| ---------------------- | ----------------------------------------- |
| model list             | `GET /v1/models`                          |
| `contextWindow`        | `context_window` (fallback 128K)          |
| `maxTokens`            | `max_output_tokens` (fallback 32K)        |
| `cost.input/output`    | `pricing.input` / `pricing.output`        |
| `cost.cacheRead`       | `cached_input_price_usd_per_mtok` (else input rate) |
| `cost.cacheWrite`      | estimated at the input rate               |
| `reasoning` / thinking map | hand-maintained per model (see below)  |

RunInfer's `/v1/models` does not publish per-model capabilities, so the
`reasoning` flag and the `off` thinking-level behavior are kept in a small
table in [`models.ts`](./models.ts):

- `off: "none"` — model accepts `reasoning_effort: "none"` (reasoning can be
  disabled).
- `off: null` — model refuses to disable thinking, so `off` is not offered
  (e.g. `qwen3-8-2-4t-a95b`).
- omitted — `off` sends no `reasoning_effort` (the model default applies).

Unknown models default to `reasoning: true` with no `off` override, which is
safe: turning thinking off simply sends no `reasoning_effort`.

## Notes

- Paused models stay listed (per RunInfer's guidance); calling one returns a
  `503` with a `Retry-After` until it returns.
- pi's cost column is an estimate from the API pricing; RunInfer bills your
  workspace balance directly.

## Development

```bash
cd extensions/runinfra
npx tsc --noEmit   # typecheck
npx vitest run     # tests
```

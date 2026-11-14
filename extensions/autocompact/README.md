# autocompact

Opt-in **idle** compaction before the active model's prompt cache expires. This is separate from Pi's built-in context-size-triggered compaction; it does not change that setting.

```
/autocompact on       # enable for this session
/autocompact off      # disable for this session
/autocompact status   # show the selected compactor and timer / waiting reason
/autocompact          # same as status
```

Defaults to **off**. Explicit on/off choices are saved as non-context session metadata and survive resume and `/reload`. They apply across `/tree` navigation but **do not carry into a fork or new session**. Turning it on can make paid model requests while you are away.

## Always enable

Add to `~/.pi/agent/settings.json` (or `PI_CODING_AGENT_DIR/settings.json`), or a trusted project's `.pi/settings.json`:

```json
{
  "autocompact": { "enabled": true }
}
```

`"autocompact": true` also works. Pi merges user/project settings and enforces project trust. `/autocompact off` overrides the configured default for that session without changing any config files. Reload to pick up config-file changes; an explicit session choice still takes precedence.

## Cache lifetimes

Newer OpenAI/ChatGPT models work **without manual TTL setup**. When the requested `promptCache` tier is missing, the extension supplies these local scheduling defaults:

| Models / request                                                                       | Assumed cache lifetime                 | Compact after  |
| -------------------------------------------------------------------------------------- | -------------------------------------- | -------------- |
| GPT-5.6 and GPT-6.x, including **GPT-6.1 Sol**, on `openai` or `openai-codex`          | **30 minutes**                         | **29 minutes** |
| GPT-5.5 / GPT-5.5 Pro on those providers                                               | 30 minutes                             | 29 minutes     |
| Older GPT-5.x / Codex models                                                           | 5 minutes                              | 4m30s          |
| Direct OpenAI API with explicit `prompt_cache_options.ttl: "12h"` on GPT-5.6 / GPT-6.x | 12 hours                               | 11h59m         |
| Older direct OpenAI API models explicitly requesting `prompt_cache_retention: "24h"`   | 30 minutes (not a guaranteed 24 hours) | 29 minutes     |

These are **extension defaults, not metadata supplied by the catalog**. The API values follow [OpenAI's prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime): GPT-5.6+ has a 30-minute default; earlier in-memory entries typically survive 5–10 minutes, and extended retention typically survives around 30 minutes, up to 24 hours.

**ChatGPT/Codex caveat:** the guide documents the public API, not a separate retention guarantee for ChatGPT subscription access. `openai-codex` uses the model-family values above as **best-effort scheduling estimates**, labeled `Codex default (estimate)` in `/autocompact status`. It does not claim a guaranteed eviction time. `PI_CACHE_RETENTION=long` alone does not extend this estimate, since Pi's Codex adapter does not send a retention duration.

Defaults apply only to recognized GPT-5/6 model families on Pi's direct `https://api.openai.com/v1` or `https://chatgpt.com/backend-api` providers. They are not automatically applied to OpenRouter, Azure, custom providers, proxy URLs, unknown aliases, or other model families.

A declared positive `promptCache.short` or `promptCache.long` lifetime **in seconds** takes precedence for that tier. This includes catalog metadata and your `modelOverrides`. An omitted tier may use a built-in fallback; an explicitly invalid value is not silently replaced. The extension never modifies the catalog or your model configuration. `/autocompact status` reports whether it used model metadata, an OpenAI default, or a Codex estimate.

For unsupported endpoints/models, or to override a default, use Pi's existing `modelOverrides` in `~/.pi/agent/models.json`. For example, for your ChatGPT/Codex model:

```json
{
  "providers": {
    "openai-codex": {
      "modelOverrides": {
        "gpt-6.1-sol": {
          "promptCache": { "short": 1800 }
        }
      }
    }
  }
}
```

This example is optional: it repeats the built-in GPT-6.1 Sol estimate. Use the actual model/provider ID and a lifetime appropriate to **that endpoint**. For a documented range, choose its conservative lower end. Without metadata or an applicable default, autocompact stays enabled but waits; `/autocompact status` explains why.

The extension reads the outgoing payload's retention settings when present, otherwise `PI_CACHE_RETENTION` (`long` or the default `short`). Cache-disabled OpenAI explicit-only requests are skipped. Mixed Anthropic breakpoints use the shorter tier.

## Behavior and safeguards

- Time is measured from **request submission**, not response completion. It starts compaction with 10% headroom (at least 10 seconds, at most 60 seconds). A 5-minute cache triggers after **4m30s**. This starts the compaction request before expiry; it cannot guarantee completion before expiry or a cache hit. Native Pi summaries use a different prompt and may not reuse the original cache.
- Runs only after a successful model response and final agent settlement. Never interrupts streaming, tools, pending messages, existing compaction, or blocking extension dialogs. Activity replaces the timer; switching models or branches disarms it until the next request.
- Uses the registered **extension** command `/clm-compact` when available, dispatched through Pi's command pipeline. Otherwise uses `ctx.compact()`, the public API equivalent of `/compact`. It does not send the literal `/compact` text to a model.
- CLM must itself be enabled. If its command refuses to start, the extension does not fall back to destructive native compaction or repeatedly retry.
- Compacts **once per idle period**. Its own CLM model/tool turns never rearm the timer. Failures also consume that attempt. A fresh normal run can arm another attempt.
- Idle cache warming is stopped while autocompact is enabled, avoiding competing paid idle policies. Streaming warming is left alone.
- Reload/resume restores consent, **not an inferred old cache**: a fresh model request is required to start a new timer. If the cache expires while Pi is busy or the computer is asleep, the stale timer is discarded instead of making an unexpected cold compaction request.
- Timers are unreferenced and cleaned up on shutdown, reload, and session replacement. Nothing is scheduled merely by loading the extension.

## Development

```bash
npx tsc --noEmit -p extensions/autocompact/tsconfig.json
npx vitest run extensions/autocompact tests/autocompact.test.ts
```

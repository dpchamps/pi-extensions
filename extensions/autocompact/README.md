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

**Any model without a configured lifetime for the active `promptCache` tier uses a 30-minute fallback**, including DeepSeek, older GPT/Codex models, OpenRouter, Azure, custom providers, proxies, and unknown model aliases. With the safety margin, idle compaction starts after **29 minutes** from request submission.

This is an **arbitrary local scheduling estimate, not a provider cache-retention guarantee**. A provider's cache may expire earlier, so compaction can incur a cold request. `/autocompact status` labels the generic fallback `default (estimate)`; recognized direct OpenAI and ChatGPT/Codex models retain the `OpenAI default` and `Codex default (estimate)` labels.

Explicit retention settings on recognized direct OpenAI GPT-5/6 endpoints still take precedence over the fallback when metadata is missing:

| Request                                                | Assumed cache lifetime                 | Compact after |
| ------------------------------------------------------ | -------------------------------------- | ------------- |
| `prompt_cache_options.ttl: "12h"` on GPT-5.6 / GPT-6.x | 12 hours                               | 11h59m        |
| `prompt_cache_options.ttl: "30m"` on GPT-5.6 / GPT-6.x | 30 minutes                             | 29 minutes    |
| `prompt_cache_retention: "24h"` on older GPT-5.x       | 30 minutes (not a guaranteed 24 hours) | 29 minutes    |
| `prompt_cache_retention: "in_memory"` on older GPT-5.x | 5 minutes                              | 4m30s         |

These request-specific rules follow [OpenAI's prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime) and are not transferred to proxies or other providers. `PI_CACHE_RETENTION=long` alone does not extend the fallback. ChatGPT/Codex does not send a retention duration and always uses a best-effort estimate when metadata is missing.

A declared positive `promptCache.short` or `promptCache.long` lifetime **in seconds** takes precedence for that tier. This includes catalog metadata and your `modelOverrides`. An omitted tier uses the fallback; an explicitly invalid value is not silently replaced. The extension never modifies the catalog or your model configuration. `/autocompact status` reports the lifetime's source.

To override a default, use Pi's existing `modelOverrides` in `~/.pi/agent/models.json`. For example, for your ChatGPT/Codex model:

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

This example is optional: it repeats the 30-minute fallback. Use the actual model/provider ID and a lifetime appropriate to **that endpoint**. For a documented range, choose its conservative lower end. Invalid metadata, cache-disabled requests, and Anthropic requests without cache breakpoints still skip scheduling; `/autocompact status` explains when no usable lifetime is available.

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

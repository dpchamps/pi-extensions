# Autorouter

Automatically switches the model per prompt based on task classification.

```
user prompt → classifier (cheap/fast) → route → target model
```

## Quick Start

1. Set your classifier API key:
```bash
export OPENROUTER_API_KEY=sk-or-...
```

2. Drop a config file at `~/.pi/agent/autorouter.json` or `<cwd>/.pi/autorouter.json`:
```json
{
  "stickyTurns": 3,
  "classifier": {
    "provider": "openrouter",
    "model": "google/gemini-2.5-flash",
    "fallback": "write",
    "categories": {
      "trivial": "Simple question or lookup, no file changes.",
      "read": "Read or explain code, no modifications.",
      "write": "Edit, create, or fix files.",
      "reason": "Complex analysis, architecture, debugging, refactoring."
    }
  },
  "routes": {
    "trivial": { "provider": "openrouter", "model": "meta-llama/llama-3.3-70b-instruct" },
    "read": { "provider": "openrouter", "model": "anthropic/claude-haiku-4-5-20251101" },
    "write": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
    "reason": { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "thinking": "high" }
  },
  "defaultModel": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" }
}
```

3. Run `pi` — the extension activates when the config is found.

## How It Works

On each user prompt:

1. **Check for token override** — `autorouter:<route>` forces that route immediately
2. **Check sticky state** — if `stickyTurns > 0`, reuse the last classified model and decrement
3. **Classify** — call the classifier LLM with the prompt + last 2 exchanges, pick a category
4. **Route** — map the category to a `provider`/`model` (optionally with `thinking` level)
5. **Switch** — swap the model for the turn, update the footer status bar

After the turn completes, if `stickyTurns` is still > 0 the model stays. After the sticky counter hits 0, the previous (pre-route) model is restored and the next prompt triggers reclassification.

Set `stickyTurns: 0` to disable sticky routing entirely.

```
Prompt 1: "refactor auth"          → classify → reason → claude-sonnet-4-20250514 (sticky=3)
Prompt 2: "also update tests"      → sticky (sticky=2)
Prompt 3: "what about edge cases"  → sticky (sticky=1)
Prompt 4: "explain the design"     → classify → read → claude-haiku-4-5 (sticky=3)
```

## Configuration

### Top-level

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Whether autorouter is active at session start. Set `false` to start disabled (toggle on with `/autorouter on`) |
| `stickyTurns` | `number` | `0` | Prompts to stay on the classified model |

### classifier

The LLM that picks the route.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `string` | ✓ | Provider name in pi's model registry |
| `model` | `string` | ✓ | Model ID — should be cheap/fast (Gemini Flash is a good default) |
| `categories` | `Record<string, string>` | ✓ | Category keys → descriptions shown to the classifier |
| `fallback` | `string` | ✓ | Category key used when classification fails |
| `prompt` | `string` | | Custom classification prompt. Use `{{categories}}` and `{{task}}` as placeholders. |
| `guidance` | `Record<string, string>` | | Per-category guidance appended to the classifier prompt. |

### routes

Map of category keys to route configs. Each needs `provider` and `model`. Optionally add `thinking` to override the thinking level for that turn.

### defaultModel

Fallback when no route matches (edge case only).

## Override Token

Put `autorouter:<route>` anywhere in your prompt to bypass classification:

```
fix the auth bug autorouter:write
autorouter:reason implement this feature
```

The token is stripped before the prompt reaches the model. Valid routes are any category key in your `categories` map (case-insensitive).

## Commands

| Command | Action |
|---------|--------|
| `/autorouter` | Toggle on/off dialog |
| `/autorouter on` | Enable |
| `/autorouter off` | Disable (also resets sticky state) |

## Status Bar

The footer `model` slot is updated to show the currently routed model (e.g., `claude-sonnet-4-20250514`). The `autorouter` slot shows the current route (e.g., `reason → claude-sonnet-4-20250514`).

## Source

```
src/
├── index.ts      # Extension registration, hooks, command
├── classifier.ts # OpenRouter API call, prompt templating
├── config.ts     # File loading (project-local + global merge)
├── state.ts      # Sticky counter, current/previous model tracking
├── token-parser.ts   # autorouter:<route> extraction from prompt
└── types.ts          # Config TypeScript definitions
```

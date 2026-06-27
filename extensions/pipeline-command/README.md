# pipeline-command

Adds `/pipeline` — execute a JSON-defined graph of agent steps with optional model, system-prompt, pre/post-script, and worktree overrides per node.

## Usage

```
/pipeline execute  <path-to-pipeline.json>
/pipeline validate <path-to-pipeline.json>
```

Tab completion offers the subcommands first, then `.json` files under cwd (depth 4, excluding `node_modules` and `.git`).

## What It Does

A pipeline is a JSON file declaring **units** (one agent iteration each) and a **flow** of directed edges between them with conditions and termination. The runner walks the graph, runs each visited unit's lifecycle (pre-script → prompt → post-script, optionally inside a fresh worktree), records the result, evaluates outgoing edges in declaration order, and follows the first one whose condition matches.

A unit with no overrides is a plain ralph iteration on the baseline model. A pipeline with one unit and a self-loop on `postExitCode != 0` is the legacy `/ralph` form.

## DSL

```jsonc
{
  "name": "auth-rewrite",
  "version": 1,
  "start": "design", // optional; defaults to first unit, or unit with kind:"start"
  "meta": { "maxSteps": 50 }, // global cycle cap (default 50)

  "units": [
    {
      "id": "design", // required, unique within units[]
      "kind": "start", // optional: "unit" (default) | "start" | "terminal"
      "prompt": { "inline": "Sketch the auth flow." },
      "systemPrompt": { "file": "./prompts/architect.md" },
      "model": {
        "provider": "openrouter",
        "model": "z-ai/glm-5.1",
        "thinking": "high",
      },
      "preScript": "git status --porcelain",
      "postScript": "npm run typecheck",
      "worktree": true, // create a fresh worktree per visit; merge back on completion
      "fresh": false, // optional: clear LLM context (ctx.newSession()) before this unit
    },
    {
      "id": "implement",
      "prompt": { "file": "./prompts/impl.md" },
      "postScript": "npm test",
    },
    { "id": "done", "kind": "terminal" },
  ],

  "flow": [
    { "from": "design", "to": "implement", "label": "ok" },
    {
      "from": "implement",
      "to": "implement",
      "when": { "postExitCode": { "ne": 0 } },
      "label": "tests fail → retry",
    },
    { "from": "implement", "to": "done", "when": { "postExitCode": 0 } },
  ],
}
```

### Units

Every field except `id` is optional. A unit with nothing else is a plain ralph iteration.

| field          | type                                  | semantics                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | string                                | required, unique within `units[]`                                                                                                                                                                                                                                 |
| `kind`         | `"unit"` \| `"start"` \| `"terminal"` | defaults to `"unit"`. Terminal nodes end the pipeline after running.                                                                                                                                                                                              |
| `prompt`       | `{ inline?: string; file?: string }`  | the message sent via `pi.sendUserMessage`. Exactly one of `inline`/`file` must be set. `file` resolves relative to the pipeline JSON's directory; read lazily so edits take effect on the next visit.                                                             |
| `systemPrompt` | same shape as `prompt`                | overrides the system prompt for this unit's turn.                                                                                                                                                                                                                 |
| `model`        | `{ provider, model, thinking? }`      | resolved against the active provider registry; falls back to the current model if not found. `thinking` is one of `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`.                                                                                 |
| `preScript`    | string                                | `bash -c <preScript>` before the agent turn. Sets `preExitCode` on the run record.                                                                                                                                                                                |
| `postScript`   | string                                | `bash -c <postScript>` after the agent turn. Sets `postExitCode`. **This is the verify hook** — combine with edge conditions on `postExitCode` to retry, branch, or terminate.                                                                                    |
| `worktree`     | boolean                               | `true` → before the unit, fork a fresh worktree from the current branch (reusing `/worktree`'s logic); after the unit, merge it back to the parent and clean up. The unit must commit its changes (typically in `postScript`) for the merge to find a clean tree. |
| `fresh`        | boolean                               | `true` → `ctx.newSession()` before this unit (clean LLM context).                                                                                                                                                                                                 |

### Flow / edges

```ts
{ "from": "<unit-id>", "to": "<unit-id>" | "$end", "when"?: Cond, "label"?: string, "id"?: string }
```

`to` may be the literal string `"$end"` for explicit termination. `when` defaults to `{ "always": true }`. Edges are evaluated in declaration order; the first matching one is followed.

### Conditions

Declarative only — JSON-portable, safe to visualize.

```ts
type Cond =
  | { always: true }
  | { exitCode: number | { ne: number } } // shorthand for postExitCode
  | { preExitCode: number | { ne: number } }
  | { postExitCode: number | { ne: number } }
  | { iterations: { gte?: number; lte?: number; eq?: number } } // visits to the source unit so far
  | { worktreeMergeFailed: boolean }
  | { and: Cond[] }
  | { or: Cond[] }
  | { not: Cond };
```

## Status & abort

- The footer `pipeline` slot shows `▷ <unit-id> (step N/maxSteps)` while a unit is active. Cleared when the pipeline ends.
- Type any message in the input box during execution to abort. The runner halts at the next safe checkpoint (between units, after `waitForIdle`, or after a `pi.exec`). Any worktree opened by the current unit is still merged/cleaned up on the way out.
- Only one pipeline runs at a time per session. A second `/pipeline execute` is rejected until the first completes or aborts.

## Worktree semantics

`unit.worktree: true` reuses `@dpchamps/pi-worktree-command/operations` directly — no duplicated logic. Per visit:

1. Before the unit: a new branch `<currentBranch>-wt-<n>` is created at `.worktrees/<branch>/`. The session forks into the new cwd; pi's tools and scripts now operate inside the worktree.
2. The unit's `preScript`, `prompt`, and `postScript` run inside the worktree. Use `postScript` for verification (typecheck, tests) — its exit code drives edge conditions.
3. After `postScript`, the runner stages and commits any agent-produced changes (`git add -A && git commit -m "pipeline: unit <id>"`). No-op when the tree is already clean.
4. The worktree's branch is merged into its parent (`<currentBranch>`), the worktree directory is removed, the branch is deleted, and the session switches back out.
5. On merge conflict, the merge is aborted (existing `/worktree merge` behavior). The runner records `worktreeMergeFailed: true`, which edge conditions can branch on.

## Visualization

The lowering function `toCytoscapeElements` (exported from `./lowering`) turns a parsed pipeline into Cytoscape.js's `elements[]` JSON shape. Visualization itself isn't shipped in v1; the function exists so a future viz extension can render pipelines without re-parsing.

## Limitations (v1)

- No JS-expression escape hatch in conditions — declarative-only.
- No prompt placeholder substitution (`{{prev.postExitCode}}`).
- Sequential execution only — first matching outgoing edge wins; no fan-out/parallel.
- No `visualize` subcommand; the lowering function is exported for future use.

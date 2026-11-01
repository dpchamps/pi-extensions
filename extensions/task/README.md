# task

Adds `/task` with three autonomous task loops: **oracle**, **focus**, and **goal**.

## Usage

```text
/task --verify "<command>" <prompt>                    # oracle (default)
/task --focus [--limit <runs>] <prompt>
/task --goal <prompt>
/task cancel                                         # cancel the active task
```

The canonical type flag is `--type oracle|focus|goal`. The convenience flags `--oracle`, `--focus`, and `--goal` are equivalent. `--kind` is accepted as an alias for `--type`.

Flag values containing spaces must be quoted. Use `--` before a prompt that begins with a flag-like token.

Examples:

```text
/task --verify "npm test" fix the failing tests
/task --type oracle --verify "npx tsc --noEmit" make typecheck pass
/task --focus investigate several substantially different caching designs
/task --focus --limit 8 find a simpler implementation
/task --goal implement the cart feature and verify it end to end
```

Chat messages are delivered normally and **do not cancel the task**. Use `/task cancel` to cancel the active loop, abort any in-progress verifier or goal checker, and interrupt the main agent if it is running. Interrupting an individual agent run (for example with Escape) resumes the task rather than cancelling it. A new task cannot start until the current task ends or is cancelled.

## Oracle (default)

An independent command decides whether the task is complete:

```text
send the original prompt
when the agent settles:
  run bash -c <verify-command>
  exit 0     → complete
  non-zero   → send the original prompt again
```

Oracle tasks require `--verify`. They do not have a run limit; they continue until verification passes, verification times out, or the user stops them.

Unlike the previous implementation, failing command output is **not** sent to the agent. The exact initial prompt is repeated instead.

The verifier runs in the session cwd and times out after 10 minutes. Stopping the task aborts an in-progress verifier.

## Focus

Focus mode keeps the agent working after it tries to finish. Each continuation repeats the original prompt and appends:

> The current run is not exhausted. Be creative and try different approaches. Use any context-management tools available to you. Continue working instead of returning a final answer.

Focus has no automatic completion test. It runs until stopped, or until its optional `--limit` number of agent runs is reached. `--limit` is valid only for focus tasks.

Before sending a continuation, focus checks current context usage. At **60% or more**, it compacts first with instructions to preserve the task, attempts, findings, failures, modified files, and promising next experiments.

## Goal

Goal mode uses an independent evaluator running in a separate Pi process with the **same model and thinking level**.

Before implementation starts, the evaluator:

1. Inspects the starting workspace.
2. Creates a private temporary Markdown checklist with concrete acceptance criteria.
3. Adds a direct verification method to every checklist item.

Planner and evaluator output streams into a compact bordered window above the chat editor, including text, thinking, tool calls, tool output, and checklists. The window automatically follows new output and wraps long lines instead of clipping them. Earlier output remains available throughout the task; a new checklist or evaluation does not erase it.

- **Alt+↑ / Alt+↓**: scroll one line.
- **Alt+PageUp / Alt+PageDown**: scroll one page.
- **Alt+Home**: jump to the beginning.
- **Alt+End**: return to live auto-follow.

Scrolling back pauses auto-follow so new output does not move what you are reading. Ordinary typing still goes to chat. The window is removed when the task ends; it is only mounted in interactive terminal mode. Tool output still respects Pi's own tool-level output limits.

Whenever the main agent settles, a fresh evaluator run reads that checklist and inspects the live workspace. It is explicitly instructed to:

- verify with files, diffs, tests, typechecks, and focused commands;
- distrust claims, summaries, and pre-checked boxes without reproducing evidence;
- update the checklist with evidence and remaining gaps;
- never implement fixes or modify project files;
- report complete only when every criterion is independently verified.

The implementing agent does not receive or author the checklist. If the goal is incomplete, it receives the original prompt plus the evaluator's concise, evidence-based gaps. The evaluator's scratchpad is removed when the task ends.

Goal evaluators inherit the host's resource and security restrictions, project-trust decision, active model, and thinking level. Each evaluator run has a 10-minute timeout.

## Status

The footer's `task` slot shows the active type and phase, for example:

- `↻ task oracle 2`
- `↻ task oracle verifying (2)`
- `↻ task focus 3/8`
- `↻ task focus compacting (64%)`
- `↻ task goal planning`
- `↻ task goal checking (2)`

Only one task can be active in a session at a time.

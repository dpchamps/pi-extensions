# task

Adds `/task` — an autonomous loop: the agent works on a prompt, a verification command runs, and if it fails the agent is nudged to keep going, until the verification passes (or the run cap is hit).

## Usage

```
/task <prompt> || <verify-script> [|| <cap>]
```

Examples:

```
/task fix the failing tests || npm test
/task make typecheck pass || npx tsc --noEmit
/task make the e2e cart suite green || pnpm test:e2e --grep cart || 15
```

The prompt and verify script are split on `||` (surrounding whitespace is ignored), so spaces are fine — no quoting needed. The optional cap defaults to **10 runs**. The verify script must not itself contain `||` (use a wrapper script if it does).

## What It Does

```
send prompt to agent
loop when the agent settles:
  run bash -c <verify-script> in the session cwd
  exit 0        → done
  exit != 0     → nudge the agent with the failing output, continue
  cap reached   → stop (warning)
  timeout       → stop (error)
```

The loop is event-driven: it hooks the `agent_settled` event, which fires only when the agent has fully settled (no automatic retry, compaction, or queued continuation will run) — so verification never happens mid-flight.

On failures the agent gets a short nudge — not a restated prompt — since the task is already in context:

```
The verification command `npm test` is still failing (exit 1). Latest output:

```
…
```

Keep working on the task until the verification passes.
```

## Stopping

Send any message while a task is running. The message is delivered to the agent normally, and the loop stops (no further verification or nudges).

## Status

The footer `task` slot shows the current state:
- `↻ task N/cap` — agent is working on run N
- `↻ task verifying (N/cap)` — verification script is running

Cleared when the task ends, is stopped, or the session shuts down.

## Notes

- Verification output is truncated to the last 8000 chars before being fed back (test summaries live at the end, so the tail is kept).
- Verification times out after 10 minutes; a timed-out run stops the task with an error.
- One task loop per session. A second `/task` is rejected until the first ends or is stopped.
- The verify script runs in `ctx.cwd` (the session's working directory).

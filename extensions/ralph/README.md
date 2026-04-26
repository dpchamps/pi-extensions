# ralph

Adds `/ralph` — loop a prompt until a verification script returns exit 0 (or the iteration cap is hit).

## Usage

```
/ralph "<prompt>" "<verify-script>" <iteration-cap>
```

Examples:

```
/ralph "fix all failing tests" "npm test" 10
/ralph "make typecheck pass" "npx tsc --noEmit" 5
/ralph "make the e2e suite green, focusing on cart flow" "pnpm test:e2e -- --grep cart" 8
```

Both the prompt and the verify script must be shell-quoted (single or double quotes) so the parser can split them. The cap must be a positive integer. If args are missing or unparseable, you'll get interactive prompts instead.

## What It Does

```
loop iter = 1..cap:
  send prompt to agent (extension source)
  wait for agent to finish
  run `bash -c <verify-script>` in cwd
  if exit code == 0 → done
  else → re-send prompt with the failing output appended, retry
```

On retries the message becomes:

```
The verification command `<script>` is still failing. Last run:

```
[exit N]
--- stdout ---
…
--- stderr ---
…
```

Keep iterating on this task:

<original prompt>
```

So the agent sees what broke and can adapt instead of doing the same thing each loop.

## Aborting

Type any message in the input box while ralph is running. ralph treats interactive input as an abort signal and exits at the next checkpoint (between iterations or after the next `waitForIdle`). Your typed message is still delivered to the agent.

ralph's own messages go through `pi.sendUserMessage(..., source: "extension")`, so it never aborts itself.

## Status

The footer `ralph` slot shows the current state:
- `↻ ralph N/cap` — agent is working on iteration N
- `↻ ralph verifying (N/cap)` — verify script is running

Cleared when the loop exits.

## Notes

- Verify output is truncated at 8000 chars before being fed back to the agent.
- Only one ralph loop can run at a time per session. A second `/ralph` is rejected until the first finishes or aborts.
- The verify script runs in `ctx.cwd` (the session's working directory).

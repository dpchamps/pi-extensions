# scratchpad

Gives each session a private directory under Node's `os.tmpdir()` for disposable calculations, exploratory scripts, and intermediate files. No model-callable tool or slash command is added; the agent uses its existing file and shell tools.

## Lifecycle

- `session_start` creates `<os.tmpdir()>/pi-scratchpad-<uid>/<sha256(session-id)>/` with `0700` permissions on POSIX. Session IDs are hashed so custom IDs cannot escape the temp namespace. Managed directory symlinks and foreign owners are rejected.
- The same session reuses its directory across reloads, resumes, model changes, and tree navigation. New/forked sessions get a different path. Ephemeral (`--no-session`) sessions work too.
- Files are **not deleted on shutdown**, because reloads and session switches also shut down extension runtimes. OS/manual cleanup may remove them; keep durable work in the project.
- The directory is recreated on session start or context repair if it has disappeared. It is not a sandbox or durable storage.

## Context invariant

One short, hidden custom message introduces the scratchpad. Hidden means absent from the normal TUI display, not hidden from the model.

`lib/ensure-context.ts` checks the outgoing context after ordinary `context` transformations. If the full declaration is present, nothing is added: ordinary user prompts and tool continuations do not accumulate reminders. A verbatim declaration in a summary also counts.

If compaction, branching, or another context manager removes the declaration, the extension:

1. restores it in the **current request**, before the model responds;
2. persists one replacement custom message without triggering another response.

Persistence uses Pi's safe end-of-turn queue during a run, avoiding insertion between a tool call and its results. Repeated context preparation while that notice is pending reuses it instead of queueing duplicates. Repairs append new history; they never modify a context manager's anchored prefix or private state. Old scratchpad notices inherited by forks and duplicate notices re-admitted by projection resets are filtered from requests.

This does not rely on native compaction events or a particular context manager. A manager that removes the declaration on every request will necessarily cause repair on every request. Pi runs `context_with_system` handlers in load order: load scratchpad after extensions that also rewrite that later phase. All ordinary `context` handlers run before the invariant regardless of load order.

## Reusable helper

Other harness extensions can import `ensureContext` from `../../lib/ensure-context.js`:

```ts
ensureContext(pi, {
  present: (messages, ctx) => containsRequiredGuidance(messages, ctx),
  restore: async (messages, ctx) => [...messages, await makeGuidance(ctx)],
});
```

Both callbacks are awaited. `restore` returns repaired messages and must preserve the leading system message. The helper verifies the invariant after repair and returns an unsubscribe function. Consumers own persistence and deduplication; the helper itself neither sends messages nor starts model runs.

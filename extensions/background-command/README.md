# background-command

Adds `/background` to detach a running foreground task into a supervised `pi --mode rpc` child process. Background tasks are listable, resumable into the foreground, killable, and deletable. Subcommands and task IDs are tab-completable.

## Usage

```
/background                 # detach the running foreground task
/background list            # show all tasks (interactive picker → resume)
/background list active     # filter by status: active|paused|killed
/background resume <id>     # stop child, swap foreground session to it
/background kill <id>       # terminate child, keep metadata + session file
/background delete <id>     # kill if alive, remove from registry + session file
```

When at least one task is tracked, the footer shows `bg: 2A 1P 1K` (active / paused / killed counts).

## Behavior

### Detach (`/background`)

Triggered while the agent is mid-stream (or right after a user message but before the agent responds):

1. Walks `getEntries()` backward to find the most recent interactive (`source === "interactive"`) user message.
2. Calls `ctx.abort()` to stop the in-flight provider request, then `ctx.waitForIdle()` to let cancellation reach disk.
3. `flushSessionToDisk` materializes the in-memory session if pi hadn't written it yet (mirrors the pattern used by `worktree-command`).
4. `SessionManager.forkFrom(currentSessionFile, cwd)` creates a fork. The fork is then `branch()`'d back to the parent of the captured user message (or `resetLeaf()` if it was the root) — so the child will replay the prompt from a clean state instead of inheriting the parent's already-asked leaf.
5. Spawns a `pi --mode rpc --session <forkedPath>` child via `RpcChild` (a small JSONL-protocol wrapper around `child_process.spawn`).
6. Re-issues the captured prompt to the child via the `prompt` RPC command. Fire-and-forget; status updates flow through `agent_start` / `agent_end` events.
7. Drops a `CustomMessageEntry` (`customType: "background-detach"`, `display: true`) into the parent transcript so both the user and the LLM can see what was handed off. The parent session keeps the orphaned user message + any partial assistant entry — extensions can't mutate the foreground session's leaf, so the next interactive turn just chains under the orphan, which is fine.
8. Sets the footer indicator and notifies the user with the task id.

### List (`/background list [active|paused|killed]`)

Renders tracked tasks as a tree by `parentSessionFile` lineage. A task detached from the foreground is a root; a task detached after resuming `bg-1` and starting fresh work nests under `bg-1`. The render uses `└─` / `├─` indent prefixes and includes `[status]`, a 50-char prompt preview, and a relative timestamp:

```
bg-1  [active]   refactor the auth module to use JWT  (5m ago)
└─ bg-3  [paused]  rotate existing tokens once issuer changes  (1m ago)
bg-2  [killed]   long flaky test loop on payments  (10m ago)
```

The list is shown via `ctx.ui.select`; picking any line resumes that task.

### Resume (`/background resume <id>`)

1. `RpcChild.stop()` — graceful SIGTERM with a 1.5s grace before SIGKILL. Two processes can't safely write the same JSONL, so the child must exit before the foreground takes over.
2. `await ctx.waitForIdle()` to let the foreground settle.
3. `ctx.switchSession(task.sessionFile)` — pi reads the session header's `cwd` and swaps the foreground in place. Same pattern as `worktree-command` switch.
4. The task is removed from the registry on success — once resumed it's just an ordinary session.

### Kill (`/background kill <id>`)

Aborts any in-flight stream in the child and stops the process. Marks `killed: true`. The session file is preserved; you can still `delete` it later or leave it for archival.

### Delete (`/background delete <id>`)

Kills if alive, then removes the registry entry and unlinks the forked session file from disk. Use `kill` instead if you want to preserve the session.

## Status taxonomy

| Status   | Determination                                                     |
|----------|-------------------------------------------------------------------|
| `active` | child alive AND last observed event was `agent_start` (streaming) |
| `paused` | child alive AND last observed event was `agent_end` (idle)        |
| `killed` | child process is dead, either by `kill` or by crash               |

Status is queried lazily off the cached `isStreaming` flag — no per-`list` RPC round-trip.

## Lifecycle

Children are **supervised**: they die when the parent pi exits. A `session_shutdown` hook walks the registry and stops every `RpcChild` so no `pi --mode rpc` processes are orphaned. The registry itself is in-memory and does not survive a parent pi restart.

A soft warning fires at 5 concurrent live tasks — child pi processes carry a non-trivial memory footprint, and there's no benefit to running dozens.

## Autocomplete

`registerCommand({ getArgumentCompletions })` is wired up:

- First token: `list | resume | kill | delete` filtered by what's been typed.
- Second token (after `list`): `active | paused | killed` status filter.
- Second token (after `resume` or `kill`): IDs of currently-alive tasks. Description shows `[status] <prompt preview>`.
- Second token (after `delete`): all task IDs (including killed).

Pure parsing/build logic lives in `completion.ts` and is unit-tested without pi runtime imports — same split pattern as `worktree-command/completion.ts`.

## Files

- `index.ts` — command registration, hooks, handler dispatch (`runDetach`, `runList`, `runResume`, `runKill`, `runDelete`), footer status rendering.
- `runner.ts` — `RpcChild` (minimal JSONL-protocol pi RPC client), `flushSessionToDisk`, `findLastInteractiveUserMessage`.
- `store.ts` — `BackgroundStore` (in-memory Map keyed by id), `allocId`, `tree()` assembly by `parentSessionFile`.
- `completion.ts` — `parseCompletionPrefix`, `buildCompletionItems`, `truncatePrompt`. No pi imports.
- `completion.test.ts` — vitest covering parse/build/truncate.

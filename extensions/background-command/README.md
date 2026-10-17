# background-command

`/background` **aborts and replays a live user request** in a supervised Pi RPC child. It does **not** move a running provider stream, shell command, tool execution, queue, or extension's in-memory state.

Requires Pi 1.3+ and an interactive or RPC UI. Every replay requires confirmation: completed side effects can repeat, and foreground/background processes **share the same workspace**. Use separate worktrees when concurrent edits need isolation.

## Usage

```text
/background                 # confirm replay of the current live user request
/background list            # task picker → resume
/background list active     # active|paused|killed filter
/background resume <id>     # stop child, open its session in the foreground
/background kill <id>       # stop child, preserve task metadata and session
/background delete <id>     # stop child, remove metadata and its session file
```

Subcommands, filters, and task IDs support tab completion. Resume includes stopped/crashed tasks because their session files can still be opened. Kill completion only includes live children.

## Request selection and replay

Only an unambiguous, currently running request originating from interactive or RPC user input is eligible. The extension observes input provenance and the actual user message, then checks the **active branch**. It never guesses provenance from fields in persisted messages.

Idle/completed requests, runs restored without observed provenance, custom-message runs, extension-started requests (including `/task`), and runs receiving additional queued input are rejected. The request is revalidated after confirmation; completing or changing the run while the dialog is open cancels the handoff.

After cancellation settles, the extension writes a new private JSONL snapshot containing only the active path **before** the captured request. It does not mutate a disposable manager's leaf or manually flush the source session. Reopening the snapshot therefore selects the same intended branch. The original session retains the request and partial work. Text and images, including image-only prompts, are sent to the child; a visible, context-only replay marker is added to the parent only after acceptance.

Replay is a new input, so input/provider hooks run in the child too. Do not use it for operations that cannot safely be repeated. Extension state is deliberately not guessed or migrated.

## Configuration and permissions

Children use the host's Pi installation, not a `pi` executable found on PATH. Relevant CLI resource, tool, permission, offline, and extension flags are inherited, with relative resource paths resolved against the original launch directory. Prompts, `@files`, one-shot actions, and parent session selectors are not inherited.

The current project-trust decision, model, thinking level, effective system prompt, and active tool names are captured. A CLI API-key override is forwarded only to its original provider, never to a different provider after a model switch. A private bootstrap extension restores the prompt/tool loadout. If a required dynamic tool is unavailable, it disables tools and aborts before any provider request instead of broadening permissions. Startup verifies the child's session and selected model.

Explicitly loaded permission extensions remain loaded. Child confirmation/input/select/editor dialogs are **cancelled**, never approved automatically. The parent receives a warning telling the user to resume the task for interaction. Child notifications, extension errors, provider failures, and bounded stderr diagnostics are surfaced as well.

SDK hosts can supply `BackgroundOptions.launchArgs`, `createClient`, and a separate `BackgroundSupervisor`; arbitrary SDK-only providers and extension closures cannot be reconstructed by a subprocess. Recreating equivalent provider/resource configuration is the host's responsibility. Missing configuration fails visibly, preserving both sessions.

## Process lifecycle and session ownership

**Upgrading the old implementation:** finish or resume existing background work before the first reload. Its closure-local registry cannot be migrated into the new supervisor.

A process-scoped supervisor survives `/new`, `/resume`, `/fork`, and `/reload`, even when the extension module is reloaded. Its callbacks hold no old Pi/context objects. UI subscribers are rebound on session start, and diagnostic notices are buffered between sessions. Mutation commands are serialized. Reload/quit cancels pending command dialogs so they cannot block shutdown; established children survive reload.

An orderly parent **quit** while this extension is loaded stops all tracked children; session replacement does not. A synchronous process-exit fallback also signals children if the user has left for a workspace that does not load the extension; that last-resort path cannot await termination. Shutdown clears queued work and awaits a bounded abort before stdin EOF for graceful disposal, then SIGTERM and SIGKILL as necessary, and awaits confirmed process closure. Failed startup/handshake also attempts cleanup. Abrupt process/OS failure cannot guarantee disposal of descendants or temporary files. The registry does not survive a parent process restart; saved session files do.

Resume stops only the selected child. If foreground work is active, it first asks permission to abort that work; it does not silently stop a background child and wait indefinitely. Cancellation has a deadline. The session is not switched, and a session file is not unlinked, if child termination is uncertain. Built-in resume of a live managed child's JSONL is blocked; use `/background resume` to transfer ownership safely.

If another extension cancels or rejects the session switch **after** the child has stopped, the task remains accurately marked dead and its session is preserved. Retry `/background resume <id>`; the extension does not automatically replay work again. Missing files and failed unlinks retain task metadata for recovery/retry. Post-switch work uses Pi's fresh `withSession` context.

## Status and lineage

The footer shows counts such as `bg: 2A 1P 1K`:

| Status   | Meaning                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| `active` | A live child is starting/running or still has automatic retry/recovery work.                 |
| `paused` | A live child has settled, or its prompt was handled without starting a run.                  |
| `killed` | The child was stopped, crashed, or failed startup. Its saved session may still be resumable. |

`agent_settled`, not an intermediate `agent_end`, determines idle status. Process exits are observed independently. Errors also appear in list rows.

Tasks are shown in session-lineage order. Resumed tasks leave the actionable registry, but their lineage is retained: when descendants are tracked, historical parents appear as **resumed ancestor** rows. These rows are context only, not selectable tasks. Status filters retain ancestor context, and IDs remain monotonic across session changes/reloads.

## Tests

```sh
npx vitest run extensions/background-command
npx tsc --noEmit -p extensions/background-command/tsconfig.json
```

Tests cover completions, provenance, persistent branch snapshots, lineage, global supervision, real Pi session replacement/reload, image replay, failures/cancellation, RPC framing, startup/readiness, dialogs, and forced termination. Real CLI integration tests use an isolated local faux provider; they make no live model requests.

## Implementation

- `index.ts`: lifecycle bindings, commands, confirmation, UI, and handoff.
- `supervisor.ts`: process-lifetime registry, mutation guard, subscribers, shutdown.
- `store.ts`: task status, IDs, and historical lineage.
- `prompt.ts`: live input provenance and active-branch matching.
- `launch.ts`: host executable and CLI configuration inheritance.
- `runner.ts`: branch snapshots and supervised RPC transport. Pi exports `RpcClient`, but this transport additionally needs raw UI cancellation, bounded diagnostics, a readiness handshake, launch snapshots, and confirmed forced termination.
- `*.test.ts`: unit, real runtime, subprocess, and real CLI regression tests.

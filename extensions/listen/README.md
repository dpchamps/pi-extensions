# Listen

Opt-in, local handoffs to the **current Pi conversation**, with recoverable replies. No HTTP, A2A, tmux, extra daemon, model-visible tool, or runtime dependencies.

## Commands

- `/listen` creates a private temporary directory and starts a Unix stream socket inside it. Repeating it shows the same directory.
- `/listen status` prints that directory, or reports that listening is off. It never creates a listener.
- `/listen stop` closes the socket, interrupts pending requests, and removes the temporary directory. Safe to repeat. It does **not** abort Pi or undo side effects.

Session replacement, fork, tree navigation, reload, and orderly shutdown stop listening. The next session must explicitly opt in again. An ungraceful process exit may leave a stale temporary directory; it does not leave a running listener.

```text
<temporary directory>/
  inbox.sock
  listener.json
  pi-listen/
    SKILL.md
    scripts/client.mjs
```

The skill is copied from [`../../skills/pi-listen`](../../skills/pi-listen/), including its dependency-free Node client. Its own directory name remains `pi-listen`, as required by the Agent Skills specification. Give the directory (or copied `SKILL.md`) to another agent; that agent needs no Pi extension or inbox of its own.

## Handoff and recover

```sh
DIR='/directory/printed/by/listen'
CLIENT="$DIR/pi-listen/scripts/client.mjs"
node "$CLIENT" "$DIR" submit review-001 'Review the implementation and report back.'

# After a tool timeout, use the same request ID:
node "$CLIENT" "$DIR" get review-001 --wait
```

Client usage and the complete small wire protocol are documented in the [skill](../../skills/pi-listen/SKILL.md). The client uses only Node built-ins and works independently of the receiving harness. Other Unix-socket clients can implement the same UTF-8 JSONL exchange.

One request per connection:

```json
{
  "op": "submit",
  "id": "review-001",
  "message": "Review the implementation.",
  "wait": true
}
```

Or, on a new connection:

```json
{ "op": "get", "id": "review-001", "wait": true }
```

A waited request gets a receipt/status immediately and a terminal `response` when finished. A non-waited request returns its current status and closes. Final responses contain the associated last assistant message's **text only**. Thinking, intermediate commentary, tool results, and session history are not returned. `completed` means the Pi run settled, not that its claims were verified.

## Delivery and reply ownership

Submissions enter an extension-owned FIFO queue. Only one external handoff is active, and dispatch waits for Pi to be idle with no queued messages. A unique marker identifies the actual user message consumed by Pi; unrelated assistant output before that point is ignored. Input is submitted without command/template expansion. Version 1 deliberately has no steering option.

Replies are finalized at `agent_settled`, not `agent_end`, so automatic recovery and retries can finish. Final message replacements/redactions are respected. A later unrelated user message entering the same run interrupts reply ownership instead of returning that user's answer. This is a **shared conversation for trusted collaborators**, not isolated or multi-tenant agent hosting. Even a task-specific answer can draw on existing conversation context.

The public extension API submits prompts without returning a promise. If Pi does not consume a handoff and becomes idle, a 30-second dispatch watchdog records a failure rather than leaving the client waiting forever. Input handlers, authentication, or preflight failures can cause this; delivery is never automatically retried. A slow active preflight/compaction is allowed to continue while Pi is busy. This is not a hard execution timeout.

## Persistence and recovery boundaries

The temporary directory contains connection information and client instructions, **not the ledger**. Request files live under:

```text
<session-manager session directory>/listen/<hash of session identity>/
```

Records are private, atomically replaced, and fsynced before acknowledgment or final delivery; directory renames are synced where the filesystem supports it. A per-session owner lock prevents concurrent ledger writers. Corrupt/unverifiable locks, or an abandoned `.recovering` guard from a crash during lock recovery, fail closed and require manual inspection rather than risking duplicate execution. Completed/failed/interrupted results expire seven days after their last update; expired records are pruned on access/startup. At most 32 requests may be pending and 256 retained. Reaching a limit rejects new work rather than evicting recoverable results early.

- A disconnected or timed-out client does not cancel work.
- Identical ID + identical message retrieves existing work/results. Different text with the same ID is rejected.
- After `/listen stop` or a crash/reload, run `/listen` again in the **same persisted Pi session**. Use its new directory/client to retrieve previous IDs.
- Queued and in-flight work becomes `interrupted` on reopening; it is never replayed automatically.
- A crash between side effects and saving a reply leaves an uncertain outcome. There is no exactly-once execution guarantee.
- Ephemeral sessions cannot be resumed after process exit; a session that Pi has not yet written to disk has the same recovery limitation. Removing session storage or an expired result also ends recovery.

Stopping a listener while Pi works may leave that Pi run finishing normally, but its interrupted request will not acquire a late reply or execute a second time. Re-enable listening to inspect it. Audit any side effects before deliberately starting replacement work with a new ID.

## Unix portability and access

Uses Node's Unix-domain stream sockets and filesystem APIs. macOS and Linux are the primary targets; other Unix platforms supported by Node should work. Windows is explicitly unsupported. Temporary paths follow `os.tmpdir()` when short enough; long `TMPDIR` values fall back to `/tmp`, keeping socket paths at most 100 UTF-8 bytes for macOS's shorter `sockaddr_un` limit.

The listener directory is mode `0700`, the socket/metadata/ledger files are `0600`. This is filesystem-permission access control, **not authentication between processes belonging to the same user**. Anyone with access can ask Pi to use its normal tools and read task-specific answers. Do not publish the directory to untrusted collaborators.

Clients must send a complete frame within five seconds. Frames, messages, outputs, pending work, retained records, and connections are bounded; see the skill for limits. There is no TCP port, shell evaluation of socket input, automatic network fetch, or callback URL.

## Tests

```sh
npm run typecheck
npx vitest run extensions/listen tests/pi-compatibility.test.ts
```

Tests exercise real Unix sockets, copied-skill loading, the standalone client, durable recovery/idempotency, and real Pi session/reload/fork/reply lifecycle using a local faux provider (no model network calls).

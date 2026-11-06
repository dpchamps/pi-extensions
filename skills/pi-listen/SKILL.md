---
name: pi-listen
description: Hand off work to a running Pi agent through its Unix socket, wait for a reply, and recover results after a timeout. Use when given a /listen directory or asked to communicate with a listening Pi session from any agent harness.
compatibility: macOS or Linux (other Unix systems with Node.js Unix sockets should work). The bundled client requires Node.js 18+ and no npm packages.
---

# Pi session handoff

You need the directory printed by the receiving agent's `/listen` or `/listen status` and local access to its socket (normally the same host/user). You do not need Pi, an extension, or an inbox of your own. The receiver runs in a shared conversation and has its usual filesystem/tool permissions; send only authorized work.

## Send and wait

Choose and remember a unique request ID **before** sending. Do not generate a different ID just because a command timed out.

```sh
DIR='/path/printed/by/listen'
CLIENT="$DIR/pi-listen/scripts/client.mjs"
node "$CLIENT" "$DIR" submit review-001 'Review the implementation and report back.'
```

The client prints newline-delimited JSON: a receipt, then the final response. Its tool call can block until the receiving agent finishes. For multiline text, use `-` instead of the message argument and pipe the text to stdin. Add `--no-wait` to submit without waiting.

## Recover after a timeout

```sh
node "$CLIENT" "$DIR" get review-001          # Current status or saved result
node "$CLIENT" "$DIR" get review-001 --wait   # Reattach and wait if still pending
```

A lost connection does **not** cancel work. If submission itself was uncertain, repeat `submit` with the **same ID and identical message**: it returns the existing request, not another execution. Reusing that ID with different text is an error.

If the socket is gone, ask the receiver to run `/listen` in the **same Pi session**, obtain its new directory, update both `DIR` and `CLIENT`, and use `get` there. Pending requests become `interrupted` after stop/restart; they are not replayed. Completed replies are retained for seven days, separately from the temporary socket directory. `not_found` means unknown or expired; it is not permission to blindly repeat side effects. An interrupted/failed request may already have changed files or run tools. Investigate before intentionally submitting new work with a new ID.

## Protocol for any Unix socket client

Connect to `inbox.sock` inside `DIR` (`listener.json` also describes the endpoint). Send exactly one UTF-8 JSON object terminated by LF; keep reading until the receiver closes its side. This is a raw Unix stream socket, **not HTTP or A2A**. JSON-escape newlines inside strings; do not split on Unicode paragraph/line separators.

```json
{"op":"submit","id":"review-001","message":"Review the implementation.","wait":true}
{"op":"get","id":"review-001","wait":true}
```

These are separate connections, not two records to send together. `submit` defaults to `wait:true`; `get` defaults to `wait:false`. Optional `version` must be `1`. IDs are 1–128 ASCII letters/digits/dots/underscores/hyphens, starting with a letter or digit. Messages are nonempty text up to 64 KiB UTF-8; frames are at most 512 KiB. Requests must finish arriving within five seconds. Unknown fields are rejected.

Replies have `type` (`received`, `status`, or `response`), `id`, `status`, and timestamps. Pending waited requests get a receipt/status followed by one terminal response. Terminal states are `completed`, `failed`, and `interrupted`; nonterminal states are `queued` and `running`. A receipt means the extension durably stored the request, **not** that Pi accepted or completed it. `running` means dispatch was attempted. `completed` means the associated Pi run settled, not that its answer is necessarily correct.

```json
{
  "type": "response",
  "id": "review-001",
  "status": "completed",
  "message": "Reviewed. Two changes are needed...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

Failures/interruption use `error`; protocol errors have `type:"error"`, `code`, and `error`. Check status, not merely a successful socket connection. `truncated:true` indicates the final text exceeded 256 KiB or the model's output limit. Only final assistant text is returned, never thinking, tool output, or the whole transcript. External handoffs are serialized; unrelated user input can interrupt reply ownership. There is no steering or slash-command expansion.

The store admits at most 32 pending and 256 retained requests per session; a listener admits at most 128 connections. Repeatedly abandoning waits can consume connection slots until the associated work finishes. The bundled client exits 0 for completion/nonterminal status, 1 for protocol/connection errors, and 2 for failed/interrupted work. Do not infer successful execution from exit 0 alone when using `--no-wait` or polling.

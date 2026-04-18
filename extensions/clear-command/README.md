# clear-command

Adds `/clear` to wipe conversation context and the terminal without destroying the session. Like `/new`, but cost history and the session file are preserved.

## Usage

```
/clear
```

That's it. No arguments, no options.

## What It Does

1. Navigates the conversation tree leaf back to the root (null leaf → zero context)
2. Clears the TUI screen
3. Clears the text input box

The session file stays on disk, so token costs, tool call history, and all previous messages remain in the session store — they're just no longer in the active context window.

## `/clear` vs `/new`

| | `/clear` | `/new` |
|---|---|---|
| Clears context | Yes | Yes |
| Clears terminal | Yes | Yes |
| New session file | No | Yes |
| Cost history preserved | Yes | No |
| Previous messages recoverable | Via tree navigation | No |

## How It Works

The session manager stores messages as a tree. `/clear` finds the first user message and calls `ctx.navigateTree(entryId, { summarize: false })`. Since the first message has no parent (`parentId === null`), the leaf becomes `null` — zero context. The TUI's `navigateTree` handler picks this up and clears the chat container.

If `navigateTree` fails for any reason, it falls back to `sessionManager.resetLeaf()` and notifies the user that a `/reload` may be needed to update the UI.

# watcher-await

Run a long command without blocking Pi. `watcher_await` returns a job ID as soon as the process starts. Pi delivers one completion notice per job when the agent is idle, with the exit code or reason it stopped and the last 4 KiB of combined stdout/stderr. The notice wakes the agent so it can continue the task. Redirect to a scratchpad file if you need the full log.

```json
{ "command": "npm test", "progress": true, "timeout_seconds": 1800 }
```

Only the agent can launch jobs. There is no slash command. The agent can list jobs with `watcher_await({})` and cancel one with `watcher_await({"cancel":"w1"})`.

A widget below the editor appears only while jobs are active. In the terminal UI, press **Ctrl+Alt+W** to see job IDs, command previews, and the latest output. Press Escape to close, or select a job and confirm to cancel it. With `progress: true`, the widget shows elapsed time and the latest output for opted-in jobs, rotating every 15 seconds. Progress never calls the model.

## Lifecycle and limits

- macOS/Linux and other Unix hosts with `/bin/sh`; Pi interactive and RPC modes only. Commands run in the current working directory with stdin closed. The default deadline is one hour (configurable from 1 second to 7 days), and at most four jobs can be outstanding, including results waiting to be delivered.
- Jobs continue if you give Pi another prompt or press Escape after launch. Cancel a job explicitly to stop it. Navigating the session tree, switching sessions, reloading, or quitting stops jobs and discards pending notices from the old branch/runtime. Jobs are in memory only; they are never replayed on resume.
- Each command runs in its own process group. Cancellation and deadlines send `SIGTERM` and escalate to `SIGKILL` after a short grace period. When the shell exits, any remaining members of its group are killed and Node reaps the direct child. Use a command that stays in the foreground (including `wait` for its own children), not a daemon or a command that detaches from its process group. Forced host death (e.g. `kill -9`) or descendants that leave the group cannot be cleaned up reliably by this extension.
- This is a **local shell tool**, not a sandbox or a wrapper around Pi's `bash` tool. If you restrict shell execution with a tool allowlist or permission extension, apply the same policy to `watcher_await` or exclude it. Output snippets are visible in Pi and the completion notice is recorded in the session.

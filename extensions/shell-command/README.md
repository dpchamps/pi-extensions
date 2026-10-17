# shell-command

`/shell` temporarily hands the terminal to a fresh interactive `$SHELL` (or `/bin/sh`) in the session's working directory. Your usual shell configuration, completion, history, and aliases apply. Requires Pi's interactive TUI and a POSIX shell.

Exit with `exit` or Ctrl+D to return to Pi. Ctrl+C belongs to the shell, not Pi. Each invocation starts a new shell; shell-local directory and environment changes do not propagate back to Pi. Filesystem changes persist.

The command waits for the agent to be idle, stops the TUI, and runs the shell with inherited stdio on an alternate screen. On exit it restores Pi in `finally`, without a transcript entry, captured output, or success notification. Startup failures are reported after restoration.

This is a native terminal handoff, not a terminal emulator: nested applications that switch screen buffers themselves (such as vim or less) can interfere with screen isolation. Shell history and external terminal logging still apply; this is not an incognito or sandboxed shell.

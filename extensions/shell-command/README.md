# shell-command

`/shell` temporarily hands the terminal to a fresh interactive `$SHELL` (or `/bin/sh`) in the session's working directory. Your usual shell configuration, completion, history, and aliases apply. Requires Pi's interactive TUI and a POSIX shell.

An orange `(π)` badge appears before your usual prompt. Bash and Zsh install it after your normal startup files and preserve existing prompt hooks, including themes that rebuild the prompt. Other POSIX shells get a prefix through `ENV` startup. Temporary startup shims are removed on exit; your dotfiles are never modified.

Exit with `exit` or Ctrl+D to return to Pi. Ctrl+C belongs to the shell, not Pi. Each invocation starts a new shell; shell-local directory and environment changes do not propagate back to Pi. Filesystem changes persist.

The command opens immediately, even during an active turn. Only the TUI is suspended: the agent continues working in the background and may modify the same files you're working with. The shell runs with inherited stdio on an alternate screen. On exit it restores Pi with the latest task state in `finally`, without a transcript entry, captured output, or success notification. Startup failures are reported after restoration.

This is a native terminal handoff, not a terminal emulator: nested applications that switch screen buffers themselves (such as vim or less) can interfere with screen isolation. Shell history and external terminal logging still apply; this is not an incognito or sandboxed shell.

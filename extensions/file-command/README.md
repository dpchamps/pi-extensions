# file-command

Adds `/file <path>` to open a file in `$VISUAL`/`$EDITOR` with full terminal access. The TUI suspends while the editor runs and resumes on exit.

This is the file-opening counterpart to pi's built-in `Ctrl+G`, which only opens an empty scratch buffer for prompt composition.

## Usage

```
/file path/to/file.md
/file ~/notes.md
/file /absolute/path.txt
/file              # prompts for the path
```

Relative paths resolve against the session's working directory. Missing files are created by the editor on save (vim default).

## How It Works

`ctx.ui.custom()` is the only public API path that exposes `tui.stop()`/`tui.start()`. The handler:

1. Resolves the path against `ctx.cwd` (with `~` expansion).
2. Waits for the agent to be idle.
3. Stops the TUI, clears the screen, and `spawnSync`s the editor with `stdio: "inherit"`.
4. Restarts the TUI and notifies `closed <path>` on clean exit, or the exit code otherwise.

The editor command is split on space so `EDITOR="code --wait"` works.

# file-command

Adds `/file [path]` to open a file in `$VISUAL`/`$EDITOR` with full terminal access. Without a path, it opens the editor's configured filesystem explorer, or falls back to the existing file-path prompt. The TUI suspends while the editor runs and resumes on exit. Requires interactive TUI mode.

This is the file-opening counterpart to pi's built-in `Ctrl+G`, which only opens an empty scratch buffer for prompt composition.

## Usage

```
/file path/to/file.md
/file ~/notes.md
/file /absolute/path.txt
/file              # opens an explorer if configured; otherwise prompts for a path
```

Relative paths resolve against the session's working directory. Missing files are created by the editor on save (vim default). Explicit paths always open the file, bypassing explorer configuration.

## Explorer configuration

By default, `vi` and `vim` launch with `-c Explore` in the session's working directory. Other editors use the file-path prompt unless configured.

Declare integrations (including editor plugins) in `~/.pi/agent/file.json` or project-local `.pi/file.json`:

```json
{
  "explorers": {
    "nvim": ["-c", "Oil"],
    "hx": ["{cwd}"],
    "code": ["{cwd}"],
    "vim": false
  }
}
```

- Keys match the executable's basename: `/usr/bin/vim -u NONE` matches `vim`. `$VISUAL` takes precedence over `$EDITOR`.
- Values are argument arrays appended after existing editor flags. Each string is one argument; no shell evaluation occurs. `{cwd}` expands to the session's working directory. No file or directory argument is appended automatically.
- Use `false` to force the path prompt, or `[]` to launch the editor with only its existing flags.
- Defaults, user config, and project config merge per editor, in that order. Project config is read only when `ctx.isProjectTrusted()` is true. User config follows `PI_CODING_AGENT_DIR` when set.
- Config is reread on every no-path invocation. Missing config is normal; malformed or invalid config files produce a warning and are ignored, retaining valid layers.

The `nvim` example requires [oil.nvim](https://github.com/stevearc/oil.nvim) to be installed in your editor. No extension code is needed to add another integration.

## How It Works

`ctx.ui.custom()` is the only public API path that exposes `tui.stop()`/`tui.start()`. The handler:

1. Resolves an explicit path against `ctx.cwd` (with `~` expansion), or selects explorer arguments / prompts for a path.
2. Waits for the agent to be idle.
3. Stops the TUI, clears the screen, and `spawnSync`s the editor with `cwd: ctx.cwd` and `stdio: "inherit"`.
4. Restarts the TUI even on startup failure, then notifies `closed <path>` (the working directory for explorers) on clean exit, or reports the error / exit code.

The editor command is split on whitespace so `EDITOR="code --wait"` works. Shell quoting and executable paths containing spaces are not supported; use an executable wrapper for those cases.

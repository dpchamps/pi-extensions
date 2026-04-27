# worktree-command

Adds `/worktree` to manage git worktrees forked from the current branch under `.worktrees/`. Subcommands and worktree names are tab-completable.

## Usage

```
/worktree                   # create a new worktree on <current>-wt-<n>
/worktree merge             # merge default worktree into its parent and clean up
/worktree merge <name>      # merge a specific worktree (by branch name or basename)
/worktree switch            # default: from a worktree → main; from main → only/picker
/worktree switch main       # back to the main worktree
/worktree switch <name>     # to that specific worktree
```

When pi runs *inside* a linked worktree, the footer shows `worktree: <branch>` so you know which checkout you're in.

## Behavior

### Create

1. Resolves current branch (refuses if detached HEAD).
2. Picks the next `n` by scanning existing `<current>-wt-N` branches and incrementing the max — survives deleted worktrees.
3. Runs `git worktree add -b <current>-wt-<n> .worktrees/<current>-wt-<n>` from the main worktree.
4. Idempotently appends `.worktrees/` to `.gitignore`.
5. Forks the current session into the worktree's cwd via `SessionManager.forkFrom(sourcePath, worktreeCwd)`, then calls `ctx.switchSession(newPath)`. pi's runtime reads the new session header's `cwd` and `process.chdir()`s into the worktree, so the same pi session continues — same conversation, same TUI — but now operating inside the worktree. The original session stays on disk; resume with `pi --resume`.

### Merge

Works from anywhere — main worktree, the worktree being merged, or a different linked worktree. Target resolution:

- Explicit `name` → that worktree.
- No name + currently inside a linked worktree → that worktree (the common case).
- No name + in main, exactly one linked worktree → that one.
- No name + multiple linked → picker.

Steps (all git ops use `cwd: mainDir` so the main worktree drives the merge regardless of where pi is sitting):

1. Refuses if the target worktree has uncommitted changes.
2. Derives the parent branch by stripping `-wt-<n>` from the target's branch name.
3. Saves main's current branch, checks out parent, runs `git merge --no-edit`.
4. On conflict: aborts and restores. Worktree stays put so you can resolve manually.
5. On success: `git worktree remove`, `git branch -d`, restores main's original branch.
6. If pi was sitting inside the just-removed worktree: `ctx.switchSession(parentSessionPath)` (the session it forked from on create) so pi `process.chdir`s back into the main worktree seamlessly. If the parent session is gone, falls back to forking the current session into main's cwd. The footer's `worktree:` indicator clears on the next `session_start`.

### Switch

Picks the destination based on context:

- Explicit `name` (`main`, a worktree branch, or a worktree path basename) → that target.
- No name + currently in a linked worktree → default to main.
- No name + in main, exactly one linked → that linked worktree.
- No name + in main, multiple linked → picker.
- No name + in main, no linked → notifies that there's nowhere to switch.

Session resolution for the destination cwd:

1. `SessionManager.list(targetCwd)` — if any session exists for that cwd, resume the most recent one. This means each worktree retains its own conversation thread across switches.
2. Otherwise (first visit) fork the current session into target. The forked session's header records `parentSession`, so future switches can navigate back via the same mechanism.

After resolving, calls `ctx.switchSession(destPath)`. Pi reads the destination's header `cwd` and `process.chdir`s, swapping pi's cwd in place.

## Autocomplete

`registerCommand({ getArgumentCompletions })` is wired up:

- First token: `create | merge | switch` filtered by what's been typed.
- Second token (after `merge` or `switch`): linked worktree branch names. `switch` additionally offers `main`. Each item shows the worktree's relative path as the description.

Resolution uses `process.cwd()` since pi keeps it synced to the active session's cwd.

## Status indicator

Subscribed to `session_start`. When `git rev-parse --git-common-dir` differs from `--git-dir`, the cwd is a linked worktree, and the indicator is set via `ctx.ui.setStatus("worktree", ...)`. Outside a linked worktree (e.g., after `switch` back to main), the handler explicitly clears the status — `setStatus` state is global to the UI and survives session switches, so we always set-or-clear rather than only setting.

# worktree-command

Adds `/worktree` to manage git worktrees forked from the current branch under `.worktrees/`.

## Usage

```
/worktree              # create a new worktree on <current>-wt-<n>
/worktree merge        # merge the only linked worktree into its parent and clean up
/worktree merge <name> # merge a specific worktree (by branch name or path basename)
```

When pi runs *inside* a linked worktree, the footer shows `worktree: <branch>` so you know which checkout you're in.

## Behavior

### Create

1. Resolves current branch (refuses if detached HEAD).
2. Picks the next `n` by scanning existing `<current>-wt-N` branches and incrementing the max — survives deleted worktrees.
3. Runs `git worktree add -b <current>-wt-<n> .worktrees/<current>-wt-<n>` from the main worktree.
4. Idempotently appends `.worktrees/` to `.gitignore`.
5. Asks whether to switch into the new worktree. On yes, stops the TUI and re-execs pi (`process.argv[0] process.argv[1] ...`) with `cwd` set to the new worktree, replacing the current process when the child exits. The previous session is preserved on disk — resume with `pi --resume`.

### Merge

Must run from the main worktree (otherwise it would yank cwd out from under pi).

1. Resolves which worktree to merge: explicit name, or the only linked worktree, or a picker.
2. Refuses if the worktree has uncommitted changes.
3. Derives the parent branch by stripping `-wt-<n>` from the worktree's branch name.
4. Saves the main worktree's current branch, checks out parent, runs `git merge --no-edit`.
5. On conflict: aborts the merge and restores the original branch.
6. On success: `git worktree remove`, `git branch -d`, restores the original branch.

## Status indicator

Subscribed to `session_start`. When `git rev-parse --git-common-dir` differs from `--git-dir`, the cwd is a linked worktree, and the indicator is set via `ctx.ui.setStatus("worktree", ...)` for the duration of the session.

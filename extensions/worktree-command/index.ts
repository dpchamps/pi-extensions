/**
 * worktree-command extension — /worktree manages git worktrees forked from
 * the current branch under .worktrees/.
 *
 *   /worktree                  create a new worktree on a fresh <current>-wt-<n>
 *   /worktree merge [<name>]   merge a linked worktree into its parent and clean up
 *   /worktree switch [<name>]  switch session/cwd to another worktree (or "main")
 *
 * The git + session-fork primitives live in ./operations.ts and are also
 * consumable by other extensions (e.g. /pipeline). This file is the
 * user-facing CLI shell — argument parsing, interactive picker, UX
 * notifications.
 *
 * On session start: if cwd is inside a linked worktree, set a persistent
 * "worktree: <branch>" status indicator (cleared otherwise).
 */

import * as path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  buildCompletionItems,
  parseCompletionPrefix,
  type AutocompleteItem,
  type WorktreeRef,
} from "./completion.js";
import {
  createWorktreeForkSession,
  currentBranch,
  flushSessionToDisk,
  isGitRepo,
  isLinkedWorktree,
  listWorktrees,
  mainWorktreeDir,
  mergeWorktreeAndCleanup,
} from "./operations.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    // Always set or clear: the UI status persists across session switches, so
    // when we /worktree merge back into main we need to wipe the prior wt label.
    const inLinked =
      (await isGitRepo(pi, ctx.cwd)) && (await isLinkedWorktree(pi, ctx.cwd));
    const branch = inLinked ? await currentBranch(pi, ctx.cwd) : null;
    if (branch) {
      ctx.ui.setStatus(
        "worktree",
        ctx.ui.theme.fg("accent", `worktree: ${branch}`),
      );
    } else {
      ctx.ui.setStatus("worktree", undefined);
    }
  });

  pi.registerCommand("worktree", {
    description:
      "Create / merge / switch worktrees forked from current branch. Usage: /worktree [create|merge|switch [<name>]]",
    getArgumentCompletions: async (prefix) =>
      getWorktreeCompletions(pi, prefix),
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "create";

      if (sub === "create") {
        await runCreate(pi, ctx);
      } else if (sub === "merge") {
        await runMerge(pi, ctx, tokens[1]);
      } else if (sub === "switch") {
        await runSwitch(pi, ctx, tokens[1]);
      } else {
        ctx.ui.notify(
          `Worktree: unknown subcommand "${sub}". Usage: /worktree [create|merge|switch [<name>]]`,
          "warning",
        );
      }
    },
  });
}

async function getWorktreeCompletions(
  pi: ExtensionAPI,
  prefix: string,
): Promise<AutocompleteItem[]> {
  const parsed = parseCompletionPrefix(prefix);

  // Subcommand completions don't need any IO — short-circuit before hitting git.
  if (parsed.stage === "sub") {
    return buildCompletionItems(parsed, "", []);
  }
  if (parsed.sub !== "merge" && parsed.sub !== "switch") return [];

  const cwd = process.cwd();
  if (!(await isGitRepo(pi, cwd))) return [];
  const mainDir = await mainWorktreeDir(pi, cwd);
  if (!mainDir) return [];
  const all = await listWorktrees(pi, mainDir);
  const mainResolved = path.resolve(mainDir);
  const linked: WorktreeRef[] = all
    .filter((w) => w.branch && path.resolve(w.path) !== mainResolved)
    .map((w) => ({ path: w.path, branch: w.branch as string }));

  return buildCompletionItems(parsed, mainDir, linked);
}

async function runCreate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const r = await createWorktreeForkSession(pi, ctx, {
    withSession: async (replacementCtx, result) => {
      notifyCreated(replacementCtx, result.handle, result.warnings);
    },
  });
  if (!r.ok) {
    ctx.ui.notify(`Worktree: ${r.error}`, "error");
    return;
  }
  if (r.switched) return;
  notifyCreated(ctx, r.handle, r.warnings);
}

function notifyCreated(
  ctx: ExtensionCommandContext,
  handle: { branch: string; worktreePath: string },
  warnings: string[] | undefined,
): void {
  ctx.ui.notify(
    `Worktree: created ${handle.branch} at ${handle.worktreePath}`,
    "info",
  );
  if (warnings) {
    for (const w of warnings) {
      ctx.ui.notify(`Worktree: ${w}`, "warning");
    }
  }
}

async function runMerge(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string | undefined,
): Promise<void> {
  if (!(await isGitRepo(pi, ctx.cwd))) {
    ctx.ui.notify("Worktree: not inside a git repository", "error");
    return;
  }
  const mainDir = await mainWorktreeDir(pi, ctx.cwd);
  if (!mainDir) {
    ctx.ui.notify("Worktree: could not determine main worktree", "error");
    return;
  }

  const all = await listWorktrees(pi, mainDir);
  const linked = all.filter(
    (w) => w.branch && path.resolve(w.path) !== path.resolve(mainDir),
  ) as { path: string; branch: string }[];

  if (linked.length === 0) {
    ctx.ui.notify("Worktree: no linked worktrees to merge", "warning");
    return;
  }

  const cwdResolved = path.resolve(ctx.cwd);
  const inLinked = await isLinkedWorktree(pi, ctx.cwd);

  let target: { path: string; branch: string } | undefined;
  if (name) {
    target = linked.find(
      (w) => w.branch === name || path.basename(w.path) === name,
    );
    if (!target) {
      ctx.ui.notify(`Worktree: no worktree found matching "${name}"`, "error");
      return;
    }
  } else if (inLinked) {
    target = linked.find((w) => path.resolve(w.path) === cwdResolved);
    if (!target) {
      ctx.ui.notify(
        "Worktree: could not match current cwd to a linked worktree",
        "error",
      );
      return;
    }
  } else if (linked.length === 1) {
    target = linked[0];
  } else {
    const pick = await ctx.ui.select(
      "Select worktree to merge",
      linked.map((w) => w.branch),
    );
    if (!pick) return;
    target = linked.find((w) => w.branch === pick);
    if (!target) return;
  }

  // Re-derive the parent for the notification (mergeWorktreeAndCleanup
  // already validated the suffix, so this won't be null).
  const parent = target.branch.replace(/-wt-\d+$/, "");
  const r = await mergeWorktreeAndCleanup(
    pi,
    ctx,
    {
      worktreePath: target.path,
      branch: target.branch,
    },
    {
      withSession: async (replacementCtx, result) => {
        notifyMerged(
          replacementCtx,
          target.branch,
          parent,
          result.warnings,
        );
      },
    },
  );
  if (!r.ok) {
    ctx.ui.notify(`Worktree: ${r.error}`, "error");
    return;
  }
  if (r.switched) return;
  notifyMerged(ctx, target.branch, parent, r.warnings);
}

function notifyMerged(
  ctx: ExtensionCommandContext,
  branch: string,
  parent: string,
  warnings: string[] | undefined,
): void {
  ctx.ui.notify(
    `Worktree: merged ${branch} into ${parent} and cleaned up`,
    "info",
  );
  if (warnings) {
    for (const w of warnings) {
      ctx.ui.notify(`Worktree: ${w}`, "warning");
    }
  }
}

async function runSwitch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string | undefined,
): Promise<void> {
  if (!(await isGitRepo(pi, ctx.cwd))) {
    ctx.ui.notify("Worktree: not inside a git repository", "error");
    return;
  }
  const mainDir = await mainWorktreeDir(pi, ctx.cwd);
  if (!mainDir) {
    ctx.ui.notify("Worktree: could not determine main worktree", "error");
    return;
  }

  const all = await listWorktrees(pi, mainDir);
  const mainResolved = path.resolve(mainDir);
  const linked = all.filter(
    (w) => w.branch && path.resolve(w.path) !== mainResolved,
  ) as { path: string; branch: string }[];

  const cwdResolved = path.resolve(ctx.cwd);
  const inLinked = await isLinkedWorktree(pi, ctx.cwd);

  let targetPath: string | undefined;
  let targetLabel: string | undefined;

  if (name === "main" || name === path.basename(mainDir)) {
    targetPath = mainDir;
    targetLabel = "main";
  } else if (name) {
    const t = linked.find(
      (w) => w.branch === name || path.basename(w.path) === name,
    );
    if (!t) {
      ctx.ui.notify(`Worktree: no worktree found matching "${name}"`, "error");
      return;
    }
    targetPath = t.path;
    targetLabel = t.branch;
  } else if (inLinked) {
    targetPath = mainDir;
    targetLabel = "main";
  } else if (linked.length === 1) {
    targetPath = linked[0].path;
    targetLabel = linked[0].branch;
  } else if (linked.length === 0) {
    ctx.ui.notify(
      "Worktree: nowhere to switch — no linked worktrees and you're already in main",
      "warning",
    );
    return;
  } else {
    // Picker only fires when in main with multiple linked worktrees, so don't
    // offer "main" as an option (we're already there).
    const choices = linked.map((w) => w.branch);
    const pick = await ctx.ui.select("Switch to", choices);
    if (!pick) return;
    const t = linked.find((w) => w.branch === pick);
    if (!t) return;
    targetPath = t.path;
    targetLabel = t.branch;
  }

  if (path.resolve(targetPath) === cwdResolved) {
    ctx.ui.notify(`Worktree: already in ${targetLabel}`, "info");
    return;
  }

  // Resolve the destination session: prefer the most recent existing session
  // for the target cwd (so each worktree retains its own conversation
  // thread); fall back to forking current into target on first visit.
  let destPath: string | undefined;
  try {
    const sessions = await SessionManager.list(targetPath);
    if (sessions.length > 0) destPath = sessions[0].path;
  } catch {
    // ignore — fall through to fork
  }

  if (!destPath) {
    const sourceFile = ctx.sessionManager.getSessionFile();
    if (!sourceFile) {
      ctx.ui.notify("Worktree: no source session file to fork from", "error");
      return;
    }
    const flushErr = await flushSessionToDisk(ctx, sourceFile);
    if (flushErr) {
      ctx.ui.notify(`Worktree: ${flushErr}`, "error");
      return;
    }
    try {
      const forked = SessionManager.forkFrom(sourceFile, targetPath);
      const fp = forked.getSessionFile();
      if (!fp) throw new Error("forked session has no file path");
      destPath = fp;
    } catch (e) {
      ctx.ui.notify(
        `Worktree: session fork failed: ${(e as Error).message}`,
        "error",
      );
      return;
    }
  }

  await ctx.waitForIdle();
  await ctx.switchSession(destPath);
}

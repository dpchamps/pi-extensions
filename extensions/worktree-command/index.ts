/**
 * worktree-command extension — /worktree manages git worktrees forked from
 * the current branch under .worktrees/.
 *
 *   /worktree                  create a new worktree on a fresh <current>-wt-<n>
 *   /worktree merge [<name>]   merge a linked worktree into its parent and clean up
 *   /worktree switch [<name>]  switch session/cwd to another worktree (or "main")
 *
 * Tab-completion: subcommands first, then linked-worktree branch names.
 * `switch` also offers "main" as an option.
 *
 * On session start: if cwd is inside a linked worktree, set a persistent
 * "worktree: <branch>" status indicator (cleared otherwise).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExecResult,
} from "@mariozechner/pi-coding-agent";
import {
  buildCompletionItems,
  parentBranchOf,
  parseCompletionPrefix,
  type AutocompleteItem,
  type WorktreeRef,
} from "./completion.js";

async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
): Promise<ExecResult> {
  return await pi.exec("git", args, { cwd });
}

async function isGitRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const r = await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

async function currentBranch(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | null> {
  const r = await git(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.code !== 0) return null;
  const b = r.stdout.trim();
  if (!b || b === "HEAD") return null;
  return b;
}

async function isLinkedWorktree(
  pi: ExtensionAPI,
  cwd: string,
): Promise<boolean> {
  const common = await git(pi, cwd, ["rev-parse", "--git-common-dir"]);
  const dir = await git(pi, cwd, ["rev-parse", "--git-dir"]);
  if (common.code !== 0 || dir.code !== 0) return false;
  return (
    path.resolve(cwd, common.stdout.trim()) !==
    path.resolve(cwd, dir.stdout.trim())
  );
}

async function mainWorktreeDir(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | null> {
  const r = await git(pi, cwd, ["rev-parse", "--git-common-dir"]);
  if (r.code !== 0) return null;
  return path.dirname(path.resolve(cwd, r.stdout.trim()));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function nextWorktreeIndex(
  pi: ExtensionAPI,
  cwd: string,
  branch: string,
): Promise<number> {
  const r = await git(pi, cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);
  if (r.code !== 0) return 1;
  const re = new RegExp(`^${escapeRegExp(branch)}-wt-(\\d+)$`);
  let max = 0;
  for (const line of r.stdout.split("\n")) {
    const m = line.trim().match(re);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

async function ensureGitignored(
  repoRoot: string,
  entry: string,
): Promise<void> {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let contents = "";
  try {
    contents = await fs.promises.readFile(gitignorePath, "utf8");
  } catch {
    // file may not exist yet
  }
  const normalized = entry.replace(/^\/+|\/+$/g, "");
  for (const line of contents.split("\n")) {
    const stripped = line.trim().replace(/^\/+|\/+$/g, "");
    if (stripped === normalized) return;
  }
  const sep = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  await fs.promises.writeFile(gitignorePath, `${contents}${sep}${entry}\n`);
}

async function isCleanTree(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const r = await git(pi, cwd, ["status", "--porcelain"]);
  return r.code === 0 && r.stdout.trim() === "";
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

async function listWorktrees(
  pi: ExtensionAPI,
  mainDir: string,
): Promise<WorktreeEntry[]> {
  const r = await git(pi, mainDir, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return [];
  const out: WorktreeEntry[] = [];
  let curPath: string | undefined;
  let curBranch: string | null = null;
  const flush = () => {
    if (curPath) out.push({ path: curPath, branch: curBranch });
    curPath = undefined;
    curBranch = null;
  };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      curPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      curBranch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    // Always set or clear: the UI status persists across session switches, so
    // when we /worktree merge back into main we need to wipe the prior wt label.
    const inLinked =
      (await isGitRepo(pi, ctx.cwd)) &&
      (await isLinkedWorktree(pi, ctx.cwd));
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
  if (!(await isGitRepo(pi, ctx.cwd))) {
    ctx.ui.notify("Worktree: not inside a git repository", "error");
    return;
  }
  const branch = await currentBranch(pi, ctx.cwd);
  if (!branch) {
    ctx.ui.notify(
      "Worktree: HEAD is detached or branch lookup failed",
      "error",
    );
    return;
  }
  const mainDir = await mainWorktreeDir(pi, ctx.cwd);
  if (!mainDir) {
    ctx.ui.notify("Worktree: could not determine main worktree", "error");
    return;
  }

  const n = await nextWorktreeIndex(pi, ctx.cwd, branch);
  const newBranch = `${branch}-wt-${n}`;
  const relPath = path.join(".worktrees", newBranch);
  const absPath = path.resolve(mainDir, relPath);

  const result = await git(pi, mainDir, [
    "worktree",
    "add",
    "-b",
    newBranch,
    relPath,
  ]);
  if (result.code !== 0) {
    ctx.ui.notify(
      `Worktree: 'git worktree add' failed: ${result.stderr.trim() || result.stdout.trim()}`,
      "error",
    );
    return;
  }

  try {
    await ensureGitignored(mainDir, ".worktrees/");
  } catch (e) {
    ctx.ui.notify(
      `Worktree: created but failed to update .gitignore: ${(e as Error).message}`,
      "warning",
    );
  }

  ctx.ui.notify(`Worktree: created ${newBranch} at ${absPath}`, "info");

  // Fork the current session into the worktree's cwd. pi's switchSession()
  // reads the new header's cwd and process.chdir()s to it, so the user lands
  // in the worktree seamlessly with full conversation history preserved.
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  if (!sourceSessionFile) {
    ctx.ui.notify(
      "Worktree: created but no source session file to fork from",
      "warning",
    );
    return;
  }

  const flushErr = await flushSessionToDisk(ctx, sourceSessionFile);
  if (flushErr) {
    ctx.ui.notify(`Worktree: created but ${flushErr}`, "warning");
    return;
  }

  let forkedPath: string;
  try {
    const forked = SessionManager.forkFrom(sourceSessionFile, absPath);
    const fp = forked.getSessionFile();
    if (!fp) {
      throw new Error("forked session has no file path");
    }
    forkedPath = fp;
  } catch (e) {
    ctx.ui.notify(
      `Worktree: created but session fork failed: ${(e as Error).message}`,
      "warning",
    );
    return;
  }

  await ctx.waitForIdle();
  await ctx.switchSession(forkedPath);
}

/**
 * Pi delays writing the session file to disk until the first assistant message.
 * forkFrom and parentSession lookups read from disk, so this helper materializes
 * the current in-memory session to its on-disk path when missing. Returns
 * undefined on success, or an error message string on failure.
 */
async function flushSessionToDisk(
  ctx: ExtensionCommandContext,
  sessionFile: string,
): Promise<string | undefined> {
  if (fs.existsSync(sessionFile)) return undefined;
  const header = ctx.sessionManager.getHeader();
  if (!header) return "current session has no header to flush";
  const entries = ctx.sessionManager.getEntries();
  const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n");
  try {
    await fs.promises.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.promises.writeFile(sessionFile, `${lines}\n`);
  } catch (e) {
    return `failed to flush source session: ${(e as Error).message}`;
  }
  return undefined;
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

  const parent = parentBranchOf(target.branch);
  if (!parent) {
    ctx.ui.notify(
      `Worktree: cannot derive parent branch from "${target.branch}" (expected <parent>-wt-<n>)`,
      "error",
    );
    return;
  }

  if (!(await isCleanTree(pi, target.path))) {
    ctx.ui.notify(
      `Worktree: ${target.branch} has uncommitted changes — commit or stash first`,
      "error",
    );
    return;
  }

  const parentExists = await git(pi, mainDir, [
    "rev-parse",
    "--verify",
    `refs/heads/${parent}`,
  ]);
  if (parentExists.code !== 0) {
    ctx.ui.notify(
      `Worktree: parent branch "${parent}" no longer exists`,
      "error",
    );
    return;
  }

  // Is pi sitting inside the worktree we're about to remove? If so, we'll
  // need to switch session out of it as the very last step.
  const targetResolved = path.resolve(target.path);
  const piInTarget =
    cwdResolved === targetResolved ||
    cwdResolved.startsWith(`${targetResolved}${path.sep}`);

  // Pre-flush our session if we'll need it for the post-cleanup switch.
  // (forkFrom reads from disk and the file may not exist yet.)
  const sourceSessionFile = piInTarget
    ? ctx.sessionManager.getSessionFile()
    : undefined;
  if (piInTarget) {
    if (!sourceSessionFile) {
      ctx.ui.notify(
        "Worktree: cannot merge from inside worktree — no source session file",
        "error",
      );
      return;
    }
    const flushErr = await flushSessionToDisk(ctx, sourceSessionFile);
    if (flushErr) {
      ctx.ui.notify(`Worktree: ${flushErr}`, "error");
      return;
    }
  }

  const originalMain = await currentBranch(pi, mainDir);
  const needsRestoreMain =
    originalMain !== null &&
    originalMain !== parent &&
    originalMain !== target.branch;

  if (originalMain !== parent) {
    const co = await git(pi, mainDir, ["checkout", parent]);
    if (co.code !== 0) {
      ctx.ui.notify(
        `Worktree: failed to checkout parent "${parent}" in main: ${co.stderr.trim()}`,
        "error",
      );
      return;
    }
  }

  const merge = await git(pi, mainDir, ["merge", "--no-edit", target.branch]);
  if (merge.code !== 0) {
    await git(pi, mainDir, ["merge", "--abort"]);
    if (needsRestoreMain && originalMain) {
      await git(pi, mainDir, ["checkout", originalMain]);
    }
    ctx.ui.notify(
      `Worktree: merge of ${target.branch} into ${parent} failed (conflicts) — aborted`,
      "error",
    );
    return;
  }

  // Removal uses cwd=mainDir, so it's safe to issue even when process.cwd()
  // is inside the worktree being removed — git itself doesn't care, and we
  // won't access the deleted path before switchSession chdir's us out.
  const remove = await git(pi, mainDir, ["worktree", "remove", target.path]);
  if (remove.code !== 0) {
    ctx.ui.notify(
      `Worktree: merged but failed to remove worktree: ${remove.stderr.trim()}`,
      "warning",
    );
  }

  const del = await git(pi, mainDir, ["branch", "-d", target.branch]);
  if (del.code !== 0) {
    ctx.ui.notify(
      `Worktree: merged but failed to delete branch ${target.branch}: ${del.stderr.trim()}`,
      "warning",
    );
  }

  if (needsRestoreMain && originalMain) {
    await git(pi, mainDir, ["checkout", originalMain]);
  }

  ctx.ui.notify(
    `Worktree: merged ${target.branch} into ${parent} and cleaned up`,
    "info",
  );

  if (piInTarget && sourceSessionFile) {
    await switchOutOfWorktree(ctx, mainDir, sourceSessionFile);
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
      ctx.ui.notify(
        "Worktree: no source session file to fork from",
        "error",
      );
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

/**
 * Move pi's session out of a worktree directory that's about to be (or was just)
 * removed. Prefers the parent session recorded in the current session header
 * (the session we forked from on /worktree create); falls back to forking the
 * current session into mainDir so the conversation history isn't lost.
 */
async function switchOutOfWorktree(
  ctx: ExtensionCommandContext,
  mainDir: string,
  sourceSessionFile: string,
): Promise<void> {
  const header = ctx.sessionManager.getHeader();
  const parentPath = header?.parentSession;
  await ctx.waitForIdle();

  if (parentPath && fs.existsSync(parentPath)) {
    await ctx.switchSession(parentPath);
    return;
  }

  try {
    const forked = SessionManager.forkFrom(sourceSessionFile, mainDir);
    const fp = forked.getSessionFile();
    if (!fp) throw new Error("forked session has no file path");
    await ctx.switchSession(fp);
  } catch (e) {
    ctx.ui.notify(
      `Worktree: cleanup done but couldn't return to main session: ${(e as Error).message}`,
      "warning",
    );
  }
}

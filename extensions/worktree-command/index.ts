/**
 * worktree-command extension — /worktree manages git worktrees forked from
 * the current branch under .worktrees/.
 *
 *   /worktree            create a new worktree on a fresh <current>-wt-<n>
 *   /worktree merge [n]  merge a linked worktree into its parent and clean up
 *
 * On session start: if cwd is inside a linked worktree, set a persistent
 * "worktree: <branch>" status indicator.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExecResult,
} from "@mariozechner/pi-coding-agent";

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

function parentBranchOf(wtBranch: string): string | null {
  const m = wtBranch.match(/^(.+)-wt-\d+$/);
  return m ? m[1] : null;
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
    if (!(await isGitRepo(pi, ctx.cwd))) return;
    if (!(await isLinkedWorktree(pi, ctx.cwd))) return;
    const branch = await currentBranch(pi, ctx.cwd);
    if (!branch) return;
    ctx.ui.setStatus(
      "worktree",
      ctx.ui.theme.fg("accent", `worktree: ${branch}`),
    );
  });

  pi.registerCommand("worktree", {
    description:
      "Create or merge a worktree forked from the current branch. Usage: /worktree [merge [<name>]]",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "create";

      if (sub === "create") {
        await runCreate(pi, ctx);
      } else if (sub === "merge") {
        await runMerge(pi, ctx, tokens[1]);
      } else {
        ctx.ui.notify(
          `Worktree: unknown subcommand "${sub}". Usage: /worktree [merge [<name>]]`,
          "warning",
        );
      }
    },
  });
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

  const switchIn = await ctx.ui.confirm(
    "Switch into new worktree?",
    `Re-launch pi in ${absPath}. The current session ends but stays on disk (resume with pi --resume).`,
  );
  if (switchIn) {
    await switchToWorktree(ctx, absPath);
  }
}

async function switchToWorktree(
  ctx: ExtensionCommandContext,
  cwd: string,
): Promise<void> {
  await ctx.waitForIdle();
  // node binary + cli.js path + any extra argv pi was launched with.
  const node = process.argv[0];
  const cli = process.argv[1];
  const extraArgs = process.argv.slice(2);

  const exitCode = await ctx.ui.custom<number | null>(
    (tui, _theme, _kb, done) => {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");
      const result = spawnSync(node, [cli, ...extraArgs], {
        stdio: "inherit",
        cwd,
        env: process.env,
      });
      done(result.status);
      return { render: () => [], invalidate: () => {} };
    },
  );

  process.exit(exitCode ?? 0);
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
  if (await isLinkedWorktree(pi, ctx.cwd)) {
    ctx.ui.notify(
      "Worktree: run /worktree merge from the main worktree",
      "error",
    );
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

  let target: { path: string; branch: string } | undefined;
  if (name) {
    target = linked.find(
      (w) => w.branch === name || path.basename(w.path) === name,
    );
    if (!target) {
      ctx.ui.notify(`Worktree: no worktree found matching "${name}"`, "error");
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
    ctx.ui.notify(`Worktree: parent branch "${parent}" no longer exists`, "error");
    return;
  }

  const original = await currentBranch(pi, mainDir);
  const needsRestore = original !== null && original !== parent;

  if (original !== parent) {
    const co = await git(pi, mainDir, ["checkout", parent]);
    if (co.code !== 0) {
      ctx.ui.notify(
        `Worktree: failed to checkout parent "${parent}": ${co.stderr.trim()}`,
        "error",
      );
      return;
    }
  }

  const merge = await git(pi, mainDir, [
    "merge",
    "--no-edit",
    target.branch,
  ]);
  if (merge.code !== 0) {
    await git(pi, mainDir, ["merge", "--abort"]);
    if (needsRestore && original) {
      await git(pi, mainDir, ["checkout", original]);
    }
    ctx.ui.notify(
      `Worktree: merge of ${target.branch} into ${parent} failed (conflicts) — aborted`,
      "error",
    );
    return;
  }

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

  if (needsRestore && original) {
    await git(pi, mainDir, ["checkout", original]);
  }

  ctx.ui.notify(
    `Worktree: merged ${target.branch} into ${parent} and cleaned up`,
    "info",
  );
}

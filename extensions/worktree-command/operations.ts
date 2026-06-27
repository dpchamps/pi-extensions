/**
 * worktree operations — git + session-fork primitives shared between the
 * /worktree command (in index.ts) and other extensions that need to create
 * or merge worktrees programmatically (e.g. /pipeline).
 *
 * These functions never call ctx.ui.notify. Callers handle UX. Soft warnings
 * (e.g. ".gitignore update failed but the worktree was created") are returned
 * in the `warnings` field of the result for callers to surface as they wish.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExecResult,
} from "@mariozechner/pi-coding-agent";
import { parentBranchOf } from "./completion.js";

export interface WorktreeHandle {
  worktreePath: string;
  branch: string;
  parent: string;
  mainDir: string;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export type CreateResult =
  | {
      ok: true;
      handle: WorktreeHandle;
      warnings?: string[];
      switched?: boolean;
    }
  | { ok: false; error: string };

export type MergeResult =
  | { ok: true; warnings?: string[]; switched?: boolean }
  | { ok: false; conflicts: boolean; error: string };

export interface CreateWorktreeForkSessionOptions {
  withSession?: (
    ctx: ExtensionCommandContext,
    result: { handle: WorktreeHandle; warnings?: string[] },
  ) => Promise<void> | void;
}

export interface MergeWorktreeAndCleanupOptions {
  withSession?: (
    ctx: ExtensionCommandContext,
    result: { warnings?: string[] },
  ) => Promise<void> | void;
}

async function switchSessionWithOptions(
  ctx: ExtensionCommandContext,
  sessionPath: string,
  options?: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> | void },
): Promise<{ cancelled: boolean }> {
  // Older package typings do not include the post-replacement withSession
  // option, but newer pi runtimes require it for any work after a session
  // replacement. Cast locally so this extension remains compatible while using
  // the fresh replacement context when available.
  const switchSession = ctx.switchSession as unknown as (
    sessionPath: string,
    options?: {
      withSession?: (ctx: ExtensionCommandContext) => Promise<void> | void;
    },
  ) => Promise<{ cancelled: boolean }>;
  return await switchSession(sessionPath, options);
}

async function forkCurrentSessionToCwd(
  ctx: ExtensionCommandContext,
  targetCwd: string,
  parentSession: string,
): Promise<string> {
  // Use the live SessionManager entries, not the source file on disk. New pi
  // versions intentionally defer writing user-only sessions until an assistant
  // reply exists; reading the file here can therefore produce an empty fork.
  const forked = SessionManager.create(targetCwd);
  const forkedPath = forked.getSessionFile();
  const forkedHeader = forked.getHeader();
  if (!forkedPath || !forkedHeader) {
    throw new Error("forked session has no file path or header");
  }
  const header = { ...forkedHeader, parentSession };
  const entries = ctx.sessionManager.getEntries();
  const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n");
  await fs.promises.mkdir(path.dirname(forkedPath), { recursive: true });
  await fs.promises.writeFile(forkedPath, `${lines}\n`);
  return forkedPath;
}

async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
): Promise<ExecResult> {
  return await pi.exec("git", args, { cwd });
}

export async function isGitRepo(
  pi: ExtensionAPI,
  cwd: string,
): Promise<boolean> {
  const r = await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function currentBranch(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | null> {
  const r = await git(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.code !== 0) return null;
  const b = r.stdout.trim();
  if (!b || b === "HEAD") return null;
  return b;
}

export async function isLinkedWorktree(
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

export async function mainWorktreeDir(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | null> {
  const r = await git(pi, cwd, ["rev-parse", "--git-common-dir"]);
  if (r.code !== 0) return null;
  return path.dirname(path.resolve(cwd, r.stdout.trim()));
}

export async function isCleanTree(
  pi: ExtensionAPI,
  cwd: string,
): Promise<boolean> {
  const r = await git(pi, cwd, ["status", "--porcelain"]);
  return r.code === 0 && r.stdout.trim() === "";
}

export async function listWorktrees(
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

/**
 * Pi delays writing a brand-new session file until the first assistant message,
 * and user-only turns can therefore exist only in memory. forkFrom and
 * parentSession lookups read from disk, so this helper force-materializes the
 * current in-memory session to its on-disk path before forking/switching.
 * Returns undefined on success, or an error message string on failure.
 */
export async function flushSessionToDisk(
  ctx: ExtensionCommandContext,
  sessionFile: string,
): Promise<string | undefined> {
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

/**
 * Create a new worktree forked from the current branch under
 * `<mainDir>/.worktrees/<currentBranch>-wt-<n>`, fork the session into it,
 * and switch into the new session (process.chdir lands in the worktree).
 *
 * Pi extensions can call this to set up a clean-room environment for an
 * agent task; the returned handle drives the matching mergeWorktreeAndCleanup
 * call to integrate work back to the parent branch.
 */
export async function createWorktreeForkSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options?: CreateWorktreeForkSessionOptions,
): Promise<CreateResult> {
  if (!(await isGitRepo(pi, ctx.cwd))) {
    return { ok: false, error: "not inside a git repository" };
  }
  const branch = await currentBranch(pi, ctx.cwd);
  if (!branch) {
    return { ok: false, error: "HEAD is detached or branch lookup failed" };
  }
  const mainDir = await mainWorktreeDir(pi, ctx.cwd);
  if (!mainDir) {
    return { ok: false, error: "could not determine main worktree" };
  }

  const n = await nextWorktreeIndex(pi, ctx.cwd, branch);
  const newBranch = `${branch}-wt-${n}`;
  const relPath = path.join(".worktrees", newBranch);
  const absPath = path.resolve(mainDir, relPath);
  const handle: WorktreeHandle = {
    worktreePath: absPath,
    branch: newBranch,
    parent: branch,
    mainDir,
  };

  const result = await git(pi, mainDir, [
    "worktree",
    "add",
    "-b",
    newBranch,
    relPath,
  ]);
  if (result.code !== 0) {
    return {
      ok: false,
      error: `'git worktree add' failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }

  const warnings: string[] = [];

  try {
    await ensureGitignored(mainDir, ".worktrees/");
  } catch (e) {
    warnings.push(
      `created but failed to update .gitignore: ${(e as Error).message}`,
    );
  }

  // Fork the current in-memory session into the worktree's cwd. pi's
  // switchSession() reads the new header's cwd and process.chdir()s to it, so
  // the user lands in the worktree seamlessly with full conversation history
  // preserved.
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  if (!sourceSessionFile) {
    warnings.push("created but no source session file to fork from");
    return { ok: true, handle, warnings, switched: false };
  }

  const flushErr = await flushSessionToDisk(ctx, sourceSessionFile);
  if (flushErr) {
    warnings.push(`created but ${flushErr}`);
    return { ok: true, handle, warnings, switched: false };
  }

  let forkedPath: string;
  try {
    forkedPath = await forkCurrentSessionToCwd(ctx, absPath, sourceSessionFile);
  } catch (e) {
    warnings.push(`created but session fork failed: ${(e as Error).message}`);
    return { ok: true, handle, warnings, switched: false };
  }

  await ctx.waitForIdle();
  const switchResult = await switchSessionWithOptions(ctx, forkedPath, {
    withSession: options?.withSession
      ? async (replacementCtx) => {
          await options.withSession?.(replacementCtx, {
            handle,
            warnings: warnings.length ? warnings : undefined,
          });
        }
      : undefined,
  });
  if (switchResult.cancelled) {
    warnings.push("created but session switch was cancelled");
    return { ok: true, handle, warnings, switched: false };
  }

  return {
    ok: true,
    handle,
    warnings: warnings.length ? warnings : undefined,
    switched: true,
  };
}

/**
 * Merge a worktree's branch into its parent (`<parent>-wt-<n>` → `<parent>`),
 * remove the worktree directory, delete the branch, and switch the session
 * back out of the worktree if pi was inside it.
 *
 * `target` only needs `worktreePath` + `branch`; everything else is rederived.
 * Returns `{ ok: false, conflicts: true }` on merge conflict (the merge is
 * aborted with `git merge --abort` before returning).
 */
export async function mergeWorktreeAndCleanup(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  target: { worktreePath: string; branch: string },
  options?: MergeWorktreeAndCleanupOptions,
): Promise<MergeResult> {
  if (!(await isGitRepo(pi, ctx.cwd))) {
    return {
      ok: false,
      conflicts: false,
      error: "not inside a git repository",
    };
  }
  const mainDir = await mainWorktreeDir(pi, ctx.cwd);
  if (!mainDir) {
    return {
      ok: false,
      conflicts: false,
      error: "could not determine main worktree",
    };
  }

  const parent = parentBranchOf(target.branch);
  if (!parent) {
    return {
      ok: false,
      conflicts: false,
      error: `cannot derive parent branch from "${target.branch}" (expected <parent>-wt-<n>)`,
    };
  }

  if (!(await isCleanTree(pi, target.worktreePath))) {
    return {
      ok: false,
      conflicts: false,
      error: `${target.branch} has uncommitted changes — commit or stash first`,
    };
  }

  const parentExists = await git(pi, mainDir, [
    "rev-parse",
    "--verify",
    `refs/heads/${parent}`,
  ]);
  if (parentExists.code !== 0) {
    return {
      ok: false,
      conflicts: false,
      error: `parent branch "${parent}" no longer exists`,
    };
  }

  // Is pi sitting inside the worktree we're about to remove? If so, we'll
  // need to switch session out of it as the very last step.
  const cwdResolved = path.resolve(ctx.cwd);
  const targetResolved = path.resolve(target.worktreePath);
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
      return {
        ok: false,
        conflicts: false,
        error: "cannot merge from inside worktree — no source session file",
      };
    }
    const flushErr = await flushSessionToDisk(ctx, sourceSessionFile);
    if (flushErr) {
      return { ok: false, conflicts: false, error: flushErr };
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
      return {
        ok: false,
        conflicts: false,
        error: `failed to checkout parent "${parent}" in main: ${co.stderr.trim()}`,
      };
    }
  }

  const merge = await git(pi, mainDir, ["merge", "--no-edit", target.branch]);
  if (merge.code !== 0) {
    await git(pi, mainDir, ["merge", "--abort"]);
    if (needsRestoreMain && originalMain) {
      await git(pi, mainDir, ["checkout", originalMain]);
    }
    return {
      ok: false,
      conflicts: true,
      error: `merge of ${target.branch} into ${parent} failed (conflicts) — aborted`,
    };
  }

  const warnings: string[] = [];

  // Removal uses cwd=mainDir, so it's safe to issue even when process.cwd()
  // is inside the worktree being removed — git itself doesn't care, and we
  // won't access the deleted path before switchSession chdir's us out.
  const remove = await git(pi, mainDir, [
    "worktree",
    "remove",
    target.worktreePath,
  ]);
  if (remove.code !== 0) {
    warnings.push(
      `merged but failed to remove worktree: ${remove.stderr.trim()}`,
    );
  }

  const del = await git(pi, mainDir, ["branch", "-d", target.branch]);
  if (del.code !== 0) {
    warnings.push(
      `merged but failed to delete branch ${target.branch}: ${del.stderr.trim()}`,
    );
  }

  if (needsRestoreMain && originalMain) {
    await git(pi, mainDir, ["checkout", originalMain]);
  }

  let switched = false;
  if (piInTarget && sourceSessionFile) {
    const switchResult = await switchOutOfWorktree(
      ctx,
      mainDir,
      sourceSessionFile,
      {
        withSession: options?.withSession
          ? async (replacementCtx) => {
              await options.withSession?.(replacementCtx, {
                warnings: warnings.length ? warnings : undefined,
              });
            }
          : undefined,
      },
    );
    switched = switchResult.switched;
    if (switchResult.error) warnings.push(switchResult.error);
  }

  return {
    ok: true,
    warnings: warnings.length ? warnings : undefined,
    switched,
  };
}

/**
 * Move pi's session out of a worktree directory that's about to be (or was just)
 * removed. Prefers the parent session recorded in the current session header
 * (the session we forked from on /worktree create); falls back to forking the
 * current session into mainDir so the conversation history isn't lost.
 *
 * Returns whether a replacement session became active, plus an optional error
 * string for the caller to surface as a warning.
 */
async function switchOutOfWorktree(
  ctx: ExtensionCommandContext,
  mainDir: string,
  sourceSessionFile: string,
  options?: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> | void },
): Promise<{ switched: boolean; error?: string }> {
  const header = ctx.sessionManager.getHeader();
  const parentPath = (header as { parentSession?: string } | undefined)
    ?.parentSession;
  await ctx.waitForIdle();

  if (parentPath && fs.existsSync(parentPath)) {
    try {
      const result = await switchSessionWithOptions(ctx, parentPath, options);
      if (result.cancelled) {
        return {
          switched: false,
          error: "cleanup done but session switch was cancelled",
        };
      }
      return { switched: true };
    } catch (e) {
      return {
        switched: false,
        error: `cleanup done but couldn't return to main session: ${(e as Error).message}`,
      };
    }
  }

  try {
    const forked = SessionManager.forkFrom(sourceSessionFile, mainDir);
    const fp = forked.getSessionFile();
    if (!fp) throw new Error("forked session has no file path");
    const result = await switchSessionWithOptions(ctx, fp, options);
    if (result.cancelled) {
      return {
        switched: false,
        error: "cleanup done but session switch was cancelled",
      };
    }
    return { switched: true };
  } catch (e) {
    return {
      switched: false,
      error: `cleanup done but couldn't return to main session: ${(e as Error).message}`,
    };
  }
}

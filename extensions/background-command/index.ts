/**
 * background-command extension — /background detaches the running foreground
 * task into a supervised pi --mode rpc child process so the user can keep
 * working in the foreground.
 *
 *   /background                    detach the current foreground task
 *   /background list [active|paused|killed]
 *                                  render the task tree (interactive picker → resume)
 *   /background resume <id>        stop the child, swap foreground session to it
 *   /background kill <id>          terminate the child, keep the metadata
 *   /background delete <id>        kill if alive, remove metadata + session file
 *
 * Tab-completion: subcommands first, then status filter (for list) or task IDs
 * (for resume|kill|delete). On session start: footer shows `bg: 2A 1P` when
 * any tasks are tracked.
 *
 * Children die when the parent pi exits — a session_shutdown hook stops each
 * RpcChild so no `pi --mode rpc` processes are orphaned.
 */

import * as fs from "node:fs";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  buildCompletionItems,
  parseCompletionPrefix,
  STATUS_FILTERS,
  truncatePrompt,
  type AutocompleteItem,
  type StatusFilter,
  type TaskRef,
} from "./completion.js";
import {
  BackgroundStore,
  type BackgroundTask,
  type TaskTreeNode,
} from "./store.js";
import {
  findLastInteractiveUserMessage,
  flushSessionToDisk,
  RpcChild,
} from "./runner.js";

const CONCURRENT_WARN_AT = 5;
const DETACH_MARKER_TYPE = "background-detach";

export default function (pi: ExtensionAPI) {
  const store = new BackgroundStore();
  let lastUiCtx: ExtensionContext | null = null;

  const refreshStatus = (ctx: ExtensionContext | null = lastUiCtx): void => {
    if (!ctx?.hasUI) return;
    const tasks = store.all();
    if (tasks.length === 0) {
      ctx.ui.setStatus("background", undefined);
      return;
    }
    let active = 0;
    let paused = 0;
    let killed = 0;
    for (const t of tasks) {
      const s = store.statusOf(t);
      if (s === "active") active++;
      else if (s === "paused") paused++;
      else killed++;
    }
    const parts: string[] = [];
    if (active) parts.push(`${active}A`);
    if (paused) parts.push(`${paused}P`);
    if (killed) parts.push(`${killed}K`);
    ctx.ui.setStatus(
      "background",
      ctx.ui.theme.fg("accent", `bg: ${parts.join(" ")}`),
    );
  };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    lastUiCtx = ctx;
    refreshStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    for (const t of store.all()) {
      try {
        await t.client.stop();
      } catch {
        // best-effort cleanup; we're shutting down anyway
      }
    }
  });

  pi.registerCommand("background", {
    description:
      "Detach the running foreground task into a background pi RPC child. Subcommands: list|resume|kill|delete",
    getArgumentCompletions: async (prefix) =>
      getBackgroundCompletions(store, prefix),
    handler: async (args, ctx) => {
      lastUiCtx = ctx;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (!sub) {
        await runDetach(pi, ctx, store, refreshStatus);
        return;
      }
      if (sub === "list") {
        await runList(ctx, store, parseStatusFilter(tokens[1]), refreshStatus);
        return;
      }
      if (sub === "resume") {
        await runResume(ctx, store, tokens[1], refreshStatus);
        return;
      }
      if (sub === "kill") {
        await runKill(ctx, store, tokens[1], refreshStatus);
        return;
      }
      if (sub === "delete") {
        await runDelete(ctx, store, tokens[1], refreshStatus);
        return;
      }

      ctx.ui.notify(
        `Background: unknown subcommand "${sub}". Usage: /background [list|resume|kill|delete]`,
        "warning",
      );
    },
  });
}

function parseStatusFilter(token: string | undefined): StatusFilter | undefined {
  if (!token) return undefined;
  return (STATUS_FILTERS as readonly string[]).includes(token)
    ? (token as StatusFilter)
    : undefined;
}

function buildTaskRefs(store: BackgroundStore): TaskRef[] {
  return store.all().map((t) => ({
    id: t.id,
    status: store.statusOf(t),
    promptPreview: truncatePrompt(t.firstPrompt, 50),
  }));
}

function getBackgroundCompletions(
  store: BackgroundStore,
  prefix: string,
): AutocompleteItem[] {
  const parsed = parseCompletionPrefix(prefix);
  if (parsed.stage === "sub") return buildCompletionItems(parsed, []);

  const sub = parsed.sub;
  let refs = buildTaskRefs(store);
  // resume/kill only make sense for alive tasks; delete works on anything.
  if (sub === "resume" || sub === "kill") {
    refs = refs.filter((r) => r.status !== "killed");
  }
  return buildCompletionItems(parsed, refs);
}

async function runDetach(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  store: BackgroundStore,
  refreshStatus: () => void,
): Promise<void> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    ctx.ui.notify(
      "Background: no foreground session file — nothing to detach",
      "warning",
    );
    return;
  }

  const entries = ctx.sessionManager.getEntries();
  const found = findLastInteractiveUserMessage(entries);
  if (!found) {
    ctx.ui.notify(
      "Background: no interactive user message to hand off — send a prompt first",
      "info",
    );
    return;
  }

  const aliveCount = store
    .all()
    .filter((t) => store.statusOf(t) !== "killed").length;
  if (aliveCount >= CONCURRENT_WARN_AT) {
    ctx.ui.notify(
      `Background: ${aliveCount} background tasks running — child pi processes add up`,
      "warning",
    );
  }

  // Stop the in-flight foreground stream so the abort propagates to disk
  // before we fork. The user message + any partial assistant entry remain in
  // the parent session.
  ctx.abort();
  await ctx.waitForIdle();

  const flushErr = await flushSessionToDisk(ctx, sessionFile);
  if (flushErr) {
    ctx.ui.notify(`Background: ${flushErr}`, "error");
    return;
  }

  let forkedPath: string;
  try {
    const forked = SessionManager.forkFrom(sessionFile, ctx.cwd);
    // Rewind the fork so the child re-issues the user message cleanly
    // instead of inheriting the parent's already-asked state.
    if (found.entry.parentId) {
      forked.branch(found.entry.parentId);
    } else {
      forked.resetLeaf();
    }
    const fp = forked.getSessionFile();
    if (!fp) throw new Error("forked session has no file path");
    forkedPath = fp;
  } catch (e) {
    ctx.ui.notify(
      `Background: session fork failed: ${(e as Error).message}`,
      "error",
    );
    return;
  }

  const id = store.allocId();
  const client = new RpcChild({
    cwd: ctx.cwd,
    sessionFile: forkedPath,
    onEvent: (ev) => {
      if (ev.type === "agent_start") {
        const task = store.get(id);
        if (task) {
          task.isStreaming = true;
          refreshStatus();
        }
      } else if (ev.type === "agent_end") {
        const task = store.get(id);
        if (task) {
          task.isStreaming = false;
          refreshStatus();
        }
      }
    },
  });

  try {
    await client.start();
  } catch (e) {
    ctx.ui.notify(
      `Background: failed to spawn pi rpc child: ${(e as Error).message}`,
      "error",
    );
    return;
  }

  const task: BackgroundTask = {
    id,
    client,
    sessionFile: forkedPath,
    parentSessionFile: sessionFile,
    cwd: ctx.cwd,
    firstPrompt: found.text,
    startedAt: new Date(),
    killed: false,
    isStreaming: true,
  };
  store.register(task);

  // Re-issue the user prompt to the child. Fire-and-forget; we listen via
  // onEvent for status changes.
  client.prompt(found.text);

  // Drop a visible marker into the parent transcript so the LLM (and the user)
  // can see what was handed off. CustomMessageEntry with display:true renders
  // distinctly and is folded into LLM context as a user message — gives the
  // model context that the prior question was moved.
  pi.sendMessage({
    customType: DETACH_MARKER_TYPE,
    content: `[Detached previous request as ${id}. Use /background resume ${id} to take it back, /background list to see all.]`,
    display: true,
  });

  refreshStatus();
  ctx.ui.notify(
    `Background: detached as ${id}. /background list to see, /background resume ${id} to take it back.`,
    "info",
  );
}

async function runList(
  ctx: ExtensionCommandContext,
  store: BackgroundStore,
  filter: StatusFilter | undefined,
  refreshStatus: () => void,
): Promise<void> {
  const filterFn = filter
    ? (t: BackgroundTask) => store.statusOf(t) === filter
    : undefined;
  const tree = store.tree(filterFn);

  if (tree.length === 0) {
    ctx.ui.notify(
      filter
        ? `Background: no ${filter} tasks`
        : "Background: no tasks tracked",
      "info",
    );
    return;
  }

  const lines: string[] = [];
  const idByLine = new Map<string, string>();
  const render = (node: TaskTreeNode, depth: number, isLast: boolean): void => {
    const indent = depth === 0 ? "" : `${"   ".repeat(depth - 1)}${isLast ? "└─ " : "├─ "}`;
    const status = store.statusOf(node.task);
    const elapsed = formatElapsed(Date.now() - node.task.startedAt.getTime());
    const line = `${indent}${node.task.id}  [${status}]  ${truncatePrompt(node.task.firstPrompt, 50)}  (${elapsed})`;
    lines.push(line);
    idByLine.set(line, node.task.id);
    node.children.forEach((c, i) =>
      render(c, depth + 1, i === node.children.length - 1),
    );
  };
  tree.forEach((root, i) => render(root, 0, i === tree.length - 1));

  const picked = await ctx.ui.select("Resume background task", lines);
  if (!picked) return;
  const id = idByLine.get(picked);
  if (!id) return;
  await runResume(ctx, store, id, refreshStatus);
}

async function runResume(
  ctx: ExtensionCommandContext,
  store: BackgroundStore,
  id: string | undefined,
  refreshStatus: () => void,
): Promise<void> {
  if (!id) {
    ctx.ui.notify("Background: usage /background resume <id>", "warning");
    return;
  }
  const task = store.get(id);
  if (!task) {
    ctx.ui.notify(`Background: no task with id "${id}"`, "warning");
    return;
  }

  // Stop the child first — two processes can't safely write the same JSONL.
  try {
    await task.client.stop();
  } catch (e) {
    ctx.ui.notify(
      `Background: failed to stop ${id} cleanly: ${(e as Error).message}`,
      "warning",
    );
  }
  await ctx.waitForIdle();

  if (!fs.existsSync(task.sessionFile)) {
    ctx.ui.notify(
      `Background: ${id}'s session file is gone — removing from registry`,
      "warning",
    );
    store.remove(id);
    refreshStatus();
    return;
  }

  try {
    const result = await ctx.switchSession(task.sessionFile);
    if (result.cancelled) {
      ctx.ui.notify(`Background: switch to ${id} cancelled`, "warning");
      return;
    }
  } catch (e) {
    ctx.ui.notify(
      `Background: failed to switch to ${id}: ${(e as Error).message}`,
      "error",
    );
    return;
  }

  store.remove(id);
  refreshStatus();
  ctx.ui.notify(`Background: resumed ${id}`, "info");
}

async function runKill(
  ctx: ExtensionCommandContext,
  store: BackgroundStore,
  id: string | undefined,
  refreshStatus: () => void,
): Promise<void> {
  if (!id) {
    ctx.ui.notify("Background: usage /background kill <id>", "warning");
    return;
  }
  const task = store.get(id);
  if (!task) {
    ctx.ui.notify(`Background: no task with id "${id}"`, "warning");
    return;
  }
  if (task.killed) {
    ctx.ui.notify(`Background: ${id} is already killed`, "info");
    return;
  }

  try {
    task.client.abort();
    await task.client.stop();
  } catch (e) {
    ctx.ui.notify(
      `Background: kill ${id} hit an error: ${(e as Error).message}`,
      "warning",
    );
  }
  task.killed = true;
  task.isStreaming = false;
  refreshStatus();
  ctx.ui.notify(`Background: killed ${id}`, "info");
}

async function runDelete(
  ctx: ExtensionCommandContext,
  store: BackgroundStore,
  id: string | undefined,
  refreshStatus: () => void,
): Promise<void> {
  if (!id) {
    ctx.ui.notify("Background: usage /background delete <id>", "warning");
    return;
  }
  const task = store.get(id);
  if (!task) {
    ctx.ui.notify(`Background: no task with id "${id}"`, "warning");
    return;
  }

  if (!task.killed) {
    try {
      task.client.abort();
      await task.client.stop();
    } catch {
      // best-effort
    }
  }

  if (fs.existsSync(task.sessionFile)) {
    try {
      await fs.promises.unlink(task.sessionFile);
    } catch (e) {
      ctx.ui.notify(
        `Background: removed ${id} but session file unlink failed: ${(e as Error).message}`,
        "warning",
      );
    }
  }

  store.remove(id);
  refreshStatus();
  ctx.ui.notify(`Background: deleted ${id}`, "info");
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

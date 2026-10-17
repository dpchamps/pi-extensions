/** /background replays a live user request in a supervised RPC child. */
import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildCompletionItems,
  parseCompletionPrefix,
  STATUS_FILTERS,
  truncatePrompt,
  type StatusFilter,
} from "./completion.js";
import { PromptTracker } from "./prompt.js";
import {
  RpcChild,
  forkReplaySession,
  promptContent,
  type BackgroundClient,
  type RpcChildOptions,
} from "./runner.js";
import type { BackgroundTask, TaskTreeNode } from "./store.js";
import { BackgroundSupervisor, sharedSupervisor } from "./supervisor.js";

export interface BackgroundOptions {
  supervisor?: BackgroundSupervisor;
  createClient?: (options: RpcChildOptions) => BackgroundClient;
  /** SDK hosts can explicitly supply equivalent CLI resource/permission flags. */
  launchArgs?: string[];
}

export default function background(
  pi: ExtensionAPI,
  options: BackgroundOptions = {},
): void {
  // Ordinary RPC children must not recursively expose /background. An SDK
  // host (including isolated tests) can opt in with its own supervisor.
  if (process.env.PI_BACKGROUND_CHILD === "1" && !options.supervisor) return;
  const supervisor = options.supervisor ?? sharedSupervisor();
  const store = supervisor.store;
  const tracker = new PromptTracker();
  const createClient =
    options.createClient ?? ((settings) => new RpcChild(settings));
  let unsubscribe: (() => void) | undefined;

  const notify = (
    message: string,
    level: "info" | "warning" | "error" = "info",
  ) => supervisor.changed({ message: `Background: ${message}`, level });

  const wait = <T>(promise: Promise<T>, operation: string) =>
    deadline(promise, operation, supervisor.operationSignal);

  const refreshStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const counts = { active: 0, paused: 0, killed: 0 };
    for (const task of store.all()) counts[store.statusOf(task)]++;
    const parts = [
      counts.active && `${counts.active}A`,
      counts.paused && `${counts.paused}P`,
      counts.killed && `${counts.killed}K`,
    ].filter(Boolean);
    ctx.ui.setStatus(
      "background",
      parts.length
        ? ctx.ui.theme.fg("accent", `bg: ${parts.join(" ")}`)
        : undefined,
    );
  };

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup")
      supervisor.noteStartupProvider(ctx.model?.provider);
    tracker.reset();
    unsubscribe?.();
    // A built-in resume of an already stopped task also completes the handoff.
    const current = store
      .all()
      .find((task) =>
        sameFile(task.sessionFile, ctx.sessionManager.getSessionFile()),
      );
    if (current && !current.client.isAlive()) store.archive(current.id);
    unsubscribe = supervisor.subscribe((notice) => {
      refreshStatus(ctx);
      if (notice && ctx.hasUI) ctx.ui.notify(notice.message, notice.level);
    });
    refreshStatus(ctx);
  });
  pi.on("session_shutdown", async (event) => {
    unsubscribe?.();
    unsubscribe = undefined;
    tracker.reset();
    if (event.reason === "reload") supervisor.cancelOperation();
    if (event.reason === "quit") await supervisor.shutdown();
  });
  pi.on("session_before_switch", (event) => {
    if (
      supervisor.busy &&
      (!supervisor.switchTarget ||
        !sameFile(supervisor.switchTarget, event.targetSessionFile))
    ) {
      notify(
        "finish the current /background operation before switching sessions",
        "warning",
      );
      return { cancel: true };
    }
    const target = store
      .all()
      .find((task) => sameFile(task.sessionFile, event.targetSessionFile));
    if (target?.client.isAlive()) {
      notify(
        `use /background resume ${target.id} to stop its writer before opening that session`,
        "warning",
      );
      return { cancel: true };
    }
  });
  pi.on("session_before_fork", () => {
    if (supervisor.busy) {
      notify(
        "finish the current /background operation before forking",
        "warning",
      );
      return { cancel: true };
    }
  });
  pi.on("input", (event) => {
    tracker.input(event.source, event.streamingBehavior !== undefined);
  });
  pi.on("before_agent_start", (event) => {
    tracker.begin(event.messageType);
  });
  pi.on("message_end", (event) => {
    tracker.message(event.message);
  });
  pi.on("agent_settled", () => {
    tracker.reset();
  });
  pi.on("session_tree", () => {
    tracker.reset();
  });

  const requireTask = (id: string | undefined): BackgroundTask => {
    if (!id) throw new Error("specify a task ID");
    const task = store.get(id);
    if (!task) throw new Error(`no task with id "${id}"`);
    return task;
  };

  const stopTask = async (task: BackgroundTask) => {
    // Do not update metadata or transfer ownership if termination is uncertain.
    await task.client.stop();
    if (task.client.isAlive())
      throw new Error(`could not confirm ${task.id} stopped`);
    task.killed = true;
    task.isStreaming = false;
    supervisor.changed();
  };

  const resume = async (
    ctx: ExtensionCommandContext,
    id: string | undefined,
  ) => {
    const task = requireTask(id);
    if (sameFile(task.sessionFile, ctx.sessionManager.getSessionFile()))
      throw new Error("that task is already the foreground session");
    // Never stop the child and then wait indefinitely for unrelated foreground work.
    if (!ctx.isIdle()) {
      if (
        !ctx.hasUI ||
        !(await wait(
          ctx.ui.confirm(
            "Resume background task?",
            "Abort the current foreground run and open the background session?",
            { signal: supervisor.operationSignal, timeout: 30_000 },
          ),
          "resume confirmation",
        ))
      )
        return;
      ctx.abort();
      await wait(ctx.waitForIdle(), "foreground cancellation");
    }
    try {
      await fs.access(task.sessionFile);
    } catch {
      throw new Error(
        `${task.id}'s session file is missing; its registry entry was retained`,
      );
    }
    await stopTask(task);
    supervisor.operationSignal?.throwIfAborted();
    supervisor.switchTarget = task.sessionFile;
    try {
      const result = await ctx.switchSession(task.sessionFile, {
        withSession: async (replacement) => {
          store.archive(task.id);
          supervisor.changed();
          // Only the fresh replacement context is used after a successful switch.
          replacement.ui.notify(`Background: resumed ${task.id}`, "info");
        },
      });
      if (result.cancelled)
        notify(
          `switch to ${task.id} cancelled; its child is stopped and its session is preserved. Retry /background resume ${task.id}.`,
          "warning",
        );
    } catch (error) {
      throw new Error(
        `switch to ${task.id} failed: ${String(error)}. Its child is stopped and its session is preserved.`,
      );
    } finally {
      supervisor.switchTarget = undefined;
    }
  };

  const detach = async (ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI)
      throw new Error("detach requires a UI for replay confirmation");
    const eligible = () => {
      if (ctx.isIdle() || ctx.hasPendingMessages()) return undefined;
      return tracker.current(ctx.sessionManager);
    };
    const request = eligible();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || !request)
      throw new Error(
        "no unambiguous live user request to replay. Idle, queued, extension-started (including /task), and restored runs cannot be detached.",
      );
    if (store.wasDetached(sessionFile, request.id))
      throw new Error("that request was already detached");
    const { text, images } = promptContent(request);
    if (!text.trim() && !images.length)
      throw new Error("request has no replayable content");
    const launchArgs = [
      ...(options.launchArgs ?? supervisor.launchArgs(ctx.model?.provider)),
    ];
    launchArgs.push(ctx.isProjectTrusted() ? "--approve" : "--no-approve");
    if (ctx.model)
      launchArgs.push(
        "--provider",
        ctx.model.provider,
        "--model",
        ctx.model.id,
      );
    if (ctx.thinkingLevel) launchArgs.push("--thinking", ctx.thinkingLevel);
    const snapshot = {
      systemPrompt: ctx.getSystemPrompt(),
      tools: [...pi.getActiveTools()],
    };
    const preview = truncatePrompt(text || "[image-only request]", 100);
    if (
      !(await wait(
        ctx.ui.confirm(
          "Replay request in background?",
          `${preview}\n\nThis aborts and replays the request, not the running tools or extension state. Completed side effects can repeat. The child shares this workspace; concurrent edits can conflict. Continue?`,
          { signal: supervisor.operationSignal, timeout: 30_000 },
        ),
        "replay confirmation",
      ))
    )
      return;
    if (eligible()?.id !== request.id)
      throw new Error(
        "the run changed or completed while confirming; nothing was detached",
      );
    if (store.all().filter((task) => task.client.isAlive()).length >= 5)
      notify(
        "5 or more children are running; concurrent processes and workspace edits add up",
        "warning",
      );
    ctx.abort();
    await wait(ctx.waitForIdle(), "foreground cancellation");
    const latestUser = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
    if (
      latestUser?.id !== request.id ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages()
    )
      throw new Error(
        "foreground input changed during cancellation; no child was started",
      );

    const forkedPath = await forkReplaySession(
      ctx.sessionManager,
      request,
      ctx.cwd,
    );
    supervisor.operationSignal?.throwIfAborted();
    const id = store.allocId();
    const observer = supervisor.observe(id);
    const client = createClient({
      cwd: ctx.cwd,
      sessionFile: forkedPath,
      args: launchArgs,
      snapshot,
      expectedModel: ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined,
      ...observer.handlers,
    });
    const task: BackgroundTask = {
      id,
      client,
      sessionFile: forkedPath,
      parentSessionFile: sessionFile,
      sourceEntryId: request.id,
      cwd: ctx.cwd,
      firstPrompt: text || "[image-only request]",
      startedAt: new Date(),
      killed: false,
      isStreaming: true,
    };
    // Track before spawning, including failures whose cleanup might need retrying.
    supervisor.register(task);
    try {
      await wait(client.start(), "child readiness");
      const disposition = await wait(
        client.prompt(text, images),
        "child prompt acceptance",
      );
      if (disposition === "handled" && !observer.started)
        task.isStreaming = false;
      if (!client.isAlive()) throw new Error("child exited during handoff");
    } catch (error) {
      task.error = String(error).slice(0, 16_384);
      try {
        await stopTask(task);
      } catch (stopError) {
        task.error += `; cleanup: ${String(stopError).slice(0, 2000)}`;
      }
      notify(
        `${id} failed: ${task.error}. The original request was stopped; both session files are preserved.`,
        "error",
      );
      supervisor.changed();
      return;
    }
    pi.sendMessage(
      {
        customType: "background-detach",
        content: `[Replayed previous request as ${id} in the same workspace. Completed side effects may repeat. /background resume ${id} to open its session.]`,
        display: true,
      },
      { triggerTurn: false },
    );
    supervisor.changed();
    notify(
      `replaying as ${id}. /background list to see tasks; /background resume ${id} to open it.`,
    );
  };

  const list = async (ctx: ExtensionCommandContext, filter?: StatusFilter) => {
    const tree = store.tree(
      filter ? (task) => store.statusOf(task) === filter : undefined,
    );
    if (!tree.length) {
      notify(filter ? `no ${filter} tasks` : "no tasks tracked");
      return;
    }
    if (!ctx.hasUI) throw new Error("list requires an interactive or RPC UI");
    const lines: string[] = [];
    const ids = new Map<string, string>();
    const render = (
      node: TaskTreeNode,
      prefix: string,
      last: boolean,
      root: boolean,
    ) => {
      const task = node.task;
      const status = node.archived ? "resumed ancestor" : store.statusOf(task);
      const elapsed = formatElapsed(Date.now() - task.startedAt.getTime());
      const line = `${prefix}${root ? "" : last ? "└─ " : "├─ "}${task.id} [${status}] ${truncatePrompt(task.firstPrompt, 50)} (${elapsed})${task.error ? ` — ${truncatePrompt(task.error, 80)}` : ""}`;
      lines.push(line);
      if (!node.archived) ids.set(line, task.id);
      node.children.forEach((child, index) =>
        render(
          child,
          prefix + (root ? "" : last ? "   " : "│  "),
          index === node.children.length - 1,
          false,
        ),
      );
    };
    tree.forEach((node, index) =>
      render(node, "", index === tree.length - 1, true),
    );
    const selected = await wait(
      ctx.ui.select(
        "Resume background task (ancestor rows are context only)",
        lines,
        { signal: supervisor.operationSignal, timeout: 30_000 },
      ),
      "task selection",
    );
    if (selected && ids.has(selected)) await resume(ctx, ids.get(selected));
  };

  pi.registerCommand("background", {
    description:
      "Replay a live user request in a supervised background child. Subcommands: list|resume|kill|delete",
    getArgumentCompletions: (prefix) => {
      const parsed = parseCompletionPrefix(prefix);
      const tasks = store
        .all()
        .filter(
          (task) =>
            parsed.stage !== "arg" ||
            parsed.sub !== "kill" ||
            task.client.isAlive(),
        );
      return buildCompletionItems(
        parsed,
        tasks.map((task) => ({
          id: task.id,
          status: store.statusOf(task),
          promptPreview: truncatePrompt(task.firstPrompt, 50),
        })),
      );
    },
    handler: async (args, ctx) => {
      // Let Pi's command error channel report this in print/JSON modes; a
      // notify-only error would silently disappear without a UI subscriber.
      if (!ctx.hasUI)
        throw new Error("/background requires an interactive or RPC UI");
      try {
        await supervisor.exclusive(async () => {
          const tokens = args.trim().split(/\s+/).filter(Boolean);
          if (!tokens.length) {
            await detach(ctx);
            return;
          }
          if (tokens.length > 2)
            throw new Error(
              "usage /background [list [active|paused|killed]|resume <id>|kill <id>|delete <id>]",
            );
          const [sub, id] = tokens;
          if (sub === "list") {
            if (id && !(STATUS_FILTERS as readonly string[]).includes(id))
              throw new Error(`unknown status "${id}"`);
            await list(ctx, id as StatusFilter | undefined);
          } else if (sub === "resume") await resume(ctx, id);
          else if (sub === "kill" || sub === "delete") {
            const task = requireTask(id);
            if (sameFile(task.sessionFile, ctx.sessionManager.getSessionFile()))
              throw new Error("cannot kill or delete the foreground session");
            await stopTask(task);
            if (sub === "delete") {
              // Unlink failures keep the registry entry, permitting a retry.
              await fs.rm(task.sessionFile, { force: true });
              store.remove(task.id);
            }
            notify(`${sub === "kill" ? "stopped" : "deleted"} ${task.id}`);
          } else
            throw new Error(
              `unknown subcommand "${sub}". Use /background [list|resume|kill|delete]`,
            );
          supervisor.changed();
        });
      } catch (error) {
        // No old ctx/pi access here: replacement may have succeeded before a
        // different extension's withSession/rebind callback failed.
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

function sameFile(left: string, right?: string): boolean {
  if (right === undefined) return false;
  if (resolve(left) === resolve(right)) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

async function deadline<T>(
  promise: Promise<T>,
  operation: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(new Error("operation cancelled by session shutdown/reload"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out waiting for ${operation}; no session ownership was transferred`,
              ),
            ),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * /task runs one of three event-driven autonomous loops:
 * - oracle: an external command decides whether work is complete
 * - focus: repeatedly asks the agent to keep exploring
 * - goal: an independent same-model checker verifies a private checklist
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  parseTaskArgs,
  type ParsedTaskArgs,
  type TaskKind,
} from "./arguments.js";
import {
  createGoalChecker,
  type GoalChecker,
  type GoalCheckerConfig,
} from "./goal-checker.js";
import { inheritedArgs } from "../background-command/launch.js";

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const FOCUS_COMPACT_PERCENT = 60;
const MAX_FEEDBACK_LENGTH = 8000;

const USAGE = [
  "Task usage:",
  '  /task --verify "<command>" <prompt>                    # oracle (default)',
  "  /task --focus [--limit <runs>] <prompt>",
  "  /task --goal <prompt>",
].join("\n");

interface BaseTask {
  kind: TaskKind;
  prompt: string;
  runs: number;
  controller: AbortController;
}

interface OracleTask extends BaseTask {
  kind: "oracle";
  verify: string;
}

interface FocusTask extends BaseTask {
  kind: "focus";
  limit?: number;
}

interface GoalTask extends BaseTask {
  kind: "goal";
  phase: "planning" | "working" | "checking";
  checker?: GoalChecker;
}

type ActiveTask = OracleTask | FocusTask | GoalTask;

export interface TaskOptions {
  goalCheckerFactory?: (
    config: GoalCheckerConfig,
  ) => GoalChecker | Promise<GoalChecker>;
  /** SDK hosts can explicitly provide the child process resource flags. */
  launchArgs?: string[];
}

function keepTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `… [truncated ${text.length - max} chars from start]\n${text.slice(-max)}`;
}

function focusContinuation(prompt: string): string {
  return [
    prompt,
    "",
    "The current run is not exhausted. Be creative and try different approaches. Use any context-management tools available to you. Continue working instead of returning a final answer.",
  ].join("\n");
}

function goalContinuation(prompt: string, feedback: string): string {
  return [
    prompt,
    "",
    "The independent goal evaluator determined that the goal is not complete.",
    "",
    keepTail(feedback, MAX_FEEDBACK_LENGTH),
    "",
    "Continue working on the goal. Address the evidence-based gaps, then verify your work before returning.",
  ].join("\n");
}

function makeTask(parsed: ParsedTaskArgs): ActiveTask {
  const base = {
    prompt: parsed.prompt,
    runs: 0,
    controller: new AbortController(),
  };
  if (parsed.kind === "oracle")
    return { ...base, kind: "oracle", verify: parsed.verify! };
  if (parsed.kind === "focus")
    return { ...base, kind: "focus", limit: parsed.limit };
  return { ...base, kind: "goal", phase: "planning" };
}

function runLabel(task: ActiveTask, run: number): string {
  if (task.kind === "focus" && task.limit) return `${run}/${task.limit}`;
  return String(run);
}

export default function taskExtension(
  pi: ExtensionAPI,
  options: TaskOptions = {},
): void {
  // Goal evaluators may inherit the package's extension paths. They should not
  // expose /task recursively inside the checker process.
  if (process.env.PI_TASK_GOAL_CHILD === "1") return;

  const launchCwd = process.cwd();
  const launchArgv = process.argv.slice(2);
  const goalCheckerFactory = options.goalCheckerFactory ?? createGoalChecker;
  let startupProvider: string | undefined;
  let task: ActiveTask | null = null;

  const notify = (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ) => {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  };

  const setStatus = (ctx: ExtensionContext, text?: string) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "task",
      text === undefined ? undefined : ctx.ui.theme.fg("accent", text),
    );
  };

  const dispose = (active: ActiveTask) => {
    active.controller.abort();
    if (active.kind === "goal" && active.checker)
      void active.checker.dispose().catch(() => {});
  };

  const stop = (
    ctx: ExtensionContext,
    active: ActiveTask,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ) => {
    if (task !== active) return;
    task = null;
    dispose(active);
    notify(ctx, message, type);
    setStatus(ctx);
  };

  const setWorkingStatus = (
    ctx: ExtensionContext,
    active: ActiveTask,
    run: number,
  ) => setStatus(ctx, `↻ task ${active.kind} ${runLabel(active, run)}`);

  const compactFocus = async (
    ctx: ExtensionContext,
    active: FocusTask,
  ): Promise<boolean> => {
    const usage = ctx.getContextUsage();
    if (usage?.percent === null || usage?.percent === undefined) return true;
    if (usage.percent < FOCUS_COMPACT_PERCENT) return true;

    setStatus(ctx, `↻ task focus compacting (${Math.round(usage.percent)}%)`);
    try {
      await new Promise<void>((resolve, reject) => {
        ctx.compact({
          customInstructions:
            "Preserve the active focus task exactly, plus all attempted approaches, concrete findings, constraints, modified files, failures, and promising next experiments so creative work can continue after compaction.",
          onComplete: () => resolve(),
          onError: reject,
        });
      });
      return task === active;
    } catch (error) {
      if (task === active)
        stop(
          ctx,
          active,
          `Task focus: compaction failed — ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      return false;
    }
  };

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup") startupProvider ??= ctx.model?.provider;
  });

  // Any interactive input stops the active loop. Extension-generated messages
  // have source "extension" and therefore do not stop themselves.
  pi.on("input", async (event, ctx) => {
    if (task && event.source === "interactive") {
      const active = task;
      stop(ctx, active, `Task ${active.kind}: stopped`);
    }
    return { action: "continue" };
  });

  pi.on("agent_settled", async (event, ctx) => {
    const active = task;
    if (!active) return;
    if (event.aborted) {
      stop(
        ctx,
        active,
        `Task ${active.kind}: agent run was aborted`,
        "warning",
      );
      return;
    }

    active.runs += 1;

    if (active.kind === "oracle") {
      setStatus(
        ctx,
        `↻ task oracle verifying (${runLabel(active, active.runs)})`,
      );
      const result = await pi.exec("bash", ["-c", active.verify], {
        cwd: ctx.cwd,
        timeout: VERIFY_TIMEOUT_MS,
        signal: active.controller.signal,
      });
      if (task !== active) return;
      if (result.killed) {
        stop(
          ctx,
          active,
          `Task oracle: verification timed out after ${VERIFY_TIMEOUT_MS / 1000}s`,
          "error",
        );
        return;
      }
      if (result.code === 0) {
        stop(
          ctx,
          active,
          `Task oracle: verification passed after ${active.runs} run(s)`,
        );
        return;
      }

      setWorkingStatus(ctx, active, active.runs + 1);
      // The oracle's output is deliberately not fed to the implementing agent.
      // Repeating the original task keeps the loop focused on the user's goal.
      pi.sendUserMessage(active.prompt);
      return;
    }

    if (active.kind === "focus") {
      if (active.limit !== undefined && active.runs >= active.limit) {
        stop(
          ctx,
          active,
          `Task focus: reached the limit of ${active.limit} run(s)`,
        );
        return;
      }
      if (!(await compactFocus(ctx, active)) || task !== active) return;
      setWorkingStatus(ctx, active, active.runs + 1);
      pi.sendUserMessage(focusContinuation(active.prompt));
      return;
    }

    if (!active.checker) {
      stop(ctx, active, "Task goal: checker is unavailable", "error");
      return;
    }
    active.phase = "checking";
    setStatus(ctx, `↻ task goal checking (${active.runs})`);
    try {
      const decision = await active.checker.evaluate(active.controller.signal);
      if (task !== active) return;
      if (decision.complete) {
        stop(
          ctx,
          active,
          `Task goal: independently verified after ${active.runs} run(s)`,
        );
        return;
      }
      active.phase = "working";
      setWorkingStatus(ctx, active, active.runs + 1);
      pi.sendUserMessage(goalContinuation(active.prompt, decision.feedback));
    } catch (error) {
      if (task === active)
        stop(
          ctx,
          active,
          `Task goal: checker failed — ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
    }
  });

  pi.on("session_shutdown", () => {
    const active = task;
    task = null;
    if (active) dispose(active);
  });

  pi.registerCommand("task", {
    description:
      "Run an oracle, focus, or independently checked goal task. Use /task --help for syntax.",
    handler: async (args, ctx) => {
      if (args.trim() === "--help" || !args.trim()) {
        notify(ctx, USAGE, args.trim() ? "info" : "warning");
        return;
      }
      if (task) {
        notify(
          ctx,
          "Task: a task is already running. Send a message to stop it first.",
          "warning",
        );
        return;
      }

      const parsed = parseTaskArgs(args);
      if (!parsed.ok) {
        notify(ctx, `Task: ${parsed.error}\n\n${USAGE}`, "warning");
        return;
      }

      const active = makeTask(parsed.value);
      task = active;

      if (active.kind === "oracle") {
        notify(
          ctx,
          `Task oracle: starting (verify: ${active.verify}). Send any message to stop.`,
        );
        setWorkingStatus(ctx, active, 1);
        pi.sendUserMessage(active.prompt);
        return;
      }

      if (active.kind === "focus") {
        notify(
          ctx,
          `Task focus: starting${active.limit ? ` (limit ${active.limit} runs)` : ""}. Send any message to stop.`,
        );
        setWorkingStatus(ctx, active, 1);
        pi.sendUserMessage(active.prompt);
        return;
      }

      if (!ctx.model) {
        stop(ctx, active, "Task goal: no active model is available", "error");
        return;
      }

      notify(
        ctx,
        "Task goal: creating an independent verification checklist before implementation starts. Send any message to stop.",
      );
      setStatus(ctx, "↻ task goal planning");
      try {
        const launchArgs =
          options.launchArgs ??
          inheritedArgs(
            launchArgv,
            launchCwd,
            ctx.model.provider,
            startupProvider,
          );
        const checker = await goalCheckerFactory({
          cwd: ctx.cwd,
          prompt: active.prompt,
          model: { provider: ctx.model.provider, id: ctx.model.id },
          thinkingLevel: ctx.thinkingLevel,
          projectTrusted: ctx.isProjectTrusted(),
          launchArgs,
        });
        if (task !== active) {
          await checker.dispose();
          return;
        }
        active.checker = checker;
        await checker.initialize(active.controller.signal);
        if (task !== active) return;
        active.phase = "working";
        setWorkingStatus(ctx, active, 1);
        pi.sendUserMessage(active.prompt);
      } catch (error) {
        if (task === active)
          stop(
            ctx,
            active,
            `Task goal: could not initialize checker — ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
      }
    },
  });
}

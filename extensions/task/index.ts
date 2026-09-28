/**
 * task extension — /task command that runs an autonomous loop:
 * do the work, verify, repeat until the verification passes (or the cap).
 *
 * Usage:
 *   /task <prompt> || <verify-script> [|| <cap>]
 *
 * The loop is event-driven. When the agent settles (nothing pending — no
 * retry, compaction, or continuation), the verify script runs:
 *   - exit 0  → task complete
 *   - failure → the agent is nudged to keep going (with the failing output),
 *               up to the cap
 *
 * Abort: while the task is active, any interactive input stops the loop.
 * The user's message is still delivered to the agent.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_CAP = 10;
const MAX_VERIFY_OUTPUT = 8000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

interface TaskState {
  prompt: string;
  verify: string;
  cap: number;
  /** Completed agent runs (== verification attempts) */
  runs: number;
}

const USAGE = "Task: usage /task <prompt> || <verify-script> [|| <cap>]";

function parseTaskArgs(args: string): TaskState | null {
  const parts = args
    .trim()
    .split(/\s*\|\|\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 3) {
    const cap = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(cap) || cap < 1) return null;
    return { prompt: parts[0], verify: parts[1], cap, runs: 0 };
  }
  if (parts.length === 2) {
    return { prompt: parts[0], verify: parts[1], cap: DEFAULT_CAP, runs: 0 };
  }
  return null;
}

/** Keep the tail of long output (test summaries live at the end). */
function keepTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `… [truncated ${s.length - max} chars from start]\n${s.slice(-max)}`;
}

export default function (pi: ExtensionAPI) {
  let task: TaskState | null = null;

  const stop = (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ) => {
    task = null;
    ctx.ui.notify(message, type);
    ctx.ui.setStatus("task", undefined);
  };

  const setStatusLine = (ctx: ExtensionContext, runNo: number, cap: number) =>
    ctx.ui.setStatus("task", ctx.ui.theme.fg("accent", `↻ task ${runNo}/${cap}`));

  // Any interactive input while a task is active stops the loop. task's own
  // sendUserMessage calls use source "extension", so they never trip this.
  pi.on("input", async (event, ctx) => {
    if (task && event.source === "interactive") {
      stop(ctx, "Task: stopped", "info");
    }
    return { action: "continue" };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const t = task;
    if (!t) return;

    t.runs += 1;
    ctx.ui.setStatus(
      "task",
      ctx.ui.theme.fg("accent", `↻ task verifying (${t.runs}/${t.cap})`),
    );

    const result = await pi.exec("bash", ["-c", t.verify], {
      cwd: ctx.cwd,
      timeout: VERIFY_TIMEOUT_MS,
    });

    // The task may have been stopped (interactive input) while verifying.
    if (task !== t) return;

    if (result.killed) {
      stop(ctx, `Task: verification timed out after ${VERIFY_TIMEOUT_MS / 1000}s — stopping`, "error");
      return;
    }

    if (result.code === 0) {
      stop(ctx, `Task: verification passed after ${t.runs} run(s)`);
      return;
    }

    if (t.runs >= t.cap) {
      stop(ctx, `Task: hit cap of ${t.cap} runs without verification passing`, "warning");
      return;
    }

    setStatusLine(ctx, t.runs + 1, t.cap);
    const output = result.stdout + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : "");
    const nudge = [
      `The verification command \`${t.verify}\` is still failing (exit ${result.code}). Latest output:`,
      "",
      "```",
      keepTail(output, MAX_VERIFY_OUTPUT) || "(no output)",
      "```",
      "",
      "Keep working on the task until the verification passes.",
    ].join("\n");
    pi.sendUserMessage(nudge);
  });

  pi.on("session_shutdown", () => {
    task = null;
  });

  pi.registerCommand("task", {
    description:
      "Run a task until a verification command succeeds. Usage: /task <prompt> || <verify> [|| <cap>]",
    handler: async (args, ctx) => {
      if (task) {
        ctx.ui.notify(
          "Task: a task is already running. Send a message to stop it first.",
          "warning",
        );
        return;
      }

      const parsed = parseTaskArgs(args);
      if (!parsed) {
        ctx.ui.notify(
          args.trim()
            ? USAGE
            : `${USAGE}  (e.g. /task fix the failing tests || npm test)`,
          args.trim() ? "warning" : "info",
        );
        return;
      }

      task = parsed;
      ctx.ui.notify(
        `Task: starting (max ${parsed.cap} runs, verify: ${parsed.verify}). Send any message to stop.`,
        "info",
      );
      setStatusLine(ctx, 1, parsed.cap);
      pi.sendUserMessage(parsed.prompt);
    },
  });
}

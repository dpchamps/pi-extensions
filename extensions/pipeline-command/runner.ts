/**
 * Pipeline executor — walks the unit graph, runs each visited unit (pre /
 * prompt / post / worktree), and chooses the next edge by condition.
 *
 * The runner is a pure async function. Its only side effects on session state
 * are: pi.sendUserMessage, pi.exec, ctx.newSession, and the worktree
 * create/merge calls (delegated to @dpchamps/pi-worktree-command/operations).
 *
 * The per-unit model and systemPrompt overrides are applied via a callback —
 * the runner doesn't register pi event hooks itself. index.ts registers the
 * before_agent_start / agent_end hooks once at extension load and consumes
 * the same shared state the runner writes via `hooks.setOverride`.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
  createWorktreeForkSession,
  mergeWorktreeAndCleanup,
} from "@dpchamps/pi-worktree-command/operations";
import { evalCondition } from "./conditions.js";
import {
  resolvePromptObj,
  resolveStartId,
  type LoadedPipeline,
} from "./loader.js";
import type { RunRecord, TModelRef } from "./schema.js";

export interface AbortFlag {
  aborted: boolean;
}

export interface PipelineOverrideState {
  modelRef?: TModelRef;
  systemPrompt?: string;
}

export interface ExecuteHooks {
  abortFlag: AbortFlag;
  setOverride: (state: PipelineOverrideState | null) => void;
  reportStatus: (text: string | undefined) => void;
}

export interface ExecutionResult {
  aborted: boolean;
  lastRecord?: RunRecord;
  /** Non-success terminations: cap exceeded, unit lookup miss, worktree-create failure. */
  reason?: string;
}

export async function executePipeline(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  loaded: LoadedPipeline,
  hooks: ExecuteHooks,
): Promise<ExecutionResult> {
  const { pipeline, dir: pipelineDir } = loaded;
  const maxSteps = pipeline.meta?.maxSteps ?? 50;
  const byId = new Map(pipeline.units.map((u) => [u.id, u]));
  const visits: Record<string, number> = Object.create(null);
  let currentId: string = resolveStartId(pipeline);
  let lastRecord: RunRecord | undefined;
  let steps = 0;

  while (currentId !== "$end") {
    if (++steps > maxSteps) {
      return {
        aborted: false,
        lastRecord,
        reason: `pipeline exceeded maxSteps=${maxSteps} (cycle?)`,
      };
    }
    if (hooks.abortFlag.aborted) return { aborted: true, lastRecord };

    const unit = byId.get(currentId);
    if (!unit) {
      return {
        aborted: false,
        lastRecord,
        reason: `unknown unit "${currentId}"`,
      };
    }
    visits[unit.id] = (visits[unit.id] ?? 0) + 1;
    const iterations = visits[unit.id];

    hooks.reportStatus(`▷ ${unit.id} (step ${steps}/${maxSteps})`);

    if (unit.fresh) {
      await ctx.newSession();
    }

    let wtHandle: { worktreePath: string; branch: string } | null = null;
    if (unit.worktree) {
      const r = await createWorktreeForkSession(pi, ctx);
      if (!r.ok) {
        return {
          aborted: false,
          lastRecord,
          reason: `unit "${unit.id}" worktree create failed: ${r.error}`,
        };
      }
      wtHandle = {
        worktreePath: r.handle.worktreePath,
        branch: r.handle.branch,
      };
      if (r.warnings) {
        for (const w of r.warnings) ctx.ui.notify(`Pipeline: ${w}`, "warning");
      }
      ctx.ui.notify(
        `Pipeline: unit "${unit.id}" running in worktree ${r.handle.branch}`,
        "info",
      );
    }

    let preExitCode: number | undefined;
    if (unit.preScript && !hooks.abortFlag.aborted) {
      const r = await pi.exec("bash", ["-c", unit.preScript], {
        cwd: ctx.cwd,
        signal: ctx.signal,
      });
      preExitCode = r.code;
    }

    if (unit.prompt && !hooks.abortFlag.aborted) {
      const promptText = await resolvePromptObj(unit.prompt, pipelineDir);
      const systemPromptText = await resolvePromptObj(
        unit.systemPrompt,
        pipelineDir,
      );
      hooks.setOverride({
        modelRef: unit.model,
        systemPrompt: systemPromptText,
      });
      try {
        if (promptText) pi.sendUserMessage(promptText);
        await ctx.waitForIdle();
      } finally {
        hooks.setOverride(null);
      }
    }

    let postExitCode: number | undefined;
    if (unit.postScript && !hooks.abortFlag.aborted) {
      const r = await pi.exec("bash", ["-c", unit.postScript], {
        cwd: ctx.cwd,
        signal: ctx.signal,
      });
      postExitCode = r.code;
    }

    let worktreeMergeFailed = false;
    if (wtHandle) {
      // Commit any agent-produced changes before merge — mergeWorktreeAndCleanup
      // requires a clean tree, and the user shouldn't have to remember to
      // hand-roll this in postScript.
      await commitWorktreeChanges(pi, ctx.cwd, unit.id, ctx.signal);
      const r = await mergeWorktreeAndCleanup(pi, ctx, wtHandle);
      worktreeMergeFailed = !r.ok;
      if (!r.ok) {
        ctx.ui.notify(`Pipeline: ${r.error}`, "warning");
      } else if (r.warnings) {
        for (const w of r.warnings) ctx.ui.notify(`Pipeline: ${w}`, "warning");
      }
    }

    lastRecord = {
      unitId: unit.id,
      iterations,
      preExitCode,
      postExitCode,
      worktreeMergeFailed,
    };

    if (hooks.abortFlag.aborted) return { aborted: true, lastRecord };

    if (unit.kind === "terminal") {
      return { aborted: false, lastRecord };
    }

    const next = (pipeline.flow ?? [])
      .filter((e) => e.from === unit.id)
      .find((e) => evalCondition(e.when ?? { always: true }, lastRecord));
    currentId = next?.to ?? "$end";
  }

  return { aborted: false, lastRecord };
}

/**
 * Stage and commit any pending changes in the worktree so the subsequent
 * merge sees a clean tree. No-op when there is nothing to commit. Errors are
 * swallowed here — if a commit truly cannot happen (e.g. no git identity),
 * mergeWorktreeAndCleanup will surface the cleanliness check failure with a
 * usable error message.
 */
async function commitWorktreeChanges(
  pi: ExtensionAPI,
  cwd: string,
  unitId: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await pi.exec("git", ["add", "-A"], { cwd, signal });
  const status = await pi.exec("git", ["status", "--porcelain"], {
    cwd,
    signal,
  });
  if (status.code !== 0 || status.stdout.trim().length === 0) return;
  await pi.exec("git", ["commit", "-m", `pipeline: unit ${unitId}`], {
    cwd,
    signal,
  });
}

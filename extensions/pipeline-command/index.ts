/**
 * pipeline-command extension — /pipeline executes JSON-defined pipelines of
 * agent steps with optional model / system-prompt / pre-post-script /
 * worktree overrides per unit.
 *
 *   /pipeline execute  <path>   run a pipeline
 *   /pipeline validate <path>   schema-check a pipeline without running it
 *
 * Per-unit model & system-prompt overrides are applied via before_agent_start
 * (mirroring the autorouter pattern) — the runner sets a module-scope override
 * object before each unit's turn and clears it after waitForIdle.
 *
 * Abort: any interactive user input while a pipeline is running flips an
 * abort flag; the runner exits at the next safe checkpoint.
 */

import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import {
  buildCompletionItems,
  parseCompletionPrefix,
  type AutocompleteItem,
} from "./completion.js";
import { loadPipeline, PipelineLoadError } from "./loader.js";
import { executePipeline, type PipelineOverrideState } from "./runner.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ActivePipeline {
  aborted: boolean;
}

export default function (pi: ExtensionAPI) {
  let activePipeline: ActivePipeline | null = null;
  let pipelineOverride: PipelineOverrideState | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let savedModel: Model<any> | undefined;
  let savedThinking: ThinkingLevel | undefined;

  // Interactive user input during a pipeline = abort signal. Pipeline-driven
  // sendUserMessage uses source="extension", so it never aborts itself.
  pi.on("input", async (event) => {
    if (activePipeline && event.source === "interactive") {
      activePipeline.aborted = true;
    }
    return { action: "continue" };
  });

  // Per-unit model / systemPrompt override, applied at the start of each
  // turn that the pipeline runner triggers via sendUserMessage.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!pipelineOverride) return;
    savedModel = ctx.model;
    savedThinking = pi.getThinkingLevel();

    if (pipelineOverride.modelRef) {
      const m = ctx.modelRegistry.find(
        pipelineOverride.modelRef.provider,
        pipelineOverride.modelRef.model,
      );
      if (m) {
        await pi.setModel(m);
        if (pipelineOverride.modelRef.thinking) {
          pi.setThinkingLevel(pipelineOverride.modelRef.thinking);
        }
      } else {
        ctx.ui.notify(
          `Pipeline: model not found ${pipelineOverride.modelRef.provider}/${pipelineOverride.modelRef.model} — using current`,
          "warning",
        );
      }
    }

    return pipelineOverride.systemPrompt
      ? { systemPrompt: pipelineOverride.systemPrompt }
      : undefined;
  });

  pi.on("agent_end", async () => {
    if (!pipelineOverride) return;
    if (savedModel) {
      await pi.setModel(savedModel);
      savedModel = undefined;
    }
    if (savedThinking !== undefined) {
      pi.setThinkingLevel(savedThinking);
      savedThinking = undefined;
    }
  });

  pi.registerCommand("pipeline", {
    description:
      "Execute or validate a JSON pipeline. Usage: /pipeline execute|validate <path>",
    getArgumentCompletions: async (prefix) =>
      getPipelineCompletions(pi, prefix),
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "";
      const restArg = args
        .trim()
        .replace(/^\S+\s*/, "")
        .trim();

      if (sub === "execute") {
        if (activePipeline) {
          ctx.ui.notify(
            "Pipeline: a pipeline is already running. Send a message to abort it first.",
            "warning",
          );
          return;
        }
        await runPipelineExecute(pi, ctx, restArg, {
          startActive: () => {
            const ap: ActivePipeline = { aborted: false };
            activePipeline = ap;
            return ap;
          },
          stopActive: () => {
            activePipeline = null;
          },
          setOverride: (state) => {
            pipelineOverride = state;
          },
        });
        return;
      }
      if (sub === "validate") {
        await runPipelineValidate(ctx, restArg);
        return;
      }
      if (sub === "") {
        ctx.ui.notify(
          "Pipeline: usage /pipeline execute|validate <path>",
          "warning",
        );
        return;
      }
      ctx.ui.notify(
        `Pipeline: unknown subcommand "${sub}". Try execute|validate.`,
        "warning",
      );
    },
  });
}

interface ExecuteCallbacks {
  startActive: () => ActivePipeline;
  stopActive: () => void;
  setOverride: (state: PipelineOverrideState | null) => void;
}

async function runPipelineExecute(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  pathArg: string,
  cbs: ExecuteCallbacks,
): Promise<void> {
  if (!pathArg) {
    ctx.ui.notify(
      "Pipeline: usage /pipeline execute <path-to-pipeline.json>",
      "warning",
    );
    return;
  }

  let loaded;
  try {
    loaded = await loadPipeline(pathArg);
  } catch (e) {
    if (e instanceof PipelineLoadError) {
      ctx.ui.notify(`Pipeline: ${e.message}`, "error");
      for (const issue of e.issues) {
        ctx.ui.notify(`Pipeline: ${issue}`, "error");
      }
    } else {
      ctx.ui.notify(`Pipeline: ${(e as Error).message}`, "error");
    }
    return;
  }

  const ap = cbs.startActive();
  const setStatus = (text: string | undefined) =>
    ctx.ui.setStatus(
      "pipeline",
      text === undefined ? undefined : ctx.ui.theme.fg("accent", text),
    );

  ctx.ui.notify(
    `Pipeline: starting "${loaded.pipeline.name ?? path.basename(loaded.filePath)}" (${loaded.pipeline.units.length} units). Type any message to abort.`,
    "info",
  );

  try {
    const result = await executePipeline(pi, ctx, loaded, {
      abortFlag: ap,
      setOverride: cbs.setOverride,
      reportStatus: setStatus,
    });
    if (result.aborted) {
      ctx.ui.notify("Pipeline: aborted", "info");
    } else if (result.reason) {
      ctx.ui.notify(`Pipeline: stopped — ${result.reason}`, "warning");
    } else {
      ctx.ui.notify(
        `Pipeline: done${result.lastRecord ? ` (last unit: ${result.lastRecord.unitId})` : ""}`,
        "info",
      );
    }
  } catch (e) {
    ctx.ui.notify(`Pipeline: failed — ${(e as Error).message}`, "error");
  } finally {
    cbs.stopActive();
    cbs.setOverride(null);
    setStatus(undefined);
  }
}

async function runPipelineValidate(
  ctx: ExtensionCommandContext,
  pathArg: string,
): Promise<void> {
  if (!pathArg) {
    ctx.ui.notify(
      "Pipeline: usage /pipeline validate <path-to-pipeline.json>",
      "warning",
    );
    return;
  }

  try {
    const loaded = await loadPipeline(pathArg);
    ctx.ui.notify(
      `Pipeline: ${loaded.filePath} OK (${loaded.pipeline.units.length} units, ${(loaded.pipeline.flow ?? []).length} edges)`,
      "info",
    );
  } catch (e) {
    if (e instanceof PipelineLoadError) {
      ctx.ui.notify(`Pipeline: ${e.message}`, "error");
      for (const issue of e.issues) {
        ctx.ui.notify(`Pipeline: ${issue}`, "error");
      }
    } else {
      ctx.ui.notify(`Pipeline: ${(e as Error).message}`, "error");
    }
  }
}

async function getPipelineCompletions(
  pi: ExtensionAPI,
  prefix: string,
): Promise<AutocompleteItem[]> {
  const parsed = parseCompletionPrefix(prefix);

  if (parsed.stage === "sub") {
    return buildCompletionItems(parsed, []);
  }
  if (parsed.sub !== "execute" && parsed.sub !== "validate") return [];

  const cwd = process.cwd();
  const r = await pi.exec(
    "find",
    [
      ".",
      "-maxdepth",
      "4",
      "-name",
      "*.json",
      "-not",
      "-path",
      "./node_modules/*",
      "-not",
      "-path",
      "./.git/*",
    ],
    { cwd },
  );
  if (r.code !== 0) return [];
  const paths = r.stdout
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return buildCompletionItems(parsed, paths);
}

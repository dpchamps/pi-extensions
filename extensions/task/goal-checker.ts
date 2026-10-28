import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Invocation } from "../background-command/launch.js";
import { hostInvocation } from "../background-command/launch.js";

const CHECKER_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_LIMIT = 16 * 1024;

const CHECKER_SYSTEM_PROMPT = `You are an independent goal evaluator, not the implementing agent.
Inspect the live workspace and use direct evidence such as files, diffs, tests, typechecks, and focused commands.
Never accept an implementation agent's claims as evidence. Never implement or repair the goal yourself.
You may update only the checklist file explicitly supplied in the request. Do not modify project files.
Keep planning and evaluation focused: use the checklist's verification steps, avoid broad re-analysis, and stop once every item has concrete evidence or a clear gap.`;

export interface GoalDecision {
  complete: boolean;
  feedback: string;
}

export interface GoalChecker {
  initialize(signal: AbortSignal): Promise<void>;
  evaluate(signal: AbortSignal): Promise<GoalDecision>;
  dispose(): Promise<void>;
}

export interface GoalCheckerConfig {
  cwd: string;
  prompt: string;
  model: { provider: string; id: string };
  thinkingLevel?: ExtensionContext["thinkingLevel"];
  projectTrusted: boolean;
  launchArgs?: string[];
  invocation?: Invocation;
}

function assistantText(message: unknown): string | undefined {
  const candidate = message as
    | {
        role?: string;
        content?: string | Array<{ type?: string; text?: string }>;
        stopReason?: string;
        errorMessage?: string;
      }
    | undefined;
  if (candidate?.role !== "assistant") return undefined;
  if (candidate.stopReason === "error")
    throw new Error(candidate.errorMessage ?? "goal checker model failed");
  if (typeof candidate.content === "string") return candidate.content;
  return candidate.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
    candidates.push(match[1].trim());

  for (
    let start = text.indexOf("{");
    start >= 0;
    start = text.indexOf("{", start + 1)
  ) {
    for (
      let end = text.lastIndexOf("}");
      end > start;
      end = text.lastIndexOf("}", end - 1)
    )
      candidates.push(text.slice(start, end + 1));
  }
  candidates.push(text.trim());
  return candidates;
}

export function parseGoalDecision(text: string): GoalDecision {
  for (const candidate of jsonCandidates(text)) {
    try {
      const value = JSON.parse(candidate) as {
        complete?: unknown;
        feedback?: unknown;
      };
      if (typeof value.complete !== "boolean") continue;
      if (value.feedback !== undefined && typeof value.feedback !== "string")
        continue;
      const feedback = value.feedback?.trim() ?? "";
      if (!value.complete && !feedback) continue;
      return { complete: value.complete, feedback };
    } catch {
      // Try the next candidate. Evaluators occasionally wrap the JSON in prose.
    }
  }
  throw new Error("goal checker did not return a valid completion decision");
}

async function runChecker(
  config: GoalCheckerConfig,
  systemPromptPath: string,
  request: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw new Error("goal checker was cancelled");

  const invocation = config.invocation ?? hostInvocation();
  const args = [
    ...invocation.args,
    ...(config.launchArgs ?? []),
    "--mode",
    "json",
    "-p",
    "--no-session",
    config.projectTrusted ? "--approve" : "--no-approve",
    "--provider",
    config.model.provider,
    "--model",
    config.model.id,
    "--append-system-prompt",
    systemPromptPath,
  ];
  if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
  args.push(request);

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.command, args, {
      cwd: config.cwd,
      env: { ...process.env, PI_TASK_GOAL_CHILD: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let buffer = "";
    let stderr = "";
    let finalText = "";
    let failure: Error | undefined;
    let timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const terminate = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5000);
    };
    const abort = () => {
      failure = new Error("goal checker was cancelled");
      terminate();
    };
    signal.addEventListener("abort", abort, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      failure = new Error(
        `goal checker timed out after ${CHECKER_TIMEOUT_MS / 1000}s`,
      );
      terminate();
    }, CHECKER_TIMEOUT_MS);

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as { type?: string; message?: unknown };
        if (event.type === "message_end") {
          const text = assistantText(event.message);
          if (text !== undefined) finalText = text;
        }
      } catch (error) {
        if (error instanceof SyntaxError) return;
        failure = error instanceof Error ? error : new Error(String(error));
      }
    };

    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      signal.removeEventListener("abort", abort);
      if (buffer.trim()) processLine(buffer);

      const diagnostic = stderr ? `\nChecker stderr:\n${stderr}` : "";
      if (failure) {
        reject(new Error(`${failure.message}${diagnostic}`));
        return;
      }
      if (timedOut) {
        reject(new Error(`goal checker timed out${diagnostic}`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `goal checker exited with code ${code} (signal ${closeSignal ?? "none"})${diagnostic}`,
          ),
        );
        return;
      }
      if (!finalText.trim()) {
        reject(
          new Error(`goal checker returned no final response${diagnostic}`),
        );
        return;
      }
      resolve(finalText);
    });
  });
}

export async function createGoalChecker(
  config: GoalCheckerConfig,
): Promise<GoalChecker> {
  const directory = await mkdtemp(join(tmpdir(), "pi-task-goal-"));
  const checklistPath = join(directory, "checklist.md");
  const systemPromptPath = join(directory, "checker-system.md");
  await writeFile(systemPromptPath, CHECKER_SYSTEM_PROMPT, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(checklistPath, "", { encoding: "utf8", mode: 0o600 });

  return {
    async initialize(signal) {
      await runChecker(
        config,
        systemPromptPath,
        [
          "Create the independent acceptance checklist before implementation begins.",
          `Checklist file: ${JSON.stringify(checklistPath)}`,
          "",
          "Inspect the current workspace only enough to understand the starting state.",
          "Write a concise Markdown checklist with 3-12 observable acceptance criteria.",
          "For every item include a concrete verification method (file inspection, test, typecheck, or command).",
          "Record baseline facts when useful. Do not implement anything.",
          'After writing the file, return only {"ready":true}.',
          "",
          "<goal>",
          config.prompt,
          "</goal>",
        ].join("\n"),
        signal,
      );
      const checklist = await readFile(checklistPath, "utf8");
      if (checklist.trim().length < 20)
        throw new Error("goal checker did not create a usable checklist");
    },

    async evaluate(signal) {
      const output = await runChecker(
        config,
        systemPromptPath,
        [
          "Evaluate the current workspace against the existing checklist.",
          `Checklist file: ${JSON.stringify(checklistPath)}`,
          "",
          "Read the checklist, then independently verify every criterion using direct workspace evidence.",
          "Do not trust checked boxes, comments, summaries, or implementation claims without reproducing the evidence.",
          "Update the checklist: mark verified items, attach concise evidence, and leave unmet items unchecked with the observed gap.",
          "Do not implement fixes. Do not modify project files.",
          "Complete is true only when every criterion is verified and no relevant verification failed.",
          'Return only JSON: {"complete":boolean,"feedback":"concise evidence-based next steps, or a short completion summary"}.',
          "",
          "<goal>",
          config.prompt,
          "</goal>",
        ].join("\n"),
        signal,
      );
      return parseGoalDecision(output);
    },

    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

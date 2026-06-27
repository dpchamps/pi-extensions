/**
 * Pipeline loader: reads a JSON file, validates it against the TypeBox schema,
 * runs additional semantic checks, and exposes a small helper for resolving
 * prompt/systemPrompt {inline, file} objects to strings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { Pipeline, type TPipeline, type TPromptObj } from "./schema.js";

export class PipelineLoadError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "PipelineLoadError";
  }
}

export interface LoadedPipeline {
  pipeline: TPipeline;
  /** Absolute directory containing the pipeline file. Used to resolve `prompt.file` paths. */
  dir: string;
  /** Absolute path to the pipeline file itself. */
  filePath: string;
}

export async function loadPipeline(filePath: string): Promise<LoadedPipeline> {
  const absPath = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.promises.readFile(absPath, "utf8");
  } catch (e) {
    throw new PipelineLoadError(
      `failed to read pipeline at ${absPath}: ${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PipelineLoadError(
      `pipeline at ${absPath} is not valid JSON: ${(e as Error).message}`,
    );
  }

  if (!Value.Check(Pipeline, parsed)) {
    const issues: string[] = [];
    for (const err of Value.Errors(Pipeline, parsed)) {
      issues.push(`${err.path || "/"}: ${err.message}`);
      if (issues.length >= 10) break;
    }
    throw new PipelineLoadError(
      `pipeline at ${absPath} failed schema validation`,
      issues,
    );
  }

  const pipeline = parsed as TPipeline;
  const semantic = validateSemantics(pipeline);
  if (semantic.length > 0) {
    throw new PipelineLoadError(
      `pipeline at ${absPath} has semantic errors`,
      semantic,
    );
  }

  return { pipeline, dir: path.dirname(absPath), filePath: absPath };
}

/**
 * Pure semantic validation. Returns an array of human-readable issue strings;
 * empty array means valid.
 */
export function validateSemantics(pipeline: TPipeline): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  for (const u of pipeline.units) {
    if (seenIds.has(u.id)) {
      issues.push(`duplicate unit id "${u.id}"`);
    }
    seenIds.add(u.id);

    issues.push(...validatePromptObj(u.prompt, `units[${u.id}].prompt`));
    issues.push(
      ...validatePromptObj(u.systemPrompt, `units[${u.id}].systemPrompt`),
    );
  }

  if (pipeline.start && !seenIds.has(pipeline.start)) {
    issues.push(`start "${pipeline.start}" does not match any unit id`);
  }

  // At most one unit may have kind:"start" (we resolve it as the implicit start).
  const explicitStarts = pipeline.units.filter((u) => u.kind === "start");
  if (explicitStarts.length > 1) {
    issues.push(
      `multiple units have kind:"start" (${explicitStarts.map((u) => u.id).join(", ")}) — at most one allowed`,
    );
  }

  const terminalIds = new Set(
    pipeline.units.filter((u) => u.kind === "terminal").map((u) => u.id),
  );

  for (const e of pipeline.flow ?? []) {
    if (!seenIds.has(e.from)) {
      issues.push(`edge.from "${e.from}" does not match any unit id`);
    }
    if (e.to !== "$end" && !seenIds.has(e.to)) {
      issues.push(`edge.to "${e.to}" does not match any unit id (or "$end")`);
    }
    if (terminalIds.has(e.from)) {
      issues.push(
        `edge.from "${e.from}" is a terminal unit — terminals cannot have outgoing edges`,
      );
    }
  }

  return issues;
}

function validatePromptObj(
  obj: TPromptObj | undefined,
  pathLabel: string,
): string[] {
  if (!obj) return [];
  const has = {
    inline: typeof obj.inline === "string",
    file: typeof obj.file === "string",
  };
  if (has.inline && has.file) {
    return [`${pathLabel}: must specify only one of "inline" or "file"`];
  }
  if (!has.inline && !has.file) {
    return [`${pathLabel}: must specify one of "inline" or "file"`];
  }
  return [];
}

/**
 * Resolve a prompt/systemPrompt object to a string. `file` paths are read from
 * disk relative to `dir`; reads are lazy (each call re-reads) so file edits
 * are picked up between visits.
 */
export async function resolvePromptObj(
  obj: TPromptObj | undefined,
  dir: string,
): Promise<string | undefined> {
  if (!obj) return undefined;
  if (typeof obj.inline === "string") return obj.inline;
  if (typeof obj.file === "string") {
    const abs = path.isAbsolute(obj.file)
      ? obj.file
      : path.resolve(dir, obj.file);
    return await fs.promises.readFile(abs, "utf8");
  }
  return undefined;
}

/**
 * Resolve the start unit id: explicit `start` field > unit with kind:"start"
 * > first unit. Throws if pipeline has no units (the schema enforces minItems
 * 1, so this shouldn't trigger from validated input).
 */
export function resolveStartId(pipeline: TPipeline): string {
  if (pipeline.start) return pipeline.start;
  const explicit = pipeline.units.find((u) => u.kind === "start");
  if (explicit) return explicit.id;
  if (pipeline.units.length === 0) {
    throw new PipelineLoadError("pipeline has no units");
  }
  return pipeline.units[0].id;
}

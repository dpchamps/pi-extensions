import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type Explorer = string[] | false;

const DEFAULT_EXPLORERS: Record<string, Explorer> = {
  vi: ["-c", "Explore"],
  vim: ["-c", "Explore"],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExplorers(value: unknown): Map<string, Explorer> {
  if (!isObject(value)) throw new Error("expected a config object");
  if (value.explorers === undefined) return new Map();
  if (!isObject(value.explorers)) {
    throw new Error('"explorers" must be an object keyed by editor name');
  }

  const entries = new Map<string, Explorer>();
  for (const [editor, args] of Object.entries(value.explorers)) {
    if (
      args !== false &&
      (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
    ) {
      throw new Error(
        `explorers.${editor} must be an array of arguments or false`,
      );
    }
    entries.set(editor, args);
  }
  return entries;
}

/** Read on each no-path invocation so local declarations need no reload. */
export function loadExplorers(
  cwd: string,
  projectTrusted: boolean,
  warn: (message: string) => void,
): Map<string, Explorer> {
  const explorers = new Map(Object.entries(DEFAULT_EXPLORERS));
  const files = [path.join(getAgentDir(), "file.json")];
  if (projectTrusted) files.push(path.join(cwd, ".pi", "file.json"));

  for (const file of files) {
    try {
      const entries = parseExplorers(JSON.parse(readFileSync(file, "utf8")));
      for (const [editor, args] of entries) explorers.set(editor, args);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`Ignoring ${file}: ${String(error)}`);
      }
    }
  }
  return explorers;
}

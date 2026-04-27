/**
 * Pure completion logic, kept separate from index.ts so it can be tested
 * without pulling in the pi SDK (which has runtime side effects on import).
 */

import * as path from "node:path";

export const SUBCOMMANDS = ["create", "merge", "switch"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface WorktreeRef {
  path: string;
  branch: string;
}

export type CompletionParse =
  | { stage: "sub"; argPrefix: string }
  | { stage: "arg"; sub: string; argPrefix: string };

export function parseCompletionPrefix(prefix: string): CompletionParse {
  const trailingWS = /\s$/.test(prefix);
  const parts = prefix.split(/\s+/).filter((x) => x !== "");
  if (parts.length === 0) return { stage: "sub", argPrefix: "" };
  if (parts.length === 1 && !trailingWS)
    return { stage: "sub", argPrefix: parts[0] };
  return {
    stage: "arg",
    sub: parts[0],
    argPrefix: parts.slice(1).join(" "),
  };
}

/**
 * Build the AutocompleteItems for the parsed prefix. Pi-tui's applyCompletion
 * replaces the *entire* argumentText (everything after `/worktree `) with
 * item.value, so values must be the full post-command replacement, not just
 * the token being edited.
 *
 * - Subcommand stage: value = `<sub> ` (trailing space so the user can keep
 *   tab-completing the next token).
 * - Argument stage: value = `<sub> <arg>` (full replacement, no trailing space).
 *
 * `mainDir` and `linked` are passed in pre-resolved so this function is pure.
 */
export function buildCompletionItems(
  parsed: CompletionParse,
  mainDir: string,
  linked: WorktreeRef[],
): AutocompleteItem[] {
  if (parsed.stage === "sub") {
    return SUBCOMMANDS.filter((s) => s.startsWith(parsed.argPrefix)).map(
      (s) => ({ value: `${s} `, label: s }),
    );
  }

  const sub = parsed.sub;
  if (sub !== "merge" && sub !== "switch") return [];

  type Candidate = { name: string; description?: string };
  const candidates: Candidate[] = linked.map((w) => ({
    name: w.branch,
    description: path.relative(mainDir, w.path) || w.path,
  }));
  if (sub === "switch") {
    candidates.unshift({ name: "main", description: mainDir });
  }

  return candidates
    .filter((c) => c.name.startsWith(parsed.argPrefix))
    .map((c) => ({
      value: `${sub} ${c.name}`,
      label: c.name,
      description: c.description,
    }));
}

export function parentBranchOf(wtBranch: string): string | null {
  const m = wtBranch.match(/^(.+)-wt-\d+$/);
  return m ? m[1] : null;
}

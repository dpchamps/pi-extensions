/**
 * Pure completion logic for /background. Mirrors the worktree-command pattern:
 * stage-1 = subcommand, stage-2 = subcommand-specific args. Kept free of pi
 * imports so it can be unit-tested without runtime side effects.
 */

export const SUBCOMMANDS = ["list", "resume", "kill", "delete"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export const STATUS_FILTERS = ["active", "paused", "killed"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export type TaskStatus = "active" | "paused" | "killed";

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface TaskRef {
  id: string;
  status: TaskStatus;
  promptPreview: string;
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
 * Build AutocompleteItems for the parsed prefix. pi-tui's applyCompletion
 * replaces the entire argumentText (everything after `/background `) with
 * item.value, so values must be the full post-command replacement.
 *
 * - Subcommand stage: value = `<sub> ` (trailing space so the next token
 *   keeps tab-completing).
 * - Argument stage: value = `<sub> <arg>` (full replacement).
 *
 * `tasks` is passed in pre-resolved so this function stays pure. For `resume`
 * and `kill`, callers should filter to alive tasks (status !== "killed").
 * For `delete`, all tasks are valid.
 */
export function buildCompletionItems(
  parsed: CompletionParse,
  tasks: TaskRef[],
): AutocompleteItem[] {
  if (parsed.stage === "sub") {
    return SUBCOMMANDS.filter((s) => s.startsWith(parsed.argPrefix)).map(
      (s) => ({ value: `${s} `, label: s }),
    );
  }

  const sub = parsed.sub;

  if (sub === "list") {
    return STATUS_FILTERS.filter((s) => s.startsWith(parsed.argPrefix)).map(
      (s) => ({ value: `list ${s}`, label: s }),
    );
  }

  if (sub === "resume" || sub === "kill" || sub === "delete") {
    return tasks
      .filter((t) => t.id.startsWith(parsed.argPrefix))
      .map((t) => ({
        value: `${sub} ${t.id}`,
        label: t.id,
        description: `[${t.status}] ${t.promptPreview}`,
      }));
  }

  return [];
}

/**
 * Truncate a prompt to a single-line preview. Used in list rendering and in
 * completion item descriptions so the user can identify a task at a glance.
 */
export function truncatePrompt(s: string, max = 60): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

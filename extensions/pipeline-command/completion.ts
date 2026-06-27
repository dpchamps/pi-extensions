/**
 * Pure tab-completion logic for /pipeline. Kept separate from index.ts so it
 * can be tested without the pi runtime.
 *
 * Completion shape mirrors @dpchamps/pi-worktree-command's completion.ts:
 *   `value` is the FULL replacement of the argumentText (everything after
 *   `/pipeline `), not just the token being edited.
 */

export const SUBCOMMANDS = ["execute", "validate"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export type CompletionParse =
  | { stage: "sub"; argPrefix: string }
  | { stage: "arg"; sub: string; argPrefix: string };

export function parseCompletionPrefix(prefix: string): CompletionParse {
  const trailingWS = /\s$/.test(prefix);
  const parts = prefix.split(/\s+/).filter((x) => x !== "");
  if (parts.length === 0) return { stage: "sub", argPrefix: "" };
  if (parts.length === 1 && !trailingWS) {
    return { stage: "sub", argPrefix: parts[0] };
  }
  return {
    stage: "arg",
    sub: parts[0],
    argPrefix: parts.slice(1).join(" "),
  };
}

const DESCRIPTIONS: Record<Subcommand, string> = {
  execute: "run a pipeline JSON",
  validate: "schema-check a pipeline JSON without running it",
};

export function buildCompletionItems(
  parsed: CompletionParse,
  jsonPaths: string[],
): AutocompleteItem[] {
  if (parsed.stage === "sub") {
    return SUBCOMMANDS.filter((s) => s.startsWith(parsed.argPrefix)).map(
      (s) => ({
        value: `${s} `,
        label: s,
        description: DESCRIPTIONS[s],
      }),
    );
  }

  const sub = parsed.sub;
  if (sub !== "execute" && sub !== "validate") return [];

  return jsonPaths
    .filter((p) => p.startsWith(parsed.argPrefix))
    .map((p) => ({
      value: `${sub} ${p}`,
      label: p,
    }));
}

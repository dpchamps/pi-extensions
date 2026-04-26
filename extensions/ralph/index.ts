/**
 * ralph extension — /ralph command that loops a prompt until a verification
 * script returns exit code 0 (or hits the iteration cap).
 *
 * Usage:
 *   /ralph "<prompt>" "<verify-script>" <iteration-cap>
 *
 * Each iteration:
 *   1. Send the prompt as a user message (extension source) and await idle.
 *   2. Run the verify script via `bash -c`.
 *   3. If exit code is 0, stop. Otherwise re-send the prompt with the failing
 *      output appended so the agent can react to it.
 *
 * Abort: while the loop is active, any interactive user input flips the
 * abort flag and the loop exits at the next safe checkpoint.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ParsedArgs = {
  prompt: string;
  verifyScript: string;
  maxIterations: number;
};

const MAX_VERIFY_OUTPUT = 8000;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let hasContent = false;
  let inQuote: '"' | "'" | null = null;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inQuote) {
      if (ch === "\\" && i + 1 < input.length) {
        cur += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      hasContent = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasContent) {
        tokens.push(cur);
        cur = "";
        hasContent = false;
      }
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      cur += input[i + 1];
      hasContent = true;
      i += 2;
      continue;
    }
    cur += ch;
    hasContent = true;
    i++;
  }
  if (hasContent) tokens.push(cur);
  return tokens;
}

function parseArgs(args: string): ParsedArgs | null {
  const tokens = tokenize(args.trim());
  if (tokens.length !== 3) return null;
  const [prompt, verifyScript, capStr] = tokens;
  const cap = Number.parseInt(capStr, 10);
  if (!Number.isFinite(cap) || cap < 1) return null;
  if (!prompt.trim() || !verifyScript.trim()) return null;
  return { prompt, verifyScript, maxIterations: cap };
}

function truncate(s: string, max: number): string {
  return s.length <= max
    ? s
    : `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]`;
}

export default function (pi: ExtensionAPI) {
  let activeLoop: { aborted: boolean } | null = null;

  // Any interactive input during the loop signals abort. ralph's own
  // sendUserMessage uses source="extension", so it never trips this.
  pi.on("input", async (event) => {
    if (activeLoop && event.source === "interactive") {
      activeLoop.aborted = true;
    }
    return { action: "continue" };
  });

  pi.registerCommand("ralph", {
    description:
      'Loop a prompt until a verify script exits 0. Usage: /ralph "<prompt>" "<verify>" <cap>',
    handler: async (args, ctx) => {
      let parsed = parseArgs(args);

      if (!parsed) {
        if (args.trim()) {
          ctx.ui.notify(
            'Ralph: usage /ralph "<prompt>" "<verify-script>" <iteration-cap>',
            "warning",
          );
        }
        const promptText = await ctx.ui.editor(
          "Ralph: prompt to send each iteration",
        );
        if (!promptText) return;
        const verifyScript = await ctx.ui.input(
          "Ralph: verification script (bash -c ...)",
          "e.g. npm test",
        );
        if (!verifyScript) return;
        const capStr = await ctx.ui.input("Ralph: iteration cap", "10");
        if (!capStr) return;
        const cap = Number.parseInt(capStr, 10);
        if (!Number.isFinite(cap) || cap < 1) {
          ctx.ui.notify("Ralph: invalid iteration cap", "error");
          return;
        }
        parsed = { prompt: promptText, verifyScript, maxIterations: cap };
      }

      if (activeLoop) {
        ctx.ui.notify(
          "Ralph: a loop is already running. Send a message to abort it first.",
          "warning",
        );
        return;
      }

      const { prompt, verifyScript, maxIterations } = parsed;
      const loopState = { aborted: false };
      activeLoop = loopState;

      const setStatus = (text: string | undefined) =>
        ctx.ui.setStatus(
          "ralph",
          text === undefined ? undefined : ctx.ui.theme.fg("accent", text),
        );

      ctx.ui.notify(
        `Ralph: starting (max ${maxIterations} iterations, verify: ${verifyScript}). Type any message to abort.`,
        "info",
      );

      let lastOutput = "";

      try {
        for (let iter = 1; iter <= maxIterations; iter++) {
          if (loopState.aborted) {
            ctx.ui.notify("Ralph: aborted", "info");
            return;
          }

          setStatus(`↻ ralph ${iter}/${maxIterations}`);
          await ctx.waitForIdle();

          if (loopState.aborted) {
            ctx.ui.notify("Ralph: aborted", "info");
            return;
          }

          const message =
            iter === 1
              ? prompt
              : `The verification command \`${verifyScript}\` is still failing. Last run:\n\n\`\`\`\n${lastOutput}\n\`\`\`\n\nKeep iterating on this task:\n\n${prompt}`;

          pi.sendUserMessage(message);
          await ctx.waitForIdle();

          if (loopState.aborted) {
            ctx.ui.notify(`Ralph: aborted after iteration ${iter}`, "info");
            return;
          }

          setStatus(`↻ ralph verifying (${iter}/${maxIterations})`);
          const result = await pi.exec("bash", ["-c", verifyScript], {
            cwd: ctx.cwd,
          });

          if (result.code === 0) {
            ctx.ui.notify(
              `Ralph: verification passed after ${iter} iteration(s)`,
              "info",
            );
            return;
          }

          lastOutput = truncate(
            `[exit ${result.code}]\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
            MAX_VERIFY_OUTPUT,
          );
        }

        ctx.ui.notify(
          `Ralph: hit cap of ${maxIterations} iterations without verification success`,
          "warning",
        );
      } finally {
        activeLoop = null;
        setStatus(undefined);
      }
    },
  });
}

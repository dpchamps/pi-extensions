/**
 * clear-command extension — /clear command to wipe conversation context.
 *
 * Clears context while preserving the session file (cost tracking intact).
 * Like /new but without creating a new session.
 */

import type {
  ExtensionAPI,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description:
      "Clear conversation context (preserves session and cost tracking)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const sm = ctx.sessionManager as SessionManager;
      const leafId = sm.getLeafId();

      if (!leafId) {
        ctx.ui.notify("Session is already empty.", "info");
        return;
      }

      // Walk the branch to compute tokens used before clearing
      const branch = sm.getBranch();
      let tokensBefore = 0;
      for (const entry of branch) {
        if (
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          entry.message?.usage
        ) {
          tokensBefore += entry.message.usage.totalTokens ?? 0;
        }
      }

      // Append a compaction entry that keeps nothing.
      // firstKeptEntryId = current leaf means no messages are retained.
      // The compaction summary is a minimal marker — the LLM starts fresh.
      sm.appendCompaction(
        "Previous conversation cleared by user. No prior context available.",
        leafId,
        tokensBefore,
        { cleared: true },
        true,
      );

      ctx.ui.notify(
        "Context cleared. Session and cost history preserved.",
        "info",
      );
    },
  });
}

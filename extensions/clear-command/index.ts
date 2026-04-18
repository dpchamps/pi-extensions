/**
 * clear-command extension — /clear command to wipe conversation context.
 *
 * Clears context while preserving the session file (cost tracking intact).
 * Like /new but without creating a new session.
 *
 * Navigates to the first user message entry. When navigateTree processes
 * a user message, it sets the leaf to the message's parent. For the root
 * message (no parent), the leaf becomes null → zero context. This also
 * triggers InteractiveMode's navigateTree handler which clears the TUI.
 */

import type {
  ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description:
      "Clear conversation context (preserves session and cost tracking)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const sm = ctx.sessionManager as any;

      if (!sm) {
        ctx.ui.notify("Session manager unavailable", "error");
        return;
      }

      // Already at root (empty context)
      if (!sm.getLeafId()) {
        ctx.ui.notify("Session is already empty.", "info");
        return;
      }

      // Find the first user message entry — navigating to it sets leaf to its parent (null for root)
      const entries: Array<{ id: string; type: string; message?: { role: string } }> = sm.getEntries();
      let targetId: string | null = null;

      for (const entry of entries) {
        if (entry.type === "message" && entry.message?.role === "user") {
          targetId = entry.id;
          break;
        }
      }

      if (!targetId) {
        ctx.ui.notify("No messages to clear.", "info");
        return;
      }

      // Navigate to the first user message with summarize: false.
      // navigateTree sets leaf = targetEntry.parentId.
      // For the root message, parentId is null → leaf becomes null → zero context.
      // InteractiveMode's navigateTree handler then clears the chat container and re-renders.
      try {
        await ctx.navigateTree(targetId, { summarize: false });
      } catch (err) {
        // Fallback: reset leaf directly if navigateTree fails
        sm.resetLeaf();
        ctx.ui.notify("Context cleared (UI may need /reload).", "info");
        return;
      }

      // Clear the text box — navigateTree re-renders with the message content,
      // so we must explicitly clear it to keep the input empty.
      ctx.ui.setEditorText("");

      ctx.ui.notify(
        "Context cleared. Session and cost history preserved.",
        "info",
      );
    },
  });
}
/**
 * file-command extension — /file <path> opens a file in $VISUAL/$EDITOR
 * with full terminal access. The TUI suspends while the editor runs.
 *
 * Modeled on the built-in interactive-shell pattern: ctx.ui.custom() is the
 * only public API path that exposes tui.stop()/tui.start(), which we need to
 * release the terminal so spawnSync can inherit stdio.
 */

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("file", {
    description: "Open a file in $VISUAL/$EDITOR. Usage: /file <path>",
    handler: async (args, ctx) => {
      const editorCmd = process.env.VISUAL || process.env.EDITOR;
      if (!editorCmd) {
        ctx.ui.notify(
          "No editor configured. Set $VISUAL or $EDITOR.",
          "error",
        );
        return;
      }

      let target = args.trim();
      if (!target) {
        const input = await ctx.ui.input("File path to open");
        if (!input) return;
        target = input.trim();
        if (!target) return;
      }

      const resolved = path.resolve(ctx.cwd, expandHome(target));

      await ctx.waitForIdle();

      // Match openExternalEditor: split on space so "code --wait" works.
      const [editor, ...editorArgs] = editorCmd.split(" ");

      const exitCode = await ctx.ui.custom<number | null>(
        (tui, _theme, _kb, done) => {
          tui.stop();
          process.stdout.write("\x1b[2J\x1b[H");
          const result = spawnSync(editor, [...editorArgs, resolved], {
            stdio: "inherit",
            env: process.env,
          });
          tui.start();
          tui.requestRender(true);
          done(result.status);
          return { render: () => [], invalidate: () => {} };
        },
      );

      if (exitCode === 0) {
        ctx.ui.notify(`closed ${resolved}`, "info");
      } else {
        ctx.ui.notify(
          `editor exited with code ${exitCode ?? "?"}`,
          "warning",
        );
      }
    },
  });
}

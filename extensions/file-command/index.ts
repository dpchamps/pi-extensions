/**
 * /file [path] opens a file or the editor's configured filesystem explorer
 * in $VISUAL/$EDITOR. The TUI suspends while the editor runs.
 *
 * Modeled on the built-in interactive-shell pattern: ctx.ui.custom() is the
 * only public API path that exposes tui.stop()/tui.start(), which we need to
 * release the terminal so spawnSync can inherit stdio.
 */

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadExplorers } from "./config.js";

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("file", {
    description:
      "Open a file or editor explorer in $VISUAL/$EDITOR. Usage: /file [path]",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/file requires interactive TUI mode.", "error");
        return;
      }

      const editorCmd =
        process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
      if (!editorCmd) {
        ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "error");
        return;
      }

      // Preserve editor flags (e.g. "code --wait"); no shell evaluation.
      const [editor, ...editorArgs] = editorCmd.split(/\s+/);
      let target = args.trim();
      let explorerArgs: string[] | undefined;
      if (!target) {
        const explorers = loadExplorers(
          ctx.cwd,
          ctx.isProjectTrusted(),
          (message) => ctx.ui.notify(message, "warning"),
        );
        const explorer = explorers.get(path.basename(editor));
        if (explorer) {
          explorerArgs = explorer.map((arg) =>
            arg.replaceAll("{cwd}", () => ctx.cwd),
          );
        } else {
          const input = await ctx.ui.input("File path to open");
          if (!input) return;
          target = input.trim();
          if (!target) return;
        }
      }

      const resolved = target
        ? path.resolve(ctx.cwd, expandHome(target))
        : ctx.cwd;
      const launchArgs = [...editorArgs, ...(explorerArgs ?? [resolved])];

      await ctx.waitForIdle();

      const result = await ctx.ui.custom<ReturnType<typeof spawnSync>>(
        (tui, _theme, _kb, done) => {
          tui.stop();
          let result: ReturnType<typeof spawnSync>;
          try {
            process.stdout.write("\x1b[2J\x1b[H");
            result = spawnSync(editor, launchArgs, {
              cwd: ctx.cwd,
              stdio: "inherit",
              env: process.env,
            });
          } finally {
            tui.start();
            tui.requestRender(true);
          }
          done(result);
          return { render: () => [], invalidate: () => {} };
        },
      );

      if (result.error) {
        ctx.ui.notify(
          `Could not start editor: ${result.error.message}`,
          "error",
        );
      } else if (result.status === 0) {
        ctx.ui.notify(`closed ${resolved}`, "info");
      } else {
        ctx.ui.notify(
          `editor exited with code ${result.status ?? "?"}`,
          "warning",
        );
      }
    },
  });
}

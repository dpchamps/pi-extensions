/** /shell borrows the terminal for a fresh interactive shell, without recording it. */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("shell", {
    description: "Open a fresh interactive shell; exit to return to Pi",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/shell requires interactive TUI mode.", "error");
        return;
      }

      await ctx.waitForIdle();
      const shell = process.env.SHELL || "/bin/sh";
      const failure = await ctx.ui.custom<unknown>(
        async (tui, _theme, _kb, done) => {
          // Don't flush Pi's fullscreen transcript into the main screen.
          tui.stop({ preserveScreen: true });
          // The child owns Ctrl+C while Pi's terminal handling is stopped.
          const ignoreSigint = () => {};
          process.on("SIGINT", ignoreSigint);
          let failure: unknown;
          try {
            process.stdout.write("\x1b[?1049h\x1b[0m\x1b[2J\x1b[H");
            await new Promise<void>((resolve, reject) => {
              const child = spawn(shell, ["-i"], {
                cwd: ctx.cwd,
                stdio: "inherit",
                env: process.env,
              });
              child.once("error", reject);
              // A nonzero exit is normal shell behavior, not a Pi error.
              child.once("close", () => resolve());
            });
          } catch (error) {
            failure = error;
          } finally {
            process.removeListener("SIGINT", ignoreSigint);
            process.stdout.write("\x1b[0m\x1b[?1049l");
            tui.start();
            tui.requestRender(true);
          }
          done(failure);
          return { render: () => [], invalidate: () => {} };
        },
      );
      if (failure) {
        ctx.ui.notify(`Could not start shell: ${String(failure)}`, "error");
      }
    },
  });
}

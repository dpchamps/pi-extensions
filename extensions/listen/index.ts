import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { UnixListener } from "./listener.js";
import {
  boundedText,
  type RequestRecord,
  type RequestStatus,
} from "./protocol.js";
import { RequestStore, sessionStoreDirectory } from "./store.js";

export interface ListenOptions {
  /** Overrides for isolated SDK hosts/tests; normal use needs no configuration. */
  tempDirectory?: string;
  storeRoot?: string;
  skillDirectory?: string;
  dispatchTimeoutMs?: number;
}

interface ActiveRequest {
  record: RequestRecord;
  marker: string;
  prepared: boolean;
  user?: UserMessage;
  assistant?: AssistantMessage;
  outcome?: "completed" | "aborted" | "error";
  watchdog?: ReturnType<typeof setTimeout>;
}

interface Listening {
  listener: UnixListener;
  store: RequestStore;
  ctx: ExtensionContext;
  active?: ActiveRequest;
  scheduled?: ReturnType<typeof setTimeout>;
}

function textOf(message: UserMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

export default function listen(
  pi: ExtensionAPI,
  options: ListenOptions = {},
): void {
  let current: Listening | undefined;
  let commands = Promise.resolve();
  let epoch = 0;

  function report(ctx: ExtensionContext, content: string, error = false): void {
    if (ctx.hasUI) ctx.ui.notify(content, error ? "error" : "info");
    else
      pi.sendMessage(
        { customType: "listen", content, display: true },
        { triggerTurn: false },
      );
  }

  async function stop(reason: string): Promise<void> {
    const state = current;
    if (!state) return;
    current = undefined;
    clearTimeout(state.scheduled);
    clearTimeout(state.active?.watchdog);
    try {
      for (const record of state.store.interruptPending(reason))
        state.listener.publish(record);
    } finally {
      try {
        await state.listener.close();
      } finally {
        state.store.close();
      }
    }
  }

  function fatal(error: unknown): void {
    const state = current;
    if (!state) return;
    try {
      report(
        state.ctx,
        `Listen: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } catch {
      // A host may already have invalidated its context. Still release resources.
    }
    void stop(
      "Listener stopped after a storage or socket failure; work may have executed.",
    ).catch(() => {});
  }

  function finish(
    state: Listening,
    status: RequestStatus,
    result: { message?: string; error?: string; truncated?: boolean },
  ): void {
    const active = state.active;
    if (current !== state || !active) return;
    clearTimeout(active.watchdog);
    // Save before replying. A lost connection cannot lose the response.
    const record = state.store.update(active.record.id, status, result);
    state.active = undefined;
    state.listener.publish(record);
    schedule(state);
  }

  function watchDispatch(state: Listening, active: ActiveRequest): void {
    active.watchdog = setTimeout(() => {
      if (current !== state || state.active !== active || active.user) return;
      try {
        if (!state.ctx.isIdle()) {
          // Compaction/before_agent_start can take time. Do not mistake that for
          // rejection, and never automatically replay an uncertain submission.
          watchDispatch(state, active);
          return;
        }
        finish(state, "failed", {
          error:
            "Pi did not consume this handoff. An input extension may have handled/transformed it, or prompt preflight failed. It will not be replayed automatically.",
        });
      } catch (error) {
        fatal(error);
      }
    }, options.dispatchTimeoutMs ?? 30_000);
    active.watchdog.unref();
  }

  function schedule(state: Listening): void {
    if (current !== state || state.scheduled) return;
    state.scheduled = setTimeout(() => {
      state.scheduled = undefined;
      if (current !== state || state.active) return;
      try {
        if (!state.ctx.isIdle() || state.ctx.hasPendingMessages()) return;
        const record = state.store.next();
        if (!record) return;
        state.store.update(record.id, "running");
        const active: ActiveRequest = {
          record,
          marker: `[pi-listen:${record.token}]`,
          prepared: false,
        };
        state.active = active;
        watchDispatch(state, active);
        pi.sendUserMessage(
          `${active.marker}\nExternal handoff ${JSON.stringify(record.id)}. Respond to this handoff in your final answer.\n\n${record.input}`,
          // Handles a race with another prompt starting after the idle check.
          // No expansion: external text must not execute slash commands/skills.
          { deliverAs: "followUp", expandPromptTemplates: false },
        );
      } catch (error) {
        fatal(error);
      }
    }, 0);
    state.scheduled.unref();
  }

  pi.registerCommand("listen", {
    description:
      "Expose this session through a private Unix socket: /listen [status|stop]",
    handler: (args, ctx) => {
      const commandEpoch = epoch;
      const operation = commands
        .then(async () => {
          if (epoch !== commandEpoch) return;
          const subcommand = args.trim();
          if (
            subcommand !== "" &&
            subcommand !== "stop" &&
            subcommand !== "status"
          )
            throw new Error("Usage: /listen [status|stop]");
          if (subcommand === "status") {
            report(
              ctx,
              current?.listener.directory ?? "Listen: not listening.",
            );
            return;
          }
          if (subcommand === "stop") {
            await stop(
              "Listening stopped. Pending work is interrupted and will not be replayed. A running Pi operation may still finish.",
            );
            if (epoch === commandEpoch) report(ctx, "Listen: stopped.");
            return;
          }
          if (current) {
            report(ctx, current.listener.directory);
            return;
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const identity =
            ctx.sessionManager.getSessionFile() ?? `ephemeral:${sessionId}`;
          const store = new RequestStore(
            sessionStoreDirectory(
              options.storeRoot ??
                join(ctx.sessionManager.getSessionDir(), "listen"),
              identity,
            ),
          );
          let listener: UnixListener;
          try {
            listener = await UnixListener.start({
              store,
              sessionId,
              cwd: ctx.cwd,
              tempDirectory: options.tempDirectory,
              skillDirectory:
                options.skillDirectory ??
                fileURLToPath(
                  new URL("../../skills/pi-listen", import.meta.url),
                ),
              onSubmitted: () => {
                if (current) schedule(current);
              },
              onError: fatal,
            });
          } catch (error) {
            store.close();
            throw error;
          }
          if (epoch !== commandEpoch) {
            await listener.close();
            store.close();
            return;
          }
          current = { listener, store, ctx };
          report(
            ctx,
            `${listener.directory}\nSocket: ${listener.socketPath}\nClient skill: ${join(listener.directory, "pi-listen", "SKILL.md")}`,
          );
        })
        .catch((error) => {
          if (epoch === commandEpoch)
            report(
              ctx,
              `Listen: ${error instanceof Error ? error.message : String(error)}`,
              true,
            );
        });
      commands = operation;
      return operation;
    },
  });

  pi.on("before_agent_start", (event) => {
    const active = current?.active;
    if (
      active &&
      event.messageType === "user" &&
      event.prompt.includes(active.marker)
    )
      active.prepared = true;
  });

  pi.on("message_end", (event) => {
    const state = current;
    const active = state?.active;
    if (!state || !active) return;
    try {
      if (event.message.role === "user") {
        if (textOf(event.message).includes(active.marker)) {
          active.user = event.message;
          clearTimeout(active.watchdog);
        } else if (active.user) {
          // This is a shared session, not isolated client contexts. Fail closed
          // rather than returning a human's/unrelated extension's answer.
          finish(state, "interrupted", {
            error:
              "Another user message entered the shared conversation before this handoff settled. Its reply ownership is no longer unambiguous.",
          });
        }
      } else if (active.user && event.message.role === "assistant") {
        // Keep the reference: Pi applies subsequent message_end replacements in
        // place, including privacy/redaction handlers loaded after this one.
        active.assistant = event.message;
      }
    } catch (error) {
      fatal(error);
    }
  });

  pi.on("agent_before_settle", (event) => {
    if (current?.active?.user) current.active.outcome = event.outcome;
  });

  pi.on("agent_settled", (event) => {
    const state = current;
    if (!state) return;
    try {
      const active = state.active;
      if (active?.user) {
        const assistant = active.assistant;
        if (!textOf(active.user).includes(active.marker)) {
          finish(state, "interrupted", {
            error:
              "The handoff identity was transformed by an input/message extension; no reply was returned.",
          });
        } else if (event.aborted || assistant?.stopReason === "aborted") {
          finish(state, "interrupted", {
            error:
              "Pi was aborted. Side effects may have occurred; this request will not be replayed.",
          });
        } else if (
          !assistant ||
          active.outcome === "error" ||
          assistant.stopReason === "error" ||
          assistant.stopReason === "deferred"
        ) {
          finish(state, "failed", {
            error: boundedText(
              assistant?.errorMessage ??
                "Pi settled without a successful final assistant response",
              4096,
            ).text,
          });
        } else {
          const output = boundedText(
            assistant.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          );
          finish(state, "completed", {
            message: output.text,
            truncated: output.truncated || assistant.stopReason === "length",
          });
        }
      } else if (active?.prepared) {
        finish(state, "failed", {
          error:
            "Pi started the handoff but its user message could not be identified; no reply was returned.",
        });
      }
      // Never launch work inside the notification-only settled event. A timer
      // lets all other extensions settle/start their own continuations first.
      schedule(state);
    } catch (error) {
      fatal(error);
    }
  });

  pi.on("session_compact", () => {
    if (current) schedule(current);
  });
  pi.on("session_compact_failed", () => {
    if (current) schedule(current);
  });
  pi.on("session_tree", async () => {
    await stop(
      "Session branch changed. Listening must be explicitly enabled again.",
    );
  });
  pi.on("session_shutdown", async () => {
    epoch++;
    await commands;
    await stop(
      "Session stopped, changed or reloaded. Pending work is interrupted; completed replies remain recoverable in this session.",
    );
  });
}

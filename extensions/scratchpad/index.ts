import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ensureContext,
  type ContextMessages,
} from "../../lib/ensure-context.js";
import { ensureScratchpadDirectory, scratchpadDirectory } from "./directory.js";

export const SCRATCHPAD_MESSAGE_TYPE = "scratchpad";

interface ScratchpadState {
  sessionId: string;
  directory: string;
  declaration: string;
}

interface ScratchpadNotice {
  role: "custom";
  customType: typeof SCRATCHPAD_MESSAGE_TYPE;
  content: string;
  display: false;
  details: { sessionId: string; directory: string; restorationId: string };
  timestamp: number;
}

function textOf(message: ContextMessages[number]): string {
  if ("summary" in message && typeof message.summary === "string") {
    return message.summary;
  }
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function containsDeclaration(
  messages: Readonly<ContextMessages>,
  state: ScratchpadState,
): boolean {
  // Recognize a verbatim declaration even if a context manager merged it into
  // a summary or changed its role. Metadata alone is not model-visible guidance.
  return messages.some((message) =>
    textOf(message).includes(state.declaration),
  );
}

export default function scratchpad(
  pi: ExtensionAPI,
  options: { tempDir?: string } = {},
): void {
  const tempDir = options.tempDir ?? tmpdir();
  let state: ScratchpadState | undefined;
  let pending: ScratchpadNotice | undefined;

  function current(ctx: ExtensionContext): ScratchpadState {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!state || state.sessionId !== sessionId) {
      const directory = scratchpadDirectory(sessionId, tempDir);
      state = {
        sessionId,
        directory,
        declaration:
          `Current session scratchpad: ${JSON.stringify(directory)}. ` +
          "Use it for disposable calculations, exploratory scripts, and intermediate files. " +
          "Keep durable project changes in the project; scratchpad contents are temporary.",
      };
      pending = undefined;
    }
    return state;
  }

  function queueNotice(ctx: ExtensionContext): ScratchpadNotice {
    const active = current(ctx);
    const persisted =
      pending &&
      ctx.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === SCRATCHPAD_MESSAGE_TYPE &&
            (entry.details as ScratchpadNotice["details"] | undefined)
              ?.restorationId === pending?.details.restorationId,
        );
    if (pending && !persisted) return pending;

    pending = {
      role: "custom",
      customType: SCRATCHPAD_MESSAGE_TYPE,
      content: active.declaration,
      display: false,
      details: {
        sessionId: active.sessionId,
        directory: active.directory,
        restorationId: randomUUID(),
      },
      timestamp: Date.now(),
    };
    // While streaming, Pi persists this at the safe end-of-turn boundary.
    // Do not steer, queue a follow-up, or cause an additional model response.
    pi.sendMessage(pending, { triggerTurn: false });
    return pending;
  }

  pi.on("session_start", async (_event, ctx) => {
    state = undefined;
    pending = undefined;
    const active = current(ctx);
    await ensureScratchpadDirectory(active.sessionId, tempDir);
    if (
      !containsDeclaration(
        ctx.sessionManager.buildSessionProjection().messages,
        active,
      )
    ) {
      queueNotice(ctx);
    }
  });

  pi.on("session_tree", () => {
    // A pending notice on an abandoned branch must not suppress a new repair.
    pending = undefined;
  });
  pi.on("session_shutdown", () => {
    state = undefined;
    pending = undefined;
    // Keep files for /reload, session switches, and later resumption. These are
    // temporary files, not durable storage; OS/manual cleanup may remove them.
  });

  pi.on("context_with_system", (event, ctx) => {
    const active = current(ctx);
    let kept = false;
    const messages = event.messages.filter((message) => {
      if (
        message.role !== "custom" ||
        message.customType !== SCRATCHPAD_MESSAGE_TYPE
      ) {
        return true;
      }
      // Forks inherit history, but must not inherit another session's path.
      // Also avoid duplicates if a projection reset re-admits older repairs.
      if (textOf(message) !== active.declaration || kept) return false;
      kept = true;
      return true;
    });
    if (messages.length !== event.messages.length) return { messages };
  });

  ensureContext(pi, {
    present: (messages, ctx) => containsDeclaration(messages, current(ctx)),
    restore: async (messages, ctx) => {
      await ensureScratchpadDirectory(current(ctx).sessionId, tempDir);
      // Restore for THIS request too: a context-only sendMessage during a run is
      // not persisted until turn end, which would otherwise miss this response.
      return [...messages, queueNotice(ctx)];
    },
  });
}

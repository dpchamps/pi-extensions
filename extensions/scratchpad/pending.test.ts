import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import type { ContextMessages } from "../../lib/ensure-context.js";
import scratchpad from "./index.js";

it("queues a missing declaration only once until Pi persists it at turn end", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "scratchpad-pending-"));
  try {
    // Keep sendMessage pending, as Pi does while a provider request is active.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Handler = (event: any, ctx: ExtensionContext) => any;
    const handlers = new Map<string, Handler[]>();
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const pi = {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => {};
      },
      sendMessage,
    } as unknown as ExtensionAPI;
    const manager = SessionManager.inMemory();
    const ctx = { sessionManager: manager } as unknown as ExtensionContext;
    scratchpad(pi, { tempDir });

    const system: ContextMessages[number] = {
      role: "system",
      content: "System",
      timestamp: 0,
    };
    async function prepare(messages: ContextMessages) {
      for (const handler of handlers.get("context_with_system") ?? []) {
        const result = await handler(
          { type: "context_with_system", messages },
          ctx,
        );
        messages = result?.messages ?? messages;
      }
      return messages;
    }

    const first = await prepare([system]);
    const second = await prepare([system]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false });

    // Turn end: Pi finally appends the queued context-only message.
    const [notice] = sendMessage.mock.calls[0];
    manager.appendCustomMessageEntry(
      notice.customType,
      notice.content,
      notice.display,
      notice.details,
    );
    await prepare([system, ...manager.buildSessionProjection().messages]);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // A later independent projection removes the now-persisted declaration.
    await prepare([system]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][0].details).not.toEqual(notice.details);

    // Moving to a branch without the pending repair must not suppress it there.
    manager.resetLeaf();
    for (const handler of handlers.get("session_tree") ?? []) {
      await handler({ type: "session_tree" }, ctx);
    }
    await prepare([system]);
    expect(sendMessage).toHaveBeenCalledTimes(3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

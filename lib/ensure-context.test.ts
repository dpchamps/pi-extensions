import type {
  ContextEventResult,
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ensureContext,
  type ContextInvariant,
  type ContextMessages,
} from "./ensure-context.js";

type Handler = ExtensionHandler<ContextWithSystemEvent, ContextEventResult>;
const ctx = {} as ExtensionContext;
const system: ContextMessages[number] = {
  role: "system",
  content: "Keep this system prompt and its tool declarations.",
  timestamp: 0,
};
const declaration: ContextMessages[number] = {
  role: "custom",
  customType: "required-guidance",
  content: "Required guidance",
  display: false,
  timestamp: 0,
};
const contains = (messages: Readonly<ContextMessages>) =>
  messages.some(
    (message) =>
      message.role === "custom" && message.customType === "required-guidance",
  );

function setup(invariant: ContextInvariant) {
  let handler: Handler;
  const unsubscribe = vi.fn();
  const on = vi.fn((_event: string, callback: Handler) => {
    handler = callback;
    return unsubscribe;
  });
  const stop = ensureContext({ on } as unknown as ExtensionAPI, invariant);
  return {
    on,
    unsubscribe,
    stop,
    run: (messages: ContextMessages) =>
      handler({ type: "context_with_system", messages }, ctx),
  };
}

describe("ensureContext", () => {
  it("leaves a satisfied context untouched, including ordinary appended messages", async () => {
    const restore = vi.fn(() => [system, declaration]);
    const harness = setup({ present: contains, restore });
    const messages = [system, declaration];
    expect(await harness.run(messages)).toBeUndefined();
    expect(
      await harness.run([
        ...messages,
        { role: "user", content: "Next prompt", timestamp: 1 },
      ]),
    ).toBeUndefined();
    expect(restore).not.toHaveBeenCalled();
    expect(harness.on).toHaveBeenCalledWith(
      "context_with_system",
      expect.any(Function),
    );
  });

  it("awaits a repair before returning messages and verifies the repaired invariant", async () => {
    const present = vi.fn(async (messages: Readonly<ContextMessages>) =>
      contains(messages),
    );
    const restore = vi.fn(async (messages: Readonly<ContextMessages>) => [
      ...messages,
      declaration,
    ]);
    const harness = setup({ present, restore });
    const result = await harness.run([system]);
    expect(result?.messages).toEqual([system, declaration]);
    expect(result?.messages?.[0]).toBe(system);
    expect(present).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledWith([system], ctx);
    expect(await harness.run(result!.messages!)).toBeUndefined();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("rejects a repair that drops the leading system message", async () => {
    const harness = setup({ present: contains, restore: () => [declaration] });
    await expect(harness.run([system])).rejects.toThrow(
      "leading system message",
    );
  });

  it("rejects a repair that fails to restore the invariant", async () => {
    const harness = setup({
      present: contains,
      restore: (messages) => [...messages],
    });
    await expect(harness.run([system])).rejects.toThrow(
      "did not satisfy its invariant",
    );
  });

  it("returns Pi's unsubscribe function", () => {
    const harness = setup({ present: contains, restore: () => [declaration] });
    harness.stop();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });
});

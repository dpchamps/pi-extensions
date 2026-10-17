import type {
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type ContextMessages = ContextWithSystemEvent["messages"];
type MaybePromise<T> = T | Promise<T>;

export interface ContextInvariant {
  /** Check model-visible content, not the raw session history. */
  present(
    messages: Readonly<ContextMessages>,
    ctx: ExtensionContext,
  ): MaybePromise<boolean>;
  /** Repair the current request. The consumer owns any durable persistence. */
  restore(
    messages: Readonly<ContextMessages>,
    ctx: ExtensionContext,
  ): MaybePromise<ContextMessages>;
}

/**
 * Enforce a context invariant after all ordinary `context` handlers have run.
 * An unchanged context is returned untouched; repairs are awaited before dispatch.
 *
 * Like other Pi handlers, `context_with_system` handlers run in load order. Load
 * consumers after extensions that also rewrite context in that later phase.
 */
export function ensureContext(
  pi: ExtensionAPI,
  invariant: ContextInvariant,
): () => void {
  return pi.on("context_with_system", async (event, ctx) => {
    if (await invariant.present(event.messages, ctx)) return;

    const leadingSystem = event.messages[0]?.role === "system";
    const messages = await invariant.restore(event.messages, ctx);
    if (leadingSystem && messages[0]?.role !== "system") {
      throw new Error(
        "Context repair must preserve the leading system message",
      );
    }
    if (!(await invariant.present(messages, ctx))) {
      throw new Error("Context repair did not satisfy its invariant");
    }
    return { messages };
  });
}

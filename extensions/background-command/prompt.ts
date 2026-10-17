import type { UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  InputSource,
  MessageEndEvent,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

/** Source belongs to input events, not persisted UserMessages. Only a current
 * unambiguous user-started run is eligible; queued/extension/custom input fails
 * closed instead of guessing which earlier message the user meant. */
export class PromptTracker {
  private inputSource: InputSource | undefined;
  private run: { message?: UserMessage } | undefined;

  input(source: InputSource, queued: boolean): void {
    this.run = undefined;
    this.inputSource = queued ? undefined : source;
  }

  begin(messageType: "user" | "custom"): void {
    this.run =
      messageType === "user" &&
      (this.inputSource === "interactive" || this.inputSource === "rpc")
        ? {}
        : undefined;
    this.inputSource = undefined;
  }

  message(message: MessageEndEvent["message"]): void {
    if (message.role !== "user" || !this.run) return;
    if (this.run.message) this.run = undefined;
    else this.run.message = structuredClone(message);
  }

  reset(): void {
    this.inputSource = undefined;
    this.run = undefined;
  }

  current(
    manager: ExtensionContext["sessionManager"],
  ): SessionMessageEntry | undefined {
    const message = this.run?.message;
    if (!message) return undefined;
    const entry = [...manager.getBranch()]
      .reverse()
      .find((item) => item.type === "message" && item.message.role === "user");
    if (
      entry?.type !== "message" ||
      JSON.stringify(entry.message) !== JSON.stringify(message)
    )
      return undefined;
    return entry;
  }
}

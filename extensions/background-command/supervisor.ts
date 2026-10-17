import { BackgroundStore, type BackgroundTask } from "./store.js";
import { inheritedArgs } from "./launch.js";
import type { RpcChildOptions } from "./runner.js";

export interface BackgroundNotice {
  message: string;
  level: "info" | "warning" | "error";
}

/** No captured pi/context objects: these outlive session runtimes and reloads. */
export class BackgroundSupervisor {
  readonly store = new BackgroundStore();
  private listeners = new Set<(notice?: BackgroundNotice) => void>();
  private notices: BackgroundNotice[] = [];
  private operation: Promise<unknown> | undefined;
  private operationController: AbortController | undefined;
  private quitting = false;
  private shutdownPromise: Promise<void> | undefined;
  private exitHook: (() => void) | undefined;
  private readonly launchCwd = process.cwd();
  private readonly argv = process.argv.slice(2);
  private startupProvider: string | undefined;
  switchTarget: string | undefined;

  get busy(): boolean {
    return this.operation !== undefined;
  }

  get operationSignal(): AbortSignal | undefined {
    return this.operationController?.signal;
  }

  cancelOperation(): void {
    this.operationController?.abort();
  }

  noteStartupProvider(provider: string | undefined): void {
    this.startupProvider ??= provider;
  }

  launchArgs(provider?: string): string[] {
    return inheritedArgs(
      this.argv,
      this.launchCwd,
      provider,
      this.startupProvider,
    );
  }

  /** Called from the command, never the factory. The fallback also covers
   * leaving for a cwd that does not load this extension before host exit. */
  register(task: BackgroundTask): void {
    this.store.register(task);
    if (this.exitHook) return;
    this.exitHook = () => {
      for (const task of this.store.all()) {
        try {
          task.client.terminate?.();
        } catch {
          /* synchronous best effort */
        }
      }
    };
    process.once("exit", this.exitHook);
  }

  subscribe(listener: (notice?: BackgroundNotice) => void): () => void {
    this.listeners.add(listener);
    for (const notice of this.notices.splice(0)) listener(notice);
    return () => {
      this.listeners.delete(listener);
    };
  }

  changed(notice?: BackgroundNotice): void {
    if (notice && notice.message.length > 4000)
      notice = { ...notice, message: `${notice.message.slice(0, 3999)}…` };
    let delivered = false;
    for (const listener of [...this.listeners]) {
      try {
        listener(notice);
        delivered = true;
      } catch {
        this.listeners.delete(listener);
      }
    }
    if (!delivered && notice)
      this.notices = [...this.notices, notice].slice(-20);
  }

  /** Child callbacks are created here, not inside a session factory's lexical
   * environment. Keeping a child alive must not keep an old pi/ctx alive. */
  observe(id: string): {
    readonly started: boolean;
    handlers: Pick<RpcChildOptions, "onEvent" | "onExit" | "onDiagnostic">;
  } {
    let started = false;
    let providerError: string | undefined;
    return {
      get started() {
        return started;
      },
      handlers: {
        onEvent: (event) => {
          const task = this.store.get(id);
          if (!task) return;
          if (event.type === "agent_start") {
            started = true;
            task.isStreaming = true;
          } else if (event.type === "agent_settled") {
            task.isStreaming = false;
            if (task.error)
              this.changed({
                message: `Background: ${id} settled with an error: ${task.error}`,
                level: "error",
              });
          } else if (event.type === "message_end") {
            const message = event.message as
              | { role?: string; stopReason?: string; errorMessage?: string }
              | undefined;
            if (message?.role !== "assistant") return;
            if (message.stopReason === "error") {
              providerError = String(
                message.errorMessage ?? "Child provider request failed",
              ).slice(0, 16_384);
              task.error = providerError;
            } else if (message.stopReason !== "aborted") {
              // Recovery clears only that provider failure, never a separate
              // transport/extension error reported while stopping the child.
              if (task.error === providerError) task.error = undefined;
              providerError = undefined;
            }
          } else return;
          this.changed();
        },
        onExit: (error) => {
          const task = this.store.get(id);
          if (!task) return;
          task.killed = true;
          task.isStreaming = false;
          if (error) task.error = error.message.slice(0, 16_384);
          this.changed(
            error
              ? { message: `Background: ${id}: ${task.error}`, level: "error" }
              : undefined,
          );
        },
        onDiagnostic: (message, level) => {
          const task = this.store.get(id);
          if (task && level === "error") task.error = message.slice(0, 16_384);
          this.changed({ message: `Background: ${id}: ${message}`, level });
        },
      },
    };
  }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.quitting)
      throw new Error("Background supervisor is shutting down");
    if (this.operation)
      throw new Error("Another /background operation is in progress");
    // Set the guard before running user code; UI callbacks may re-enter.
    this.operationController = new AbortController();
    const pending = Promise.resolve().then(operation);
    this.operation = pending;
    try {
      return await pending;
    } finally {
      this.operation = undefined;
      this.operationController = undefined;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.quitting = true;
    this.cancelOperation();
    this.shutdownPromise = (async () => {
      await this.operation?.catch(() => {});
      const results = await Promise.allSettled(
        this.store.all().map((task) => task.client.stop()),
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length)
        throw new Error(
          `Background cleanup failed: ${failures.map((item) => String(item.reason)).join("; ")}`,
        );
      if (this.exitHook) process.off("exit", this.exitHook);
      this.exitHook = undefined;
    })();
    return this.shutdownPromise;
  }
}

// Jiti can reload the module as well as the factory. A versioned global symbol
// keeps the supervisor stable across both, without starting factory resources.
const KEY = Symbol.for("dpchamps.background-command.supervisor.v2");
export function sharedSupervisor(): BackgroundSupervisor {
  const shared = globalThis as typeof globalThis & {
    [KEY]?: BackgroundSupervisor;
  };
  return (shared[KEY] ??= new BackgroundSupervisor());
}

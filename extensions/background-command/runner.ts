/** Supervised RPC transport. Unlike RpcClient, this also owns exit confirmation,
 * bounded diagnostics, launch snapshots and the raw extension-UI protocol. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  type ExtensionContext,
  type RpcSessionState,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { hostInvocation, type Invocation } from "./launch.js";

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface RpcChildOptions {
  cwd: string;
  sessionFile: string;
  invocation?: Invocation;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  snapshot?: { systemPrompt: string; tools: string[] };
  expectedModel?: { provider: string; id: string };
  requestTimeoutMs?: number;
  onEvent?: (event: RpcEvent) => void;
  onExit?: (error?: Error) => void;
  onDiagnostic?: (message: string, level: "info" | "warning" | "error") => void;
}

export interface BackgroundClient {
  start(): Promise<void>;
  prompt(
    message: string,
    images?: ImageContent[],
  ): Promise<"started" | "queued" | "handled">;
  stop(graceMs?: number): Promise<void>;
  isAlive(): boolean;
  /** Synchronous last-resort signal when the host is already exiting. */
  terminate?(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const STDERR_LIMIT = 16 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export class RpcChild implements BackgroundClient {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private buffer = "";
  private stderr = "";
  private ended = false;
  private closed = false;
  private stopping = false;
  private failure: Error | undefined;
  private startupError: Error | undefined;
  private ready = false;
  private exitPromise: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | undefined;
  private controlDir: string | undefined;

  constructor(private readonly options: RpcChildOptions) {}

  async start(): Promise<void> {
    if (this.proc || this.stopping)
      throw new Error("RPC child already started or stopped");
    try {
      const invocation = this.options.invocation ?? hostInvocation();
      const args = [...invocation.args, ...(this.options.args ?? [])];
      if (this.options.snapshot) {
        this.controlDir = await fs.mkdtemp(
          path.join(tmpdir(), "pi-background-"),
        );
        const bootstrap = path.join(this.controlDir, "snapshot.mjs");
        // This extension is deliberately last. Missing dynamic tools fail closed
        // instead of silently falling back to the child's broader default set.
        await fs.writeFile(
          bootstrap,
          `export default function(pi) {
  const snapshot = ${JSON.stringify(this.options.snapshot)};
  pi.on("before_agent_start", (_event, ctx) => {
    const available = new Set(pi.getAllTools().map(t => t.name));
    const missing = snapshot.tools.filter(name => !available.has(name));
    if (missing.length) {
      pi.setActiveTools([]);
      ctx.abort();
      throw new Error("Background tools unavailable: " + missing.join(", "));
    }
    pi.setActiveTools(snapshot.tools);
    return { systemPrompt: snapshot.systemPrompt };
  });
}\n`,
          { mode: 0o600 },
        );
        args.push("--extension", bootstrap);
      }
      args.push("--mode", "rpc", "--session", this.options.sessionFile);
      const proc = spawn(invocation.command, args, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.options.env, PI_BACKGROUND_CHILD: "1" },
      });
      this.proc = proc;
      this.exitPromise = new Promise((resolve) => {
        proc.once("close", () => {
          this.closed = true;
          resolve();
        });
      });
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => this.readStdout(chunk));
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
      });
      const fail = (error: Error) => {
        this.failure = error;
        this.rejectPending(error);
        if (this.ready && !this.stopping) {
          this.callback(() =>
            this.options.onDiagnostic?.(
              `RPC transport error: ${error.message}`,
              "error",
            ),
          );
          void this.stop().catch((stopError) =>
            this.callback(() =>
              this.options.onDiagnostic?.(
                `RPC cleanup failed: ${String(stopError)}`,
                "error",
              ),
            ),
          );
        }
      };
      proc.once("error", (error) => fail(error));
      proc.stdin.on("error", fail);
      proc.stdout.on("error", fail);
      proc.stderr.on("error", fail);
      proc.once("exit", (code, signal) => {
        this.ended = true;
        const error = this.diagnostic(
          `RPC child exited (code=${code}, signal=${signal})`,
        );
        this.failure ??= error;
        this.rejectPending(error);
        this.callback(() =>
          this.options.onExit?.(this.stopping ? undefined : error),
        );
      });
      // Spawn errors do not emit exit. close always follows an error/exit.
      proc.once("close", () => {
        if (!this.ended) {
          this.ended = true;
          this.callback(() => this.options.onExit?.(this.failure));
        }
      });
      const state = await this.request<RpcSessionState>({ type: "get_state" });
      if (this.startupError) throw this.startupError;
      if (
        !state.sessionFile ||
        path.resolve(state.sessionFile) !==
          path.resolve(this.options.sessionFile)
      ) {
        throw new Error("RPC child opened an unexpected session");
      }
      if (
        this.options.expectedModel &&
        (state.model?.provider !== this.options.expectedModel.provider ||
          state.model?.id !== this.options.expectedModel.id)
      ) {
        throw new Error("RPC child could not restore the foreground model");
      }
      this.ready = true;
    } catch (error) {
      // Never let a failed handshake leave an untracked child behind.
      try {
        await this.stop();
      } catch (stopError) {
        throw new Error(
          `${String(error)}; cleanup failed: ${String(stopError)}`,
        );
      }
      throw this.diagnostic(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async prompt(
    message: string,
    images?: ImageContent[],
  ): Promise<"started" | "queued" | "handled"> {
    const data = await this.request<{
      disposition: "started" | "queued" | "handled";
    }>({
      type: "prompt",
      message,
      images,
    });
    if (!["started", "queued", "handled"].includes(data?.disposition)) {
      throw new Error("Invalid RPC prompt disposition");
    }
    return data.disposition;
  }

  isAlive(): boolean {
    return !!this.proc?.pid && !this.ended;
  }

  terminate(): void {
    if (this.isAlive()) this.proc?.kill("SIGTERM");
  }

  /** Drain queues/abort first so tool results reach disk, then request orderly
   * disposal through EOF. Escalation still awaits confirmed process closure. */
  async stop(graceMs = 1500): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.stopProcess(graceMs).catch((error) => {
      this.stopPromise = undefined; // allow another cleanup attempt
      throw error;
    });
    return this.stopPromise;
  }

  private async stopProcess(graceMs: number): Promise<void> {
    const proc = this.proc;
    if (proc && !this.closed) {
      if (this.ready && this.isAlive() && !this.failure) {
        try {
          await this.request({ type: "clear_queue" }, graceMs, true);
          await this.request({ type: "abort" }, graceMs, true);
        } catch {
          /* cancellation is bounded; EOF/signals remain the fallback */
        }
      }
      proc.stdin.end();
      if (!(await this.waitForExit(graceMs))) {
        proc.kill("SIGTERM");
        if (!(await this.waitForExit(graceMs))) {
          proc.kill("SIGKILL");
          if (!(await this.waitForExit(5000))) {
            throw this.diagnostic("Could not confirm RPC child termination");
          }
        }
      }
    }
    this.rejectPending(new Error("RPC child stopped"));
    if (this.controlDir) {
      await fs.rm(this.controlDir, { recursive: true, force: true });
      this.controlDir = undefined;
    }
  }

  private async waitForExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exitPromise.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private diagnostic(message: string): Error {
    return new Error(
      this.stderr && !message.includes("\nChild stderr:\n")
        ? `${message}\nChild stderr:\n${this.stderr}`
        : message,
    );
  }

  private callback(fn: () => void): void {
    // A UI subscriber must never throw out of a Node stream callback.
    try {
      fn();
    } catch {
      /* session replacement may have invalidated a subscriber */
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private request<T>(
    command: RpcEvent,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
    duringStop = false,
  ): Promise<T> {
    if (
      !this.proc ||
      this.ended ||
      (this.stopping && !duringStop) ||
      this.failure
    ) {
      return Promise.reject(
        this.failure ?? new Error("RPC child is not running"),
      );
    }
    const id = String(++this.nextId);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.diagnostic(`Timeout waiting for RPC ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ ...command, id }, (error) => {
        const pending = this.pending.get(id);
        if (error && pending) {
          this.pending.delete(id);
          clearTimeout(timer);
          pending.reject(this.diagnostic(error.message));
        }
      });
    });
  }

  private write(
    record: RpcEvent,
    callback?: (error?: Error | null) => void,
  ): void {
    try {
      // Node buffers until the write callback; callers await the corresponding
      // response before sending more commands (no unbounded fire-and-forget queue).
      this.proc!.stdin.write(`${JSON.stringify(record)}\n`, callback);
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private readStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
        this.protocolFailure("RPC record exceeds 64 MiB");
        return;
      }
      this.handleLine(line);
    }
    if (Buffer.byteLength(this.buffer) > MAX_RECORD_BYTES)
      this.protocolFailure("Unterminated RPC record exceeds 64 MiB");
  }

  private protocolFailure(message: string): void {
    this.failure = new Error(message);
    this.buffer = "";
    this.rejectPending(this.failure);
    this.callback(() => this.options.onDiagnostic?.(message, "error"));
    void this.stop().catch((error) =>
      this.callback(() =>
        this.options.onDiagnostic?.(
          `RPC cleanup failed: ${String(error)}`,
          "error",
        ),
      ),
    );
  }

  private handleLine(line: string): void {
    let event: RpcEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event.type !== "string") return;
    if (event.type === "response") {
      const id = typeof event.id === "string" ? event.id : "";
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (event.success === false)
        pending.reject(
          this.diagnostic(String(event.error ?? "RPC request failed")),
        );
      else pending.resolve(event.data);
      return;
    }
    if (event.type === "extension_error") {
      const message = `Child extension error: ${String(event.error)}`;
      if (!this.ready) this.startupError = new Error(message);
      this.callback(() => this.options.onDiagnostic?.(message, "error"));
    }
    if (event.type === "extension_ui_request") {
      const method = String(event.method);
      if (DIALOGS.has(method)) {
        this.write({
          type: "extension_ui_response",
          id: event.id,
          cancelled: true,
        });
        this.callback(() =>
          this.options.onDiagnostic?.(
            `Cancelled background ${method} dialog: ${String(event.title ?? "user interaction required")}. Resume the task to interact.`,
            "warning",
          ),
        );
      } else if (method === "notify") {
        const level =
          event.notifyType === "error" || event.notifyType === "warning"
            ? event.notifyType
            : "info";
        this.callback(() =>
          this.options.onDiagnostic?.(String(event.message ?? ""), level),
        );
      }
    }
    this.callback(() => this.options.onEvent?.(event));
  }
}

/** Write only the active path preceding the request. No leaf mutation or source
 * file flushing is needed; this new JSONL has exactly one unambiguous leaf. */
export async function forkReplaySession(
  manager: ExtensionContext["sessionManager"],
  request: SessionMessageEntry,
  cwd: string,
): Promise<string> {
  const branch = manager.getBranch();
  const index = branch.findIndex((entry) => entry.id === request.id);
  const header = manager.getHeader();
  if (index < 0 || !header)
    throw new Error("Request is no longer on the active branch");
  const timestamp = new Date().toISOString();
  const id = randomUUID();
  const sessionFile = path.join(
    manager.getSessionDir(),
    `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`,
  );
  const snapshot = [
    {
      ...header,
      version: CURRENT_SESSION_VERSION,
      id,
      timestamp,
      cwd,
      parentSession: manager.getSessionFile(),
    },
    ...branch.slice(0, index),
  ];
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${snapshot.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return sessionFile;
}

export function promptContent(entry: SessionMessageEntry): {
  text: string;
  images: ImageContent[];
} {
  if (entry.message.role !== "user")
    throw new Error("Only user messages can be replayed");
  const content = entry.message.content;
  if (typeof content === "string") return { text: content, images: [] };
  return {
    text: content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    images: content.filter(
      (part): part is ImageContent => part.type === "image",
    ),
  };
}

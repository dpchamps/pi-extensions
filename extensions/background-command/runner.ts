/**
 * RpcChild — minimal client for talking to a pi --mode rpc child process.
 *
 * Why we don't use pi-coding-agent's RpcClient: it isn't in the package's
 * "exports" map, so it can't be imported via the public surface. The protocol
 * is small enough that we re-implement just the pieces we need (prompt, abort,
 * get_state, switch_session) and stream events on stdout.
 *
 * Framing: LF-only JSONL on stdin (commands) and stdout (events + responses).
 * stderr is captured for diagnostics.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ChildProcess, spawn } from "node:child_process";
import type {
  ExtensionCommandContext,
  SessionEntry,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";

export interface RpcChildOptions {
  cwd: string;
  /** Forked session file the child should open. */
  sessionFile: string;
  /** Path to the pi binary. Defaults to "pi" (PATH lookup). */
  piBin?: string;
  /** Optional event callback. Fires on every JSON line that isn't a response. */
  onEvent?: (event: { type: string; [k: string]: unknown }) => void;
  /** Optional stderr sink for diagnostics. */
  onStderr?: (chunk: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class RpcChild {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private buffer = "";
  private exited = false;
  private exitCode: number | null = null;

  constructor(private readonly options: RpcChildOptions) {}

  start(): Promise<void> {
    if (this.proc) throw new Error("RpcChild already started");
    const piBin = this.options.piBin ?? "pi";
    const args = ["--mode", "rpc", "--session", this.options.sessionFile];
    this.proc = spawn(piBin, args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stderr?.on("data", (chunk: string) => {
      this.options.onStderr?.(chunk);
    });
    this.proc.on("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
      // Reject any in-flight requests so callers don't hang.
      for (const [, p] of this.pending) {
        p.reject(new Error(`pi rpc child exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Resolve once the process is spawned. We don't wait for a handshake —
    // commands queue against stdin and the child processes them in order.
    return Promise.resolve();
  }

  /** Send a "prompt" command. Fire-and-forget; events stream via onEvent. */
  prompt(message: string): void {
    this.send({ type: "prompt", message });
  }

  abort(): void {
    if (this.exited) return;
    this.send({ type: "abort" });
  }

  /** Best-effort graceful shutdown: SIGTERM, then SIGKILL after a grace period. */
  async stop(graceMs = 1500): Promise<void> {
    if (!this.proc || this.exited) return;
    this.proc.kill("SIGTERM");
    const killed = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), graceMs);
      this.proc?.once("exit", () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    if (!killed && this.proc && !this.exited) this.proc.kill("SIGKILL");
  }

  isAlive(): boolean {
    return !this.exited;
  }

  private send(command: { type: string; [k: string]: unknown }): void {
    if (!this.proc || this.exited) return;
    const id = String(this.nextRequestId++);
    const payload = JSON.stringify({ ...command, id });
    this.proc.stdin?.write(`${payload}\n`);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: { type?: string; [k: string]: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      // Ignore malformed lines — pi rpc is supposed to emit pure JSONL but
      // errors during early startup may leak through.
      return;
    }
    if (!parsed || typeof parsed.type !== "string") return;

    if (parsed.type === "response") {
      const id = parsed.id as string | undefined;
      if (id) {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          if (parsed.success === false) {
            p.reject(new Error(String(parsed.error ?? "rpc error")));
          } else {
            p.resolve(parsed.data);
          }
        }
      }
      return;
    }

    this.options.onEvent?.(parsed as { type: string });
  }
}

/**
 * Pi delays writing the session file to disk until the first assistant
 * message. forkFrom and parentSession lookups read from disk, so this helper
 * materializes the in-memory session to its on-disk path when missing.
 * Lifted verbatim (with comments preserved) from worktree-command/index.ts.
 *
 * Returns undefined on success or an error message on failure.
 */
export async function flushSessionToDisk(
  ctx: ExtensionCommandContext,
  sessionFile: string,
): Promise<string | undefined> {
  if (fs.existsSync(sessionFile)) return undefined;
  const header = ctx.sessionManager.getHeader();
  if (!header) return "current session has no header to flush";
  const entries = ctx.sessionManager.getEntries();
  const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n");
  try {
    await fs.promises.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.promises.writeFile(sessionFile, `${lines}\n`);
  } catch (e) {
    return `failed to flush source session: ${(e as Error).message}`;
  }
  return undefined;
}

/**
 * Find the most recent interactive (non-extension-sourced) user message in the
 * session entries. Returns the entry plus its extracted text, or null if none.
 *
 * Filters out programmatic prompts (e.g. ralph's auto-issued user messages)
 * by skipping entries whose AgentMessage has source !== "interactive". When
 * source is missing on older entries, we treat them as user-authored.
 */
export function findLastInteractiveUserMessage(
  entries: SessionEntry[],
): { entry: SessionMessageEntry; text: string } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "message") continue;
    const msg = e.message as { role?: string; source?: string; content?: unknown };
    if (msg.role !== "user") continue;
    if (msg.source !== undefined && msg.source !== "interactive") continue;
    const text = extractText(msg.content);
    if (!text) continue;
    return { entry: e as SessionMessageEntry, text };
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === "string") parts.push(c);
      else if (c && typeof c === "object" && "type" in c && (c as { type: unknown }).type === "text" && "text" in c) {
        parts.push(String((c as { text: unknown }).text));
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

import * as fs from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isTerminal,
  MAX_FRAME_BYTES,
  parseRequest,
  ProtocolError,
  reply,
  RETENTION_MS,
  type RequestRecord,
} from "./protocol.js";
import type { RequestStore } from "./store.js";

export interface ListenerOptions {
  store: RequestStore;
  sessionId: string;
  cwd: string;
  skillDirectory: string;
  tempDirectory?: string;
  frameTimeoutMs?: number;
  onSubmitted(): void;
  onError(error: unknown): void;
}

/** Keep sockaddr_un paths below the macOS limit as well as Linux's limit. */
export function listenerTempRoot(preferred: string): string {
  const absolute = resolve(preferred);
  return Buffer.byteLength(join(absolute, "pi-listen-XXXXXX", "inbox.sock")) <=
    100
    ? absolute
    : "/tmp";
}

export class UnixListener {
  readonly directory: string;
  readonly socketPath: string;
  private server: Server;
  private sockets = new Set<Socket>();
  private waiters = new Map<string, Set<Socket>>();
  private closing?: Promise<void>;
  private stopped = false;

  private constructor(private readonly options: ListenerOptions) {
    if (process.platform === "win32")
      throw new Error("/listen requires Unix-domain sockets");
    this.directory = fs.mkdtempSync(
      join(listenerTempRoot(options.tempDirectory ?? tmpdir()), "pi-listen-"),
    );
    this.socketPath = join(this.directory, "inbox.sock");
    this.server = createServer({ allowHalfOpen: true }, (socket) =>
      this.connect(socket),
    );
  }

  static async start(options: ListenerOptions): Promise<UnixListener> {
    const listener = new UnixListener(options);
    try {
      fs.chmodSync(listener.directory, 0o700);
      const skill = join(listener.directory, "pi-listen");
      fs.cpSync(options.skillDirectory, skill, {
        recursive: true,
        dereference: false,
      });
      fs.writeFileSync(
        join(listener.directory, "listener.json"),
        `${JSON.stringify(
          {
            protocol: "pi-listen",
            version: 1,
            pid: process.pid,
            sessionId: options.sessionId,
            cwd: options.cwd,
            socket: listener.socketPath,
            skill: "pi-listen/SKILL.md",
            retentionSeconds: RETENTION_MS / 1000,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      await new Promise<void>((resolve, reject) => {
        listener.server.once("error", reject);
        listener.server.listen(listener.socketPath, () => {
          listener.server.off("error", reject);
          resolve();
        });
      });
      fs.chmodSync(listener.socketPath, 0o600);
      listener.server.on("error", options.onError);
      return listener;
    } catch (error) {
      await listener.close();
      throw error;
    }
  }

  private send(socket: Socket, value: unknown, end = false): void {
    if (socket.destroyed || socket.writableEnded) return;
    const line = `${JSON.stringify(value)}\n`;
    if (end) {
      socket.end(line);
      socket.destroySoon();
    } else socket.write(line);
  }

  private error(socket: Socket, error: unknown): void {
    const protocol = error instanceof ProtocolError;
    this.send(
      socket,
      {
        type: "error",
        code: protocol ? error.code : "storage_error",
        error: protocol
          ? error.message
          : "The listener could not safely access its request ledger",
      },
      true,
    );
    if (!protocol) this.options.onError(error);
  }

  private connect(socket: Socket): void {
    socket.on("error", () => {
      /* A disconnected client never cancels its request. */
    });
    if (this.stopped || this.sockets.size >= 128) {
      this.send(
        socket,
        {
          type: "error",
          code: "unavailable",
          error: "Listener stopped or connection limit reached",
        },
        true,
      );
      return;
    }
    this.sockets.add(socket);
    let pendingId: string | undefined;
    let buffer = Buffer.alloc(0);
    let received = false;
    const timer = setTimeout(() => {
      this.send(
        socket,
        {
          type: "error",
          code: "frame_timeout",
          error: "Send one JSON object terminated by LF",
        },
        true,
      );
      socket.destroySoon();
    }, this.options.frameTimeoutMs ?? 5000);
    timer.unref();
    socket.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
      if (pendingId) {
        const waiting = this.waiters.get(pendingId);
        waiting?.delete(socket);
        if (!waiting?.size) this.waiters.delete(pendingId);
      }
    });
    socket.on("end", () => {
      if (!received)
        this.error(
          socket,
          new ProtocolError("invalid_frame", "Request must end with LF"),
        );
      // allowHalfOpen keeps the reply channel available to clients such as nc.
    });
    socket.on("data", (chunk: Buffer) => {
      if (this.stopped || socket.writableEnded) return;
      if (received) {
        this.error(
          socket,
          new ProtocolError(
            "invalid_frame",
            "Only one request per connection is allowed",
          ),
        );
        socket.destroySoon();
        return;
      }
      if (buffer.length + chunk.length > MAX_FRAME_BYTES) {
        received = true;
        clearTimeout(timer);
        this.error(
          socket,
          new ProtocolError(
            "frame_too_large",
            `Request exceeds ${MAX_FRAME_BYTES} bytes`,
          ),
        );
        socket.destroySoon();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      received = true;
      clearTimeout(timer);
      try {
        if (
          buffer
            .subarray(newline + 1)
            .some(
              (byte) => byte !== 10 && byte !== 13 && byte !== 32 && byte !== 9,
            )
        )
          throw new ProtocolError(
            "invalid_frame",
            "Only one request per connection is allowed",
          );
        let value: unknown;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, newline),
          );
          value = JSON.parse(text);
        } catch {
          throw new ProtocolError(
            "invalid_json",
            "Request must be valid UTF-8 JSON",
          );
        }
        buffer = Buffer.alloc(0);
        const request = parseRequest(value);
        let record: RequestRecord;
        let created = false;
        if (request.op === "submit") {
          ({ record, created } = this.options.store.submit(
            request.id,
            request.message,
          ));
        } else record = this.options.store.get(request.id);
        if (isTerminal(record.status)) {
          this.send(socket, reply(record, "response"), true);
        } else if (!request.wait) {
          this.send(
            socket,
            reply(record, request.op === "submit" ? "received" : "status"),
            true,
          );
        } else {
          pendingId = record.id;
          const waiting = this.waiters.get(record.id) ?? new Set<Socket>();
          waiting.add(socket);
          this.waiters.set(record.id, waiting);
          this.send(
            socket,
            reply(record, request.op === "submit" ? "received" : "status"),
          );
        }
        // Acknowledgment follows durable storage and waiter registration. Dispatch
        // is scheduled by the coordinator, never awaited in a socket callback.
        if (created) this.options.onSubmitted();
      } catch (error) {
        this.error(socket, error);
      }
    });
  }

  publish(record: RequestRecord): void {
    if (!isTerminal(record.status)) return;
    const waiting = this.waiters.get(record.id);
    this.waiters.delete(record.id);
    for (const socket of waiting ?? [])
      this.send(socket, reply(record, "response"), true);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async () => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of this.sockets) socket.destroy();
        }, 250);
        timer.unref();
        this.server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        for (const socket of this.sockets) {
          if (!socket.writableEnded)
            this.send(
              socket,
              {
                type: "error",
                code: "listener_stopped",
                error:
                  "Listener stopped; reconnect after /listen to recover this request",
              },
              true,
            );
          socket.destroySoon();
        }
      });
      fs.rmSync(this.directory, { recursive: true, force: true });
    })();
    return this.closing;
  }
}

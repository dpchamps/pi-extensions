import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  isTerminal,
  MAX_PENDING,
  MAX_RECORDS,
  ProtocolError,
  RETENTION_MS,
  type RequestRecord,
  type RequestStatus,
} from "./protocol.js";

export function sessionStoreDirectory(root: string, identity: string): string {
  return join(root, createHash("sha256").update(identity).digest("hex"));
}

/** Small, bounded, session-scoped ledger. No request is replayed after reopening. */
export class RequestStore {
  private records = new Map<string, RequestRecord>();
  private lock?: string;
  private closed = false;

  constructor(
    readonly directory: string,
    private readonly now = () => Date.now(),
  ) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(directory);
    if (
      !info.isDirectory() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(`Unsafe listen ledger directory: ${directory}`);
    fs.chmodSync(directory, 0o700);
    this.acquire();
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const path = join(directory, name);
        if (!fs.lstatSync(path).isFile())
          throw new Error(`Invalid listen record: ${path}`);
        const record = JSON.parse(
          fs.readFileSync(path, "utf8"),
        ) as RequestRecord;
        if (
          record.version !== 1 ||
          typeof record.id !== "string" ||
          this.filename(record.id) !== path ||
          typeof record.input !== "string" ||
          typeof record.token !== "string" ||
          !["queued", "running", "completed", "failed", "interrupted"].includes(
            record.status,
          ) ||
          !Number.isFinite(Date.parse(record.createdAt)) ||
          !Number.isFinite(Date.parse(record.updatedAt))
        )
          throw new Error(`Invalid listen record: ${path}`);
        this.records.set(record.id, record);
      }
      this.prune();
      this.interruptPending(
        "Listener restarted; previous work may have executed. It will not be replayed automatically.",
      );
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private filename(id: string): string {
    return join(
      this.directory,
      `${createHash("sha256").update(id).digest("hex")}.json`,
    );
  }

  private acquire(): void {
    const path = join(this.directory, "lock");
    const value = JSON.stringify({ pid: process.pid, token: randomUUID() });
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd: number;
      try {
        fd = fs.openSync(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = fs.readFileSync(path, "utf8");
        let owner: { pid?: number };
        try {
          owner = JSON.parse(previous);
        } catch {
          throw new Error(`Cannot verify listen ledger lock; inspect ${path}`);
        }
        if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0)
          throw new Error(`Cannot verify listen ledger lock; inspect ${path}`);
        try {
          process.kill(owner.pid!, 0);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
            // Serialize stale-lock reclamation: otherwise two contenders could
            // both observe the dead owner and one could unlink the other's new
            // lock between a compare and unlink. A crashed recovery guard is
            // deliberately fail-closed and must be inspected manually.
            const recovery = join(this.directory, ".recovering");
            try {
              fs.mkdirSync(recovery, { mode: 0o700 });
            } catch {
              throw new Error(
                `Listen lock recovery is already in progress; inspect ${recovery} if it persists`,
              );
            }
            try {
              try {
                if (fs.readFileSync(path, "utf8") === previous)
                  fs.unlinkSync(path);
              } catch (changed) {
                if ((changed as NodeJS.ErrnoException).code !== "ENOENT")
                  throw changed;
              }
            } finally {
              fs.rmdirSync(recovery);
            }
            continue;
          }
        }
        throw new Error(
          `This session already has a listen ledger owner (PID ${owner.pid})`,
        );
      }
      try {
        fs.writeFileSync(fd, value);
        fs.fsyncSync(fd);
        this.lock = value;
      } finally {
        fs.closeSync(fd);
      }
      return;
    }
    throw new Error("Could not acquire listen ledger lock");
  }

  private assertOwner(): void {
    if (
      this.closed ||
      !this.lock ||
      fs.readFileSync(join(this.directory, "lock"), "utf8") !== this.lock
    )
      throw new Error("Listen ledger ownership was lost");
  }

  private save(record: RequestRecord): void {
    this.assertOwner();
    const target = this.filename(record.id);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, target);
      // Persist the rename too where supported. Some Unix filesystems do not
      // implement directory fsync; the file itself was synced unconditionally.
      const directoryFd = fs.openSync(this.directory, "r");
      try {
        try {
          fs.fsyncSync(directoryFd);
        } catch (error) {
          if (
            !["EINVAL", "ENOTSUP"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
        }
      } finally {
        fs.closeSync(directoryFd);
      }
      this.records.set(record.id, record);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private prune(): void {
    this.assertOwner();
    for (const [id, record] of this.records) {
      if (
        isTerminal(record.status) &&
        this.now() - Date.parse(record.updatedAt) >= RETENTION_MS
      ) {
        fs.unlinkSync(this.filename(id));
        this.records.delete(id);
      }
    }
  }

  submit(
    id: string,
    input: string,
  ): { record: RequestRecord; created: boolean } {
    this.prune();
    const existing = this.records.get(id);
    if (existing) {
      if (existing.input !== input)
        throw new ProtocolError(
          "id_conflict",
          "This id already belongs to a different message",
        );
      return { record: existing, created: false };
    }
    if (this.records.size >= MAX_RECORDS)
      throw new ProtocolError(
        "store_full",
        `This session retains at most ${MAX_RECORDS} requests; retry after records expire`,
      );
    if (
      [...this.records.values()].filter((record) => !isTerminal(record.status))
        .length >= MAX_PENDING
    )
      throw new ProtocolError(
        "queue_full",
        `At most ${MAX_PENDING} requests may be pending`,
      );
    const timestamp = new Date(this.now()).toISOString();
    const record: RequestRecord = {
      version: 1,
      id,
      input,
      token: randomUUID(),
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.save(record);
    return { record, created: true };
  }

  get(id: string): RequestRecord {
    this.prune();
    const record = this.records.get(id);
    if (!record)
      throw new ProtocolError(
        "not_found",
        "Unknown or expired request id in this session",
      );
    return record;
  }

  next(): RequestRecord | undefined {
    this.assertOwner();
    return [...this.records.values()].find(
      (record) => record.status === "queued",
    );
  }

  update(
    id: string,
    status: RequestStatus,
    result: { message?: string; error?: string; truncated?: boolean } = {},
  ): RequestRecord {
    const record = this.get(id);
    if (isTerminal(record.status)) return record;
    const updated: RequestRecord = {
      ...record,
      ...result,
      status,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.save(updated);
    return updated;
  }

  interruptPending(reason: string): RequestRecord[] {
    const interrupted: RequestRecord[] = [];
    for (const record of this.records.values()) {
      if (!isTerminal(record.status))
        interrupted.push(
          this.update(record.id, "interrupted", { error: reason }),
        );
    }
    return interrupted;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lock) {
      const path = join(this.directory, "lock");
      try {
        if (fs.readFileSync(path, "utf8") === this.lock) fs.unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        this.lock = undefined;
      }
    }
  }
}

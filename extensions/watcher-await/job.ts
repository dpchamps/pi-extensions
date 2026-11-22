import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const OUTPUT_BYTES = 4096;
const TERM_GRACE_MS = 750;
const PIPE_GRACE_MS = 250;

type StopReason = "cancelled" | "timed out";

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface JobResult extends Exit {
  reason?: StopReason;
  error?: string;
  cleanupError?: string;
  output: string;
  truncated: boolean;
}

export function cleanOutput(text: string): string {
  return stripVTControlCharacters(text)
    .replace(
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ufff9-\ufffb]/g,
      "",
    )
    .replace(/\r\n?/g, "\n");
}

/** A Unix process group, not a detached service. Node reaps the direct child. */
export function launchJob(command: string, cwd: string, timeoutMs: number) {
  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let truncated = false;
  let exited = false;
  let error: string | undefined;
  let cleanupError: string | undefined;
  let reason: StopReason | undefined;
  let groupSignalled = false;
  let escalation: NodeJS.Timeout | undefined;
  let drain: NodeJS.Timeout | undefined;

  function signalGroup(signal: "SIGTERM" | "SIGKILL") {
    if (!child.pid || groupSignalled) return;
    try {
      process.kill(-child.pid, signal);
      groupSignalled = signal === "SIGKILL";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        groupSignalled = true; // No remaining group members.
      } else if (signal === "SIGKILL") {
        cleanupError = String(err);
      }
    }
  }

  function cancel(why: StopReason = "cancelled") {
    if (exited || reason || error) return false;
    reason = why;
    clearTimeout(deadline);
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), TERM_GRACE_MS);
    return true;
  }

  const deadline = setTimeout(() => cancel("timed out"), timeoutMs);
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.on("error", (err) => {
      error = err.message;
      reject(err);
    });
  });

  function append(chunk: Buffer) {
    truncated ||= tail.length + chunk.length > OUTPUT_BYTES;
    tail =
      chunk.length >= OUTPUT_BYTES
        ? Buffer.from(chunk.subarray(-OUTPUT_BYTES))
        : Buffer.concat([
            tail.subarray(
              Math.max(0, tail.length + chunk.length - OUTPUT_BYTES),
            ),
            chunk,
          ]);
  }

  const output = () => cleanOutput(tail.toString("utf8")).trimEnd();
  for (const pipe of [child.stdout, child.stderr]) {
    pipe.on("data", append);
    pipe.on("error", () => {
      truncated = true;
    });
  }
  child.once("exit", () => {
    exited = true;
    clearTimeout(deadline);
    clearTimeout(escalation);
    // Even a successful shell can leave a running `cmd &` behind. Clean up
    // immediately on exit, before waiting for descendants to close the pipes.
    signalGroup("SIGKILL");
    drain = setTimeout(() => {
      // A process that left the group may still hold the pipes. Do not hang on it.
      truncated = true;
      child.stdout.destroy();
      child.stderr.destroy();
    }, PIPE_GRACE_MS);
  });

  const done = new Promise<JobResult>((resolve) => {
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(drain);
      resolve({
        code,
        signal,
        reason,
        error,
        cleanupError,
        output: output(),
        truncated,
      });
    });
  });
  return {
    started,
    done,
    cancel,
    output,
    state: () =>
      exited || error ? "finishing" : reason ? "stopping" : "running",
    kill: () => signalGroup("SIGKILL"),
  };
}

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchJob } from "./job.js";

let cwd: string;
let jobs: ReturnType<typeof launchJob>[];
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "watcher-job-"));
  jobs = [];
});
afterEach(async () => {
  for (const job of jobs) job.kill();
  await Promise.all(jobs.map((job) => job.done));
  await rm(cwd, { recursive: true, force: true });
});
function launch(command: string, timeoutMs = 5000, dir = cwd) {
  const job = launchJob(command, dir, timeoutMs);
  jobs.push(job);
  return job;
}

describe.skipIf(process.platform === "win32")("watcher subprocesses", () => {
  it("drains stdout and stderr, limits the tail, and reports a nonzero exit", async () => {
    const job = launch(
      "printf '%6000s' x >&2; printf '\\033[31mend\\033[0m\\n' >&2; exit 7",
    );
    await job.started;
    const result = await job.done;
    expect(result).toMatchObject({ code: 7, signal: null, truncated: true });
    expect(result.output.length).toBeLessThanOrEqual(4096);
    expect(result.output).toContain("end");
    expect(result.output).not.toContain("\u001b");
  });

  it("reports startup failures without waiting for the job deadline", async () => {
    const job = launch("true", 5000, join(cwd, "missing"));
    await expect(job.started).rejects.toThrow("ENOENT");
    expect((await job.done).error).toContain("ENOENT");
  });

  it("escalates when the group leader ignores TERM and reaps the direct child", async () => {
    const job = launch(
      "trap '' TERM; printf '%s' \"$$\" > pid; while :; do sleep 1; done",
    );
    await job.started;
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(join(cwd, "pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
    });
    expect(job.cancel()).toBe(true);
    expect(job.cancel()).toBe(false);
    expect(await job.done).toMatchObject({
      reason: "cancelled",
      signal: "SIGKILL",
    });
    expect(() => process.kill(pid, 0)).toThrow("ESRCH");
  });

  it("times out independently of the caller", async () => {
    const job = launch("exec sleep 60", 30);
    await job.started;
    expect(await job.done).toMatchObject({
      reason: "timed out",
      signal: "SIGTERM",
    });
  });

  it("kills leftover group members even after a successful exit", async () => {
    const job = launch(
      "(trap '' TERM; touch ready; sleep 0.5; touch leaked) & while [ ! -e ready ]; do sleep 0.01; done; printf done",
    );
    await job.started;
    expect(await job.done).toMatchObject({
      code: 0,
      output: "done",
      truncated: false,
    });
    await delay(550);
    await expect(stat(join(cwd, "leaked"))).rejects.toThrow("ENOENT");
  });

  it("does not wait indefinitely for pipes held by a descendant outside the group", async () => {
    await writeFile(
      join(cwd, "escape.cjs"),
      `
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setTimeout(() => {}, 3000)'],
        { detached: true, stdio: ['ignore', 1, 2] });
      child.unref();
      require('node:fs').writeFileSync('escaped-pid', String(child.pid));
      console.log('before exit');
    `,
    );
    const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const job = launch(`exec ${node} escape.cjs`);
    try {
      await job.started;
      expect(await job.done).toMatchObject({
        code: 0,
        output: "before exit",
        truncated: true,
      });
    } finally {
      const pid = Number(
        await readFile(join(cwd, "escaped-pid"), "utf8").catch(() => ""),
      );
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
  });
});

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  boundedText,
  MAX_PENDING,
  parseRequest,
  RETENTION_MS,
} from "./protocol.js";
import { RequestStore } from "./store.js";

let directory: string;
let stores: RequestStore[];
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "listen-store-test-"));
  stores = [];
});
afterEach(() => {
  for (const store of stores) store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
function open(now?: () => number) {
  const store = new RequestStore(directory, now);
  stores.push(store);
  return store;
}

describe("recoverable request ledger", () => {
  it("deduplicates identical submissions, rejects conflicts, and retains final replies across reopen", () => {
    const store = open();
    expect(store.submit("request-1", "work").created).toBe(true);
    expect(store.submit("request-1", "work").created).toBe(false);
    expect(() => store.submit("request-1", "different")).toThrow(
      "different message",
    );
    store.update("request-1", "running");
    store.update("request-1", "completed", { message: "Final answer" });
    store.close();
    const restored = open();
    expect(restored.get("request-1")).toMatchObject({
      status: "completed",
      message: "Final answer",
    });
    expect(restored.submit("request-1", "work").created).toBe(false);
    expect(restored.next()).toBeUndefined();
  });

  it("interrupts both queued and uncertain running work on reopen without replaying either", () => {
    const store = open();
    store.submit("queued", "not sent");
    store.submit("running", "possibly executed");
    store.update("running", "running");
    store.close();
    const restored = open();
    expect(restored.get("queued").status).toBe("interrupted");
    expect(restored.get("running").status).toBe("interrupted");
    expect(restored.next()).toBeUndefined();
  });

  it("retains results for seven days and does not expire pending work", () => {
    let now = Date.now();
    const store = open(() => now);
    store.submit("done", "work");
    store.update("done", "completed", { message: "answer" });
    store.submit("pending", "wait");
    now += RETENTION_MS - 1;
    expect(store.get("done").message).toBe("answer");
    now++;
    expect(() => store.get("done")).toThrow("expired");
    expect(store.get("pending").status).toBe("queued");
  });

  it("bounds the queue and stores files privately", () => {
    const store = open();
    for (let index = 0; index < MAX_PENDING; index++)
      store.submit(`id-${index}`, "work");
    expect(() => store.submit("overflow", "work")).toThrow("pending");
    expect(store.submit("id-0", "work").created).toBe(false);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    for (const name of fs.readdirSync(directory))
      expect(fs.statSync(join(directory, name)).mode & 0o777).toBe(0o600);
  });

  it("refuses a concurrent writer and recovers a dead process's lock", () => {
    const store = open();
    expect(() => open()).toThrow("already has a listen ledger owner");
    store.close();
    const deadPid = Number(
      execFileSync(process.execPath, ["-p", "process.pid"], {
        encoding: "utf8",
      }).trim(),
    );
    fs.writeFileSync(
      join(directory, "lock"),
      JSON.stringify({ pid: deadPid, token: "old" }),
    );
    const recovered = open();
    expect(recovered.submit("safe", "work").created).toBe(true);
  });

  it("fails closed on an abandoned stale-lock recovery guard", () => {
    const deadPid = Number(
      execFileSync(process.execPath, ["-p", "process.pid"], {
        encoding: "utf8",
      }).trim(),
    );
    fs.writeFileSync(
      join(directory, "lock"),
      JSON.stringify({ pid: deadPid, token: "old" }),
    );
    fs.mkdirSync(join(directory, ".recovering"));
    expect(() => open()).toThrow("recovery is already in progress");
    expect(
      JSON.parse(fs.readFileSync(join(directory, "lock"), "utf8")).token,
    ).toBe("old");
  });

  it("fails closed on corrupt records instead of silently rerunning their IDs", () => {
    const store = open();
    store.submit("id", "work");
    store.close();
    const path = fs
      .readdirSync(directory)
      .find((name) => name.endsWith(".json"))!;
    fs.writeFileSync(join(directory, path), "invalid JSON");
    expect(() => open()).toThrow();
    expect(fs.existsSync(join(directory, "lock"))).toBe(false);
  });
});

describe("protocol validation", () => {
  it("defaults submit to waiting and get to polling", () => {
    expect(parseRequest({ op: "submit", id: "a", message: "work" }).wait).toBe(
      true,
    );
    expect(parseRequest({ op: "get", id: "a" }).wait).toBe(false);
  });
  it.each([
    null,
    [],
    {},
    { op: "get", id: "../escape" },
    { op: "get", id: "a", wait: "true" },
    { op: "get", id: "a", version: 2 },
    { op: "submit", id: "a", message: " " },
    { op: "submit", id: "a", message: "x".repeat(65537) },
    { op: "submit", id: "a", message: "work", deliverAs: "steer" },
  ])("rejects invalid input %#", (value) =>
    expect(() => parseRequest(value)).toThrow(),
  );
  it("truncates on UTF-8 boundaries", () => {
    expect(boundedText("ab🙂c", 5)).toEqual({ text: "ab", truncated: true });
    expect(boundedText("ab🙂c", 6)).toEqual({ text: "ab🙂", truncated: true });
    expect(boundedText("ab🙂c", 7)).toEqual({
      text: "ab🙂c",
      truncated: false,
    });
  });
});

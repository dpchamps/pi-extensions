import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenerTempRoot, UnixListener } from "./listener.js";
import { MAX_FRAME_BYTES } from "./protocol.js";
import { RequestStore } from "./store.js";
import { connect, exchange } from "./test-helpers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillDirectory = join(root, "skills/pi-listen");
let directory: string;
let store: RequestStore;
let listener: UnixListener;
let submitted = vi.fn<() => void>();
let errors: unknown[];
beforeEach(async () => {
  directory = fs.mkdtempSync(join(tmpdir(), "listen-transport-test-"));
  store = new RequestStore(join(directory, "ledger"));
  errors = [];
  submitted = vi.fn();
  listener = await UnixListener.start({
    store,
    skillDirectory,
    tempDirectory: directory,
    sessionId: "test",
    cwd: directory,
    frameTimeoutMs: 100,
    onSubmitted: submitted,
    onError: (error) => errors.push(error),
  });
});
afterEach(async () => {
  await listener.close();
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

describe("Unix-socket transport", () => {
  it("creates a private temporary endpoint, metadata and an independently valid copied skill", () => {
    expect(fs.statSync(listener.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(listener.socketPath).isSocket()).toBe(true);
    expect(fs.statSync(listener.socketPath).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(
      fs.readFileSync(join(listener.directory, "listener.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      protocol: "pi-listen",
      version: 1,
      socket: listener.socketPath,
      sessionId: "test",
    });
    const copied = loadSkillsFromDir({
      dir: listener.directory,
      source: "test",
    });
    expect(copied.diagnostics).toEqual([]);
    expect(copied.skills.map((skill) => skill.name)).toEqual(["pi-listen"]);
    expect(
      fs.readFileSync(join(listener.directory, manifest.skill), "utf8"),
    ).toBe(fs.readFileSync(join(skillDirectory, "SKILL.md"), "utf8"));
    expect(
      fs.existsSync(join(listener.directory, "pi-listen/scripts/client.mjs")),
    ).toBe(true);
  });

  it("uses short socket paths even with a long TMPDIR", () => {
    expect(listenerTempRoot(`/tmp/${"x".repeat(200)}`)).toBe("/tmp");
    expect(resolve(listenerTempRoot("."))).toBe(listenerTempRoot("."));
    expect(Buffer.byteLength(listener.socketPath)).toBeLessThanOrEqual(100);
  });

  it("recovers a saved response after a client abandons its wait without rerunning", async () => {
    const request = {
      op: "submit",
      id: "handoff-1",
      message: "work",
      wait: true,
    };
    const client = connect(listener.socketPath, request);
    expect(await client.first).toMatchObject({
      type: "received",
      id: "handoff-1",
      status: "queued",
    });
    client.socket.destroy();
    await client.done;
    listener.publish(
      store.update("handoff-1", "completed", { message: "answer" }),
    );
    const recovered = await exchange(listener.socketPath, {
      op: "get",
      id: "handoff-1",
      wait: true,
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      type: "response",
      status: "completed",
      message: "answer",
    });
    expect(await exchange(listener.socketPath, request)).toEqual(recovered);
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("reattaches multiple waiters and supports half-closed write sides", async () => {
    await exchange(listener.socketPath, {
      op: "submit",
      id: "job",
      message: "work",
      wait: false,
    });
    const first = connect(
      listener.socketPath,
      { op: "get", id: "job", wait: true },
      true,
    );
    const second = connect(listener.socketPath, {
      op: "get",
      id: "job",
      wait: true,
    });
    await Promise.all([first.first, second.first]);
    listener.publish(store.update("job", "completed", { message: "done" }));
    for (const messages of await Promise.all([first.done, second.done]))
      expect(messages.at(-1)).toMatchObject({
        type: "response",
        message: "done",
      });
  });

  it("accepts fragmented UTF-8, escaped multiline text, Unicode separators and CRLF framing", async () => {
    const message = "hello🙂\nnext\u2028line\u2029end";
    const client = connect(listener.socketPath);
    await new Promise<void>((resolve) =>
      client.socket.once("connect", resolve),
    );
    const bytes = Buffer.from(
      `${JSON.stringify({ op: "submit", id: "unicode", message, wait: false })}\r\n`,
    );
    const split = bytes.indexOf(Buffer.from("🙂")) + 1;
    client.socket.write(bytes.subarray(0, split));
    client.socket.write(bytes.subarray(split));
    expect((await client.done)[0].type).toBe("received");
    expect(store.get("unicode").input).toBe(message);
  });

  it("returns structured errors for conflicts, missing IDs and invalid frames", async () => {
    await exchange(listener.socketPath, {
      op: "submit",
      id: "job",
      message: "work",
      wait: false,
    });
    expect(
      (
        await exchange(listener.socketPath, {
          op: "submit",
          id: "job",
          message: "other",
          wait: false,
        })
      )[0].code,
    ).toBe("id_conflict");
    expect(
      (await exchange(listener.socketPath, { op: "get", id: "missing" }))[0]
        .code,
    ).toBe("not_found");
    const invalid = connect(listener.socketPath);
    invalid.socket.once("connect", () => invalid.socket.end("not-json\n"));
    expect((await invalid.done)[0].code).toBe("invalid_json");
    const multiple = connect(listener.socketPath);
    multiple.socket.once("connect", () =>
      multiple.socket.end('{"op":"get","id":"job"}\n{"op":"get","id":"job"}\n'),
    );
    expect((await multiple.done)[0].code).toBe("invalid_frame");
    const noLF = connect(listener.socketPath);
    noLF.socket.once("connect", () =>
      noLF.socket.end('{"op":"get","id":"job"}'),
    );
    expect((await noLF.done)[0].code).toBe("invalid_frame");
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("bounds incoming frames and expires unfinished requests without dispatching them", async () => {
    const large = connect(listener.socketPath);
    large.socket.once("connect", () =>
      large.socket.write("x".repeat(MAX_FRAME_BYTES + 1)),
    );
    expect((await large.done)[0].code).toBe("frame_too_large");
    const slow = connect(listener.socketPath);
    expect((await slow.done)[0].code).toBe("frame_timeout");
    expect(submitted).not.toHaveBeenCalled();
  });

  it("runs the copied dependency-free Node client without a Pi installation or extension", async () => {
    const script = join(listener.directory, "pi-listen/scripts/client.mjs");
    const run = promisify(execFile);
    const receipt = await run(process.execPath, [
      script,
      listener.directory,
      "submit",
      "client",
      "work",
      "--no-wait",
    ]);
    expect(JSON.parse(receipt.stdout).status).toBe("queued");
    listener.publish(
      store.update("client", "completed", { message: "node client reply" }),
    );
    const result = await run(process.execPath, [
      script,
      listener.directory,
      "get",
      "client",
      "--wait",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "completed",
      message: "node client reply",
    });
    store.submit("bad", "work");
    store.update("bad", "interrupted", { error: "stopped" });
    await expect(
      run(process.execPath, [script, listener.directory, "get", "bad"]),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("closes idempotently and removes only the temporary endpoint, not the ledger", async () => {
    const temporary = listener.directory;
    const waiting = connect(listener.socketPath, {
      op: "submit",
      id: "job",
      message: "work",
    });
    await waiting.first;
    await Promise.all([listener.close(), listener.close()]);
    expect(fs.existsSync(temporary)).toBe(false);
    expect(fs.existsSync(store.directory)).toBe(true);
    expect((await waiting.done).at(-1)).toMatchObject({
      code: "listener_stopped",
    });
  });
});

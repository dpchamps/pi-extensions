import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcChild } from "../background-command/runner.js";
import { exchange } from "./test-helpers.js";

const extension = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
let cwd: string;
let clients: RpcChild[];
let directories: string[];
beforeEach(() => {
  cwd = fs.mkdtempSync(join(tmpdir(), "listen-cli-test-"));
  clients = [];
  directories = [];
});
afterEach(async () => {
  await Promise.all(clients.map((child) => child.stop()));
  for (const directory of directories)
    fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

async function startChild(sessionFile?: string) {
  const provider = join(cwd, "faux-provider.mjs");
  const calls = join(cwd, "calls.jsonl");
  fs.writeFileSync(
    provider,
    `
import fs from 'node:fs';
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export default function(pi) {
  const faux = fauxProvider();
  faux.setResponses([
    () => { fs.appendFileSync(${JSON.stringify(calls)}, 'completed\\n'); return fauxAssistantMessage('Real CLI reply'); },
    async () => { fs.appendFileSync(${JSON.stringify(calls)}, 'running\\n'); await new Promise(() => {}); return fauxAssistantMessage('unreachable'); }
  ]);
  pi.registerProvider(faux.provider);
}
`,
  );
  if (!sessionFile) {
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    sessionFile = manager.getSessionFile()!;
    fs.writeFileSync(sessionFile, `${JSON.stringify(manager.getHeader())}\n`);
  }
  const notifications: string[] = [];
  const child = new RpcChild({
    cwd,
    sessionFile,
    requestTimeoutMs: 5000,
    args: [
      "--offline",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--extension",
      provider,
      "--extension",
      extension,
      "--provider",
      "faux",
      "--model",
      "faux-1",
    ],
    expectedModel: { provider: "faux", id: "faux-1" },
    env: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
    onEvent: (event) => {
      if (event.type === "extension_ui_request" && event.method === "notify")
        notifications.push(String(event.message));
    },
  });
  clients.push(child);
  await child.start();
  expect(await child.prompt("/listen")).toBe("handled");
  const directory = notifications.at(-1)!.split("\n")[0];
  expect(resolve(directory)).toBe(directory);
  expect(fs.statSync(join(directory, "inbox.sock")).isSocket()).toBe(true);
  directories.push(directory);
  return { child, directory, notifications, sessionFile, calls };
}

describe("real CLI-loaded extension and foreign-harness client", () => {
  it("copies the skill through Pi's actual file loader and answers a standalone client", async () => {
    const { child, directory, notifications } = await startChild();
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(directory, "pi-listen/scripts/client.mjs"),
      directory,
      "submit",
      "foreign-agent",
      "Review my implementation",
    ]);
    const messages = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages.at(-1)).toMatchObject({
      status: "completed",
      message: "Real CLI reply",
    });
    await child.prompt("/listen status");
    expect(notifications.at(-1)).toBe(directory);
    await child.stop();
    expect(fs.existsSync(directory)).toBe(false);
  }, 15_000);

  it("recovers completed results and interrupts uncertain work after SIGKILL and session resumption", async () => {
    const original = await startChild();
    const socket = join(original.directory, "inbox.sock");
    await exchange(socket, { op: "submit", id: "saved", message: "finish" });
    await exchange(socket, {
      op: "submit",
      id: "uncertain",
      message: "wait forever",
      wait: false,
    });
    await vi.waitFor(() =>
      expect(fs.readFileSync(original.calls, "utf8")).toContain("running"),
    );
    const manifest = JSON.parse(
      fs.readFileSync(join(original.directory, "listener.json"), "utf8"),
    );
    // This is the isolated Pi process created above, never the test/user process.
    expect(manifest.pid).not.toBe(process.pid);
    process.kill(manifest.pid, "SIGKILL");
    await vi.waitFor(() => expect(original.child.isAlive()).toBe(false));
    const resumed = await startChild(original.sessionFile);
    const resumedSocket = join(resumed.directory, "inbox.sock");
    expect(
      (await exchange(resumedSocket, { op: "get", id: "saved" }))[0],
    ).toMatchObject({ status: "completed", message: "Real CLI reply" });
    expect(
      (await exchange(resumedSocket, { op: "get", id: "uncertain" }))[0].status,
    ).toBe("interrupted");
    expect(
      (
        await exchange(resumedSocket, {
          op: "submit",
          id: "uncertain",
          message: "wait forever",
        })
      )[0].status,
    ).toBe("interrupted");
    expect(fs.readFileSync(original.calls, "utf8").trim().split("\n")).toEqual([
      "completed",
      "running",
    ]);
  }, 15_000);
});

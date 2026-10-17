import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcChild, type RpcChildOptions, type RpcEvent } from "./runner.js";

let cwd: string;
let fixture: string;
let clients: RpcChild[];
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "background-runner-test-"));
  fixture = join(cwd, "rpc.mjs");
  clients = [];
  await writeFile(
    fixture,
    `
import fs from 'node:fs';
const mode = process.argv[2];
const sessionFile = process.argv[process.argv.indexOf('--session') + 1];
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
const response = (command, data) => output({type:'response', id:command.id, success:true, data});
let prompt;
let buffer = '';
if (mode === 'stderr') process.stderr.write('x'.repeat(20000) + 'diagnostic tail');
if (mode === 'stubborn') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
output({type:'ready',pid:process.pid,args:process.argv});
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0,nl));
    buffer = buffer.slice(nl + 1);
    if (command.type === 'get_state') {
      if (mode === 'silent') continue;
      if (mode === 'startup-error') output({type:'extension_error',error:'guard could not load'});
      response(command, {sessionFile:mode === 'wrong-session'?'wrong':sessionFile,model:{provider:'faux',id:'test'},isStreaming:false});
      if (mode === 'exit') setTimeout(() => process.exit(7), 30);
      if (mode === 'broken-pipe') setTimeout(() => fs.closeSync(0), 10);
    } else if (command.type === 'clear_queue' || command.type === 'abort') {
      output({type:'stopping_command',command:command.type});
      response(command, {});
    } else if (command.type === 'prompt') {
      if (mode === 'reject' || mode === 'stderr') output({type:'response',id:command.id,success:false,error:'No API key found'});
      else if (mode === 'exit') { /* wait for unexpected exit */ }
      else if (mode === 'dialog') {
        prompt = command;
        output({type:'extension_ui_request',id:'dialog-1',method:'confirm',title:'Permission required'});
        output({type:'extension_ui_request',id:'notice-1',method:'notify',message:'child notice',notifyType:'warning'});
      } else {
        output({type:'received',message:command.message,images:command.images});
        const record=JSON.stringify({type:'text',text:'alpha\\u2028beta\\u2029gamma'})+'\\r\\n';
        process.stdout.write(record.slice(0,10));
        process.stdout.write(record.slice(10));
        response(command, {disposition:mode === 'handled'?'handled':'started'});
        output({type:'agent_settled',aborted:false});
      }
    } else if (command.type === 'extension_ui_response') {
      output({type:'dialog_response',response:command});
      response(prompt,{disposition:'handled'});
    }
  }
});
process.stdin.on('end', () => { if (mode !== 'stubborn') process.exit(0); });
`,
  );
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.stop(20)));
  await rm(cwd, { recursive: true, force: true });
});

function child(mode = "normal", options: Partial<RpcChildOptions> = {}) {
  const client = new RpcChild({
    cwd,
    sessionFile: join(cwd, "session.jsonl"),
    invocation: { command: process.execPath, args: [fixture, mode] },
    requestTimeoutMs: 1000,
    ...options,
  });
  clients.push(client);
  return client;
}

describe("RpcChild", () => {
  it("is not alive before startup and waits for a correlated readiness response", async () => {
    const client = child();
    expect(client.isAlive()).toBe(false);
    await client.start();
    expect(client.isAlive()).toBe(true);
    await client.stop();
    expect(client.isAlive()).toBe(false);
    await client.stop();
    await expect(client.prompt("too late")).rejects.toThrow();
    await expect(client.start()).rejects.toThrow("already started");
  });

  it("rejects missing executables and invalid cwd without unhandled error events", async () => {
    const missing = child("normal", {
      invocation: { command: join(cwd, "missing"), args: [] },
    });
    await expect(missing.start()).rejects.toThrow("ENOENT");
    expect(missing.isAlive()).toBe(false);
    const invalid = child("normal", { cwd: join(cwd, "missing-cwd") });
    await expect(invalid.start()).rejects.toThrow("ENOENT");
  });

  it("bounds handshake deadlines and rejects startup extension errors", async () => {
    await expect(
      child("silent", { requestTimeoutMs: 80 }).start(),
    ).rejects.toThrow("Timeout");
    await expect(child("startup-error").start()).rejects.toThrow(
      "guard could not load",
    );
    await expect(child("wrong-session").start()).rejects.toThrow(
      "unexpected session",
    );
    await expect(
      child("normal", {
        expectedModel: { provider: "other", id: "test" },
      }).start(),
    ).rejects.toThrow("foreground model");
  });

  it("rejects unsuccessful prompts rather than dropping response errors", async () => {
    const client = child("reject");
    await client.start();
    await expect(client.prompt("hello")).rejects.toThrow("No API key found");
  });

  it("keeps bounded stderr diagnostics in failures", async () => {
    const client = child("stderr");
    await client.start();
    const error = await client.prompt("hello").catch((error) => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("diagnostic tail");
    expect((error as Error).message.length).toBeLessThan(17_000);
  });

  it("preserves images and LF framing, including Unicode separators and chunked CRLF", async () => {
    const events: RpcEvent[] = [];
    const client = child("normal", { onEvent: (event) => events.push(event) });
    await client.start();
    const images = [
      { type: "image" as const, mimeType: "image/png", data: "YWJj" },
    ];
    expect(await client.prompt("", images)).toBe("started");
    expect(events).toContainEqual({ type: "received", message: "", images });
    expect(events).toContainEqual({
      type: "text",
      text: "alpha\u2028beta\u2029gamma",
    });
  });

  it("cancels dialogs explicitly and forwards child notifications", async () => {
    const events: RpcEvent[] = [];
    const diagnostic = vi.fn();
    const client = child("dialog", {
      onEvent: (event) => events.push(event),
      onDiagnostic: diagnostic,
    });
    await client.start();
    expect(await client.prompt("needs approval")).toBe("handled");
    expect(events).toContainEqual({
      type: "dialog_response",
      response: {
        type: "extension_ui_response",
        id: "dialog-1",
        cancelled: true,
      },
    });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("Cancelled background confirm"),
      "warning",
    );
    expect(diagnostic).toHaveBeenCalledWith("child notice", "warning");
  });

  it("clears queued work and awaits abort before closing stdin", async () => {
    const events: RpcEvent[] = [];
    const client = child("normal", { onEvent: (event) => events.push(event) });
    await client.start();
    await client.stop();
    expect(
      events
        .filter((event) => event.type === "stopping_command")
        .map((event) => event.command),
    ).toEqual(["clear_queue", "abort"]);
  });

  it("confirms SIGKILL exit before resolving stop, including concurrent stop calls", async () => {
    let pid = 0;
    const onExit = vi.fn();
    const client = child("stubborn", {
      onExit,
      onEvent: (event) => {
        if (event.type === "ready") pid = Number(event.pid);
      },
    });
    await client.start();
    await Promise.all([client.stop(20), client.stop(20)]);
    expect(client.isAlive()).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(onExit).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("rejects pending requests and reports unexpected exits", async () => {
    const onExit = vi.fn();
    const client = child("exit", { onExit });
    await client.start();
    await expect(client.prompt("hello")).rejects.toThrow("code=7");
    expect(client.isAlive()).toBe(false);
    expect(onExit).toHaveBeenCalledWith(expect.any(Error));
  });

  it("handles broken stdin pipes and throwing UI subscribers", async () => {
    const client = child("broken-pipe");
    await client.start();
    await sleep(80);
    await expect(client.prompt("hello")).rejects.toThrow();
    const safe = child("handled", {
      onEvent: () => {
        throw new Error("stale UI");
      },
    });
    await safe.start();
    expect(await safe.prompt("hello")).toBe("handled");
  });

  it("writes a private launch snapshot and removes it after confirmed stop", async () => {
    let bootstrap = "";
    const client = child("normal", {
      snapshot: { systemPrompt: "parent instructions", tools: ["read"] },
      onEvent: (event) => {
        if (event.type === "ready") {
          const args = event.args as string[];
          bootstrap = args[args.indexOf("--extension") + 1];
        }
      },
    });
    await client.start();
    const source = await readFile(bootstrap, "utf8");
    expect(source).toContain("parent instructions");
    expect(source).toContain("ctx.abort()");
    expect(source).toContain("pi.setActiveTools(snapshot.tools)");
    await client.stop();
    await expect(readFile(bootstrap)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

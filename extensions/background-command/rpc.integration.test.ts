import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcChild, type RpcChildOptions, type RpcEvent } from "./runner.js";

let cwd: string;
let clients: RpcChild[];
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "background-real-rpc-"));
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.stop()));
  await rm(cwd, { recursive: true, force: true });
});

async function realChild(
  overrides: Partial<RpcChildOptions> = {},
  extraArgs: string[] = [],
) {
  const provider = join(cwd, "provider.mjs");
  const calls = join(cwd, "calls.jsonl");
  const fauxURL = import.meta.resolve("@earendil-works/pi-ai/providers/faux");
  await writeFile(
    provider,
    `
import fs from 'node:fs';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(fauxURL)};
export default function(pi) {
  const faux = fauxProvider();
  const record = context => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(context) + '\\n');
  const finish = context => { record(context); return fauxAssistantMessage('Child complete.'); };
  if (process.env.BACKGROUND_GUARD_TEST === '1') {
    pi.registerTool({name:'guarded',label:'Guarded',description:'A test side effect',parameters:{type:'object',properties:{}},execute:async()=>{
      fs.writeFileSync(${JSON.stringify(join(cwd, "side-effect"))}, 'must not happen');
      return {content:[{type:'text',text:'executed'}],details:undefined};
    }});
    pi.on('tool_call', async (event,ctx) => {
      if (event.toolName === 'guarded' && !(await ctx.ui.confirm('Approve side effect?', 'Must be cancelled in background'))) return {block:true,reason:'Not approved'};
    });
    faux.setResponses([context => { record(context); return fauxAssistantMessage(fauxToolCall('guarded',{}),{stopReason:'toolUse'}); }, finish]);
  } else faux.setResponses([finish]);
  pi.registerProvider(faux.provider);
}
`,
  );
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const sessionFile = manager.getSessionFile()!;
  // Header-only session to exercise startup of an empty replay snapshot.
  await writeFile(sessionFile, `${JSON.stringify(manager.getHeader())}\n`);
  const events: RpcEvent[] = [];
  const diagnostics: string[] = [];
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const client = new RpcChild({
    cwd,
    sessionFile,
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
      "--provider",
      "faux",
      "--model",
      "faux-1",
      ...extraArgs,
    ],
    requestTimeoutMs: 5000,
    expectedModel: { provider: "faux", id: "faux-1" },
    snapshot: {
      systemPrompt: "Follow the parent's exact instructions.",
      tools: ["read"],
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === "agent_settled") settle();
    },
    onDiagnostic: (message) => diagnostics.push(message),
    ...overrides,
    env: { PI_CODING_AGENT_DIR: join(cwd, "agent"), ...overrides.env },
  });
  clients.push(client);
  await client.start();
  return { client, calls, events, diagnostics, settled, sessionFile };
}

describe("real Pi RPC child (local faux provider, no network)", () => {
  it("loads explicit extensions, restores exact tools/prompt/model, and persists replayed images", async () => {
    const { client, calls, settled, diagnostics, sessionFile } =
      await realChild();
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    };
    expect(await client.prompt("Inspect this", [image])).toBe("started");
    await settled;
    const context = JSON.parse((await readFile(calls, "utf8")).trim());
    const system = context.messages.filter(
      (message: { role: string }) => message.role === "system",
    );
    expect(system[0].content).toBe("Follow the parent's exact instructions.");
    expect(
      system
        .flatMap(
          (message: { toolsAdded?: Array<{ name: string }> }) =>
            message.toolsAdded ?? [],
        )
        .map((tool: { name: string }) => tool.name),
    ).toEqual(["read"]);
    const user = context.messages.find(
      (message: { role: string }) => message.role === "user",
    );
    expect(user.content).toContainEqual(
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        data: expect.any(String),
      }),
    );
    const entries = SessionManager.open(sessionFile).getBranch();
    expect(
      entries.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          Array.isArray(entry.message.content) &&
          entry.message.content.some((part) => part.type === "image"),
      ),
    ).toBe(true);
    expect(diagnostics).toEqual([]);
    await client.stop();
    expect(client.isAlive()).toBe(false);
  }, 15_000);

  it("preserves explicit permission extensions and denies their dialogs without running guarded tools", async () => {
    const { client, calls, settled, diagnostics } = await realChild({
      env: { BACKGROUND_GUARD_TEST: "1" },
      snapshot: {
        systemPrompt: "Try the guarded tool once, then finish.",
        tools: ["guarded"],
      },
    });
    await client.prompt("Run guarded");
    await settled;
    await expect(readFile(join(cwd, "side-effect"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(diagnostics).toContainEqual(
      expect.stringContaining("Cancelled background confirm dialog"),
    );
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(2);
  }, 15_000);

  it("fails startup when an explicitly loaded guard fails to load", async () => {
    const guard = join(cwd, "broken-guard.mjs");
    await writeFile(
      guard,
      "throw new Error('permission guard failed to load');",
    );
    await expect(realChild({}, ["--extension", guard])).rejects.toThrow(
      "permission guard failed to load",
    );
    await expect(readFile(join(cwd, "calls.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15_000);

  it("aborts before any provider call if a required dynamic tool is unavailable", async () => {
    const { client, calls, settled, diagnostics } = await realChild({
      snapshot: { systemPrompt: "parent", tools: ["missing_permission_tool"] },
    });
    await client.prompt("Must not reach a model");
    await settled;
    await expect(readFile(calls)).rejects.toMatchObject({ code: "ENOENT" });
    expect(diagnostics).toContainEqual(
      expect.stringContaining(
        "Background tools unavailable: missing_permission_tool",
      ),
    );
  }, 15_000);
});

import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import background from "./index.js";
import type { BackgroundClient, RpcChildOptions, RpcEvent } from "./runner.js";
import { BackgroundSupervisor } from "./supervisor.js";

class FakeClient implements BackgroundClient {
  alive = false;
  failStop = false;
  failStart = false;
  failPrompt = false;
  disposition: "started" | "handled" = "started";
  startWhenHandled = false;
  prompts: Array<{ text: string; images?: ImageContent[] }> = [];
  constructor(readonly options: RpcChildOptions) {}
  start = vi.fn(async () => {
    if (this.failStart) throw new Error("spawn failed");
    this.alive = true;
  });
  prompt = vi.fn(async (text: string, images?: ImageContent[]) => {
    if (this.failPrompt) throw new Error("prompt rejected");
    this.prompts.push({ text, images });
    if (this.disposition === "started" || this.startWhenHandled)
      this.emit({ type: "agent_start" });
    return this.disposition;
  });
  stop = vi.fn(async () => {
    if (this.failStop) throw new Error("termination uncertain");
    if (this.alive) {
      this.alive = false;
      this.options.onExit?.();
    }
  });
  isAlive(): boolean {
    return this.alive;
  }
  emit(event: RpcEvent): void {
    this.options.onEvent?.(event);
  }
  crash(): void {
    this.alive = false;
    this.options.onExit?.(new Error("unexpected child exit"));
  }
}

let cwd: string;
let runtime: AgentSessionRuntime | undefined;
let clients: FakeClient[];
let errors: unknown[];
let supervisor: BackgroundSupervisor;
let nextClient: ((client: FakeClient) => void) | undefined;
const confirm = vi.fn(async (_title: string, _message: string) => true);
const select = vi.fn(
  async (_title: string, _items: string[]): Promise<string | undefined> =>
    undefined,
);
const notify = vi.fn();
const setStatus = vi.fn();
const ui = new Proxy(
  {
    theme: { fg: (_color: string, text: string) => text },
    confirm,
    select,
    notify,
    setStatus,
  },
  {
    get: (object, key) =>
      key in object ? object[key as keyof typeof object] : () => {},
  },
) as unknown as ExtensionUIContext;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "background-integration-test-"));
  clients = [];
  errors = [];
  supervisor = new BackgroundSupervisor();
  nextClient = undefined;
  confirm.mockReset().mockResolvedValue(true);
  select.mockReset().mockResolvedValue(undefined);
  notify.mockReset();
  setStatus.mockReset();
});
afterEach(async () => {
  for (const client of clients) client.failStop = false;
  if (runtime) {
    runtime.session.clearQueue();
    await runtime.session.abort();
    await runtime.dispose();
  }
  runtime = undefined;
  await rm(cwd, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

async function harness(
  extensions: ExtensionFactory[] = [],
  mode: "rpc" | "print" = "rpc",
) {
  const faux = fauxProvider();
  const factory: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        images: { autoResize: false },
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => pi.registerProvider(faux.provider),
          (pi) =>
            background(pi, {
              supervisor,
              launchArgs: ["--no-mcp"],
              createClient: (options) => {
                const client = new FakeClient(options);
                nextClient?.(client);
                nextClient = undefined;
                clients.push(client);
                return client;
              },
            }),
          ...extensions,
        ],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: faux.getModel(),
        tools: [],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  runtime = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir: join(cwd, "agent"),
    sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
  });
  const bind = async () => {
    await runtime!.session.bindExtensions({
      mode,
      uiContext: mode === "rpc" ? ui : undefined,
      onError: (error) => errors.push(error),
      commandContextActions: {
        waitForIdle: () => runtime!.session.waitForIdle(),
        newSession: (options) => runtime!.newSession(options),
        fork: (id, options) => runtime!.fork(id, options),
        navigateTree: (id, options) =>
          runtime!.session.navigateTree(id, options),
        switchSession: (file, options) => runtime!.switchSession(file, options),
        reload: () => runtime!.session.reload(),
      },
    });
  };
  runtime.setRebindSession(bind);
  await bind();

  const run = async (
    text = "live user request",
    options: {
      source?: "interactive" | "extension" | "rpc";
      images?: ImageContent[];
    } = {},
  ) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    faux.appendResponses([
      async (_context, streamOptions) => {
        started();
        await new Promise<void>((resolve) => {
          if (streamOptions?.signal?.aborted) resolve();
          else
            streamOptions?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return fauxAssistantMessage("aborted", { stopReason: "aborted" });
      },
    ]);
    const running = runtime!.session.prompt(text, options);
    await ready;
    return { running };
  };
  const command = (args = "") =>
    runtime!.session.prompt(`/background${args ? ` ${args}` : ""}`);
  const completions = async (prefix: string) =>
    (await runtime!.session.extensionRunner.getCommand("background")!
      .getArgumentCompletions!(prefix)) ?? [];
  return { faux, run, command, completions };
}

describe("/background using the real Pi runtime", () => {
  it("replays an active request from a durable clean branch with explicit confirmation", async () => {
    const h = await harness();
    const original = runtime!.session.sessionFile;
    const { running } = await h.run("inspect the current code");
    await h.command();
    await running;
    expect(confirm).toHaveBeenCalledWith(
      "Replay request in background?",
      expect.stringContaining("Completed side effects can repeat"),
      { signal: expect.any(AbortSignal), timeout: 30_000 },
    );
    expect(clients[0].prompts).toEqual([
      { text: "inspect the current code", images: [] },
    ]);
    const task = supervisor.store.get("bg-1")!;
    const fork = SessionManager.open(task.sessionFile);
    expect(
      fork
        .getBranch()
        .some(
          (entry) => entry.type === "message" && entry.message.role === "user",
        ),
    ).toBe(false);
    expect(fork.getHeader()?.parentSession).toBe(original);
    expect(runtime!.session.sessionFile).toBe(original);
    expect(clients[0].options.args).toContain("--no-mcp");
    expect(clients[0].options.snapshot?.tools).toEqual([]);
    expect(clients[0].options.expectedModel).toEqual({
      provider: h.faux.getModel().provider,
      id: h.faux.getModel().id,
    });
    expect(runtime!.session.sessionManager.getEntries()).toContainEqual(
      expect.objectContaining({
        type: "custom_message",
        customType: "background-detach",
        display: true,
      }),
    );
    expect(setStatus).toHaveBeenLastCalledWith("background", "bg: 1A");
  });

  it("leaves the foreground alone when confirmation is declined or the run finishes during it", async () => {
    const h = await harness();
    const { running } = await h.run();
    confirm.mockResolvedValueOnce(false);
    await h.command();
    expect(runtime!.session.isStreaming).toBe(true);
    expect(clients).toHaveLength(0);
    confirm.mockImplementationOnce(async () => {
      await runtime!.session.abort();
      return true;
    });
    await h.command();
    await running;
    expect(clients).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("changed or completed"),
      "error",
    );
  });

  it("refuses idle, completed, repeated, queued and extension-started requests", async () => {
    const h = await harness();
    await h.command();
    expect(clients).toHaveLength(0);
    h.faux.appendResponses([fauxAssistantMessage("complete")]);
    await runtime!.session.prompt("already done");
    await h.command();
    expect(clients).toHaveLength(0);
    let active = await h.run("programmatic request", { source: "extension" });
    await h.command();
    expect(clients).toHaveLength(0);
    await runtime!.session.abort();
    await active.running;
    active = await h.run();
    await runtime!.session.steer("queued instruction");
    await h.command();
    expect(clients).toHaveLength(0);
    runtime!.session.clearQueue();
    await runtime!.session.abort();
    await active.running;
    active = await h.run("detach once");
    await h.command();
    await active.running;
    await h.command();
    expect(clients).toHaveLength(1);
  });

  it("preserves mixed and image-only requests", async () => {
    const h = await harness();
    const image: ImageContent = {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    };
    let active = await h.run("look at this", { images: [image] });
    await h.command();
    await active.running;
    expect(clients[0].prompts[0]).toEqual({
      text: "look at this",
      images: [image],
    });
    active = await h.run("", { images: [image] });
    await h.command();
    await active.running;
    expect(clients[1].prompts[0]).toEqual({ text: "", images: [image] });
  });

  it("keeps sibling children and monotonic IDs across resume, /new, and reload without stale contexts", async () => {
    const h = await harness();
    let active = await h.run("first task");
    await h.command();
    await active.running;
    active = await h.run("second task");
    await h.command();
    await active.running;
    const firstFile = supervisor.store.get("bg-1")!.sessionFile;
    await h.command("resume bg-1");
    expect(runtime!.session.sessionFile).toBe(firstFile);
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(clients[1].stop).not.toHaveBeenCalled();
    expect(supervisor.store.all().map((task) => task.id)).toEqual(["bg-2"]);
    clients[1].options.onDiagnostic?.("after switch", "warning");
    expect(notify).toHaveBeenCalledWith(
      "Background: bg-2: after switch",
      "warning",
    );
    await runtime!.newSession();
    await runtime!.session.reload();
    expect(clients[1].stop).not.toHaveBeenCalled();
    expect((await h.completions("resume ")).map((item) => item.label)).toEqual([
      "bg-2",
    ]);
    active = await h.run("third task");
    await h.command();
    await active.running;
    expect(supervisor.store.all().map((task) => task.id)).toEqual([
      "bg-2",
      "bg-3",
    ]);
    expect(errors).toEqual([]);
  });

  it("retains resumed ancestors in the task tree", async () => {
    const h = await harness();
    let active = await h.run("parent");
    await h.command();
    await active.running;
    await h.command("resume bg-1");
    active = await h.run("descendant");
    await h.command();
    await active.running;
    expect(supervisor.store.tree()).toMatchObject([
      {
        archived: true,
        task: { id: "bg-1" },
        children: [{ task: { id: "bg-2" } }],
      },
    ]);
    await h.command("list");
    expect(select).toHaveBeenCalledWith(
      expect.any(String),
      [
        expect.stringContaining("bg-1 [resumed ancestor]"),
        expect.stringContaining("└─ bg-2 [active]"),
      ],
      { signal: expect.any(AbortSignal), timeout: 30_000 },
    );
  });

  it("blocks built-in resume of a live child's JSONL without stopping unrelated work", async () => {
    const h = await harness();
    const active = await h.run();
    await h.command();
    await active.running;
    const target = supervisor.store.get("bg-1")!.sessionFile;
    const original = runtime!.session.sessionFile;
    expect(await runtime!.switchSession(target)).toEqual({ cancelled: true });
    const alias = join(cwd, "child-alias.jsonl");
    await symlink(target, alias);
    expect(await runtime!.switchSession(alias)).toEqual({ cancelled: true });
    expect(runtime!.session.sessionFile).toBe(original);
    expect(clients[0].isAlive()).toBe(true);
  });

  it("keeps stopped tasks resumable and accurately labelled after cancellation", async () => {
    let cancel = true;
    const h = await harness([
      (pi) => {
        pi.on("session_before_switch", () =>
          cancel ? { cancel: true } : undefined,
        );
      },
    ]);
    const active = await h.run();
    await h.command();
    await active.running;
    const file = supervisor.store.get("bg-1")!.sessionFile;
    await h.command("resume bg-1");
    expect(clients[0].isAlive()).toBe(false);
    expect(supervisor.store.statusOf(supervisor.store.get("bg-1")!)).toBe(
      "killed",
    );
    expect((await h.completions("resume "))[0].label).toBe("bg-1");
    expect(await h.completions("kill ")).toEqual([]);
    await expect(access(file)).resolves.toBeUndefined();
    cancel = false;
    await h.command("resume bg-1");
    expect(runtime!.session.sessionFile).toBe(file);
    expect(supervisor.store.all()).toEqual([]);
  });

  it("never switches or unlinks when child termination is uncertain", async () => {
    const h = await harness();
    const active = await h.run();
    await h.command();
    await active.running;
    const original = runtime!.session.sessionFile;
    const task = supervisor.store.get("bg-1")!;
    clients[0].failStop = true;
    await h.command("resume bg-1");
    expect(runtime!.session.sessionFile).toBe(original);
    await h.command("delete bg-1");
    expect(supervisor.store.get(task.id)).toBe(task);
    expect(clients[0].isAlive()).toBe(true);
    await expect(access(task.sessionFile)).resolves.toBeUndefined();
  });

  it("only stops the selected child and preserves session files for kill", async () => {
    const h = await harness();
    let active = await h.run("first");
    await h.command();
    await active.running;
    active = await h.run("second");
    await h.command();
    await active.running;
    const first = supervisor.store.get("bg-1")!;
    const second = supervisor.store.get("bg-2")!;
    await h.command("kill bg-1");
    await expect(access(first.sessionFile)).resolves.toBeUndefined();
    expect(supervisor.store.statusOf(first)).toBe("killed");
    expect(clients[1].stop).not.toHaveBeenCalled();
    await h.command("delete bg-2");
    expect(supervisor.store.get("bg-2")).toBeUndefined();
    await expect(access(second.sessionFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("handles spawn/prompt failures and handled dispositions without false active tasks", async () => {
    const h = await harness();
    nextClient = (client) => {
      client.failStart = true;
    };
    let active = await h.run("spawn fails");
    await h.command();
    await active.running;
    expect(supervisor.store.statusOf(supervisor.store.get("bg-1")!)).toBe(
      "killed",
    );
    nextClient = (client) => {
      client.failPrompt = true;
    };
    active = await h.run("prompt fails");
    await h.command();
    await active.running;
    expect(supervisor.store.statusOf(supervisor.store.get("bg-2")!)).toBe(
      "killed",
    );
    expect(supervisor.store.get("bg-2")!.error).toContain("prompt rejected");
    nextClient = (client) => {
      client.disposition = "handled";
    };
    active = await h.run("handled without a run");
    await h.command();
    await active.running;
    expect(supervisor.store.statusOf(supervisor.store.get("bg-3")!)).toBe(
      "paused",
    );
  });

  it("stays active during low-level retry boundaries and tracks exits", async () => {
    const h = await harness();
    const active = await h.run();
    await h.command();
    await active.running;
    const task = supervisor.store.get("bg-1")!;
    clients[0].emit({ type: "agent_end", willRetry: true });
    expect(supervisor.store.statusOf(task)).toBe("active");
    clients[0].emit({ type: "agent_settled" });
    expect(supervisor.store.statusOf(task)).toBe("paused");
    clients[0].crash();
    expect(supervisor.store.statusOf(task)).toBe("killed");
    expect(task.error).toContain("unexpected child exit");
    expect(setStatus).toHaveBeenLastCalledWith("background", "bg: 1K");
  });

  it("asks before aborting unrelated foreground work to resume", async () => {
    const h = await harness();
    let active = await h.run("background");
    await h.command();
    await active.running;
    active = await h.run("unrelated foreground");
    confirm.mockResolvedValueOnce(false);
    await h.command("resume bg-1");
    expect(runtime!.session.isStreaming).toBe(true);
    expect(clients[0].stop).not.toHaveBeenCalled();
    await h.command("resume bg-1");
    await active.running;
    expect(confirm).toHaveBeenLastCalledWith(
      "Resume background task?",
      expect.any(String),
      { signal: expect.any(AbortSignal), timeout: 30_000 },
    );
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
  });

  it("does not mislabel handled prompts that independently start a child run", async () => {
    const h = await harness();
    nextClient = (client) => {
      client.disposition = "handled";
      client.startWhenHandled = true;
    };
    const active = await h.run();
    await h.command();
    await active.running;
    expect(supervisor.store.statusOf(supervisor.store.get("bg-1")!)).toBe(
      "active",
    );
  });

  it("surfaces provider failures after acceptance and clears transient errors on recovery", async () => {
    const h = await harness();
    const active = await h.run();
    await h.command();
    await active.running;
    const task = supervisor.store.get("bg-1")!;
    clients[0].emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider unavailable",
      },
    });
    clients[0].emit({ type: "agent_end", willRetry: true });
    expect(supervisor.store.statusOf(task)).toBe("active");
    clients[0].emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop" },
    });
    expect(task.error).toBeUndefined();
    clients[0].emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "final failure",
      },
    });
    clients[0].emit({ type: "agent_settled" });
    expect(supervisor.store.statusOf(task)).toBe("paused");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("settled with an error: final failure"),
      "error",
    );
  });

  it("retains recoverable metadata for missing files, switch failures, and unlink failures", async () => {
    const h = await harness();
    const active = await h.run();
    await h.command();
    await active.running;
    const task = supervisor.store.get("bg-1")!;
    const switching = vi
      .spyOn(runtime!, "switchSession")
      .mockRejectedValueOnce(new Error("load failed"));
    await h.command("resume bg-1");
    expect(supervisor.store.get(task.id)).toBe(task);
    expect(supervisor.store.statusOf(task)).toBe("killed");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("session is preserved"),
      "error",
    );
    switching.mockRestore();
    await rm(task.sessionFile);
    const stopCalls = clients[0].stop.mock.calls.length;
    await h.command("resume bg-1");
    expect(clients[0].stop).toHaveBeenCalledTimes(stopCalls);
    expect(supervisor.store.get(task.id)).toBe(task);
    await mkdir(task.sessionFile);
    await h.command("delete bg-1");
    expect(supervisor.store.get(task.id)).toBe(task);
  });

  it("rejects concurrent mutations and session switches during confirmation", async () => {
    const h = await harness();
    await h.run();
    let release!: (confirmed: boolean) => void;
    confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.command();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await h.command("list");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("operation is in progress"),
      "error",
    );
    expect(await runtime!.newSession()).toEqual({ cancelled: true });
    release(false);
    await pending;
    expect(clients).toHaveLength(0);
  });

  it.each(["reload", "quit"] as const)(
    "cancels pending dialogs on %s without hanging or orphaning established tasks",
    async (action) => {
      const h = await harness();
      let active = await h.run("established child");
      await h.command();
      await active.running;
      active = await h.run("pending handoff");
      let opened = false;
      confirm.mockImplementationOnce(() => {
        opened = true;
        return new Promise<boolean>(() => {});
      });
      const pending = h.command();
      await vi.waitFor(() => expect(opened).toBe(true));
      if (action === "reload") await runtime!.session.reload();
      else {
        await runtime!.dispose();
        runtime = undefined;
      }
      await pending;
      if (action === "reload") await runtime!.session.abort();
      await active.running;
      expect(supervisor.busy).toBe(false);
      expect(clients).toHaveLength(1);
      expect(clients[0].isAlive()).toBe(action === "reload");
    },
  );

  it("reports unsupported print-mode commands through Pi's error channel", async () => {
    const h = await harness([], "print");
    await h.command();
    expect(errors).toContainEqual(
      expect.objectContaining({
        error: expect.stringContaining("requires an interactive or RPC UI"),
      }),
    );
    errors.length = 0;
    expect(clients).toHaveLength(0);
  });

  it("validates arguments and stops every child exactly once on quit", async () => {
    const h = await harness();
    await h.command("list unknown");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("unknown status"),
      "error",
    );
    await h.command("kill");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("specify a task ID"),
      "error",
    );
    let active = await h.run("first");
    await h.command();
    await active.running;
    active = await h.run("second");
    await h.command();
    await active.running;
    await runtime!.dispose();
    runtime = undefined;
    expect(
      clients.every(
        (client) => client.stop.mock.calls.length === 1 && !client.isAlive(),
      ),
    ).toBe(true);
  });
});

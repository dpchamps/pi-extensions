import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import watcherAwait from "./index.js";

let cwd: string;
let runtime: AgentSessionRuntime | undefined;
const errors: unknown[] = [];
const setWidget = vi.fn<ExtensionUIContext["setWidget"]>();
const select = vi.fn<ExtensionUIContext["select"]>();
const confirm = vi.fn<ExtensionUIContext["confirm"]>();
const notify = vi.fn<ExtensionUIContext["notify"]>();
const ui = new Proxy(
  { setWidget, select, confirm, notify },
  {
    get: (obj, key) => (key in obj ? obj[key as keyof typeof obj] : () => {}),
  },
) as unknown as ExtensionUIContext;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "watcher-session-"));
  errors.length = 0;
  vi.resetAllMocks();
});
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  await rm(cwd, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

async function harness(
  mode: ExtensionContext["mode"] = "rpc",
  extra?: ExtensionFactory,
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
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => pi.registerProvider(faux.provider),
          watcherAwait,
          ...(extra ? [extra] : []),
        ],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: faux.getModel(),
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const host = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir: join(cwd, "agent"),
    sessionManager: SessionManager.inMemory(cwd),
  });
  runtime = host;
  const bind = () =>
    host.session.bindExtensions({
      mode,
      uiContext: ui,
      onError: (err) => errors.push(err),
    });
  host.setRebindSession(bind);
  await bind();
  const session = host.session;
  const notices = () =>
    session.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "watcher-await",
      );
  const start = async (command: string, progress = false) => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("watcher_await", { command, progress }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("I started it."),
      fauxAssistantMessage("The watcher finished."),
    ]);
    await session.prompt("Start a job.");
  };
  const openPicker = () => {
    const runner = session.extensionRunner;
    return runner
      .getShortcuts({})
      .get("ctrl+alt+w")!
      .handler(runner.createContext());
  };
  return { session, host, faux, start, notices, openPicker };
}

async function childPid() {
  let pid = 0;
  await vi.waitFor(async () => {
    pid = Number(await readFile(join(cwd, "pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
  });
  return pid;
}

describe.skipIf(process.platform === "win32")("watcher-await with Pi", () => {
  it("returns before completion, leaves Pi available, and wakes exactly once with the result", async () => {
    const { session, faux, start, notices } = await harness();
    expect(session.systemPrompt).toContain("Pi will wake you with the result");
    await start(
      "while [ ! -e release ]; do sleep 0.02; done; printf 'work done'; exit 7",
    );
    expect(notices()).toHaveLength(0);
    expect(setWidget).toHaveBeenLastCalledWith(
      "watcher-await",
      ["Watcher: w1"],
      { placement: "belowEditor" },
    );
    await session.prompt("I can give you another request while that runs.");
    expect(faux.state.callCount).toBe(3);
    faux.setResponses([fauxAssistantMessage("The watcher finished.")]);
    await writeFile(join(cwd, "release"), "");
    await vi.waitFor(() => expect(notices()).toHaveLength(1));
    await session.waitForIdle();
    expect(notices()[0]).toMatchObject({
      content: expect.stringMatching(/exit code 7[\s\S]*work done/),
    });
    expect(faux.state.callCount).toBe(4);
    expect(setWidget).toHaveBeenLastCalledWith("watcher-await", undefined, {
      placement: "belowEditor",
    });
  });

  it("allows the model to list and cancel jobs without registering a slash command", async () => {
    let commands: string[] = [];
    const { session, start, notices, faux } = await harness("rpc", (pi) => {
      pi.on("session_start", () => {
        commands = pi.getCommands().map((item) => item.name);
      });
    });
    expect(commands).not.toContain("watcher-await");
    await start("printf '%s' \"$$\" > pid; exec sleep 60", true);
    const pid = await childPid();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("watcher_await", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("watcher_await", { cancel: "w1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("I requested cancellation."),
      fauxAssistantMessage("The job has stopped."),
    ]);
    await session.prompt("Find the running job and stop it.");
    const toolResults = session.messages.filter(
      (message) => message.role === "toolResult",
    );
    expect(toolResults.at(-2)?.content).toEqual([
      { type: "text", text: expect.stringContaining("w1 [running") },
    ]);
    expect(toolResults.at(-1)?.content).toEqual([
      { type: "text", text: "Cancellation requested for w1." },
    ]);
    await vi.waitFor(() =>
      expect(notices()[0]).toMatchObject({
        content: expect.stringContaining("w1 cancelled"),
      }),
    );
    await session.waitForIdle();
    expect(() => process.kill(pid, 0)).toThrow("ESRCH");
  });

  it("lets the user inspect jobs and cancel with the widget's shortcut", async () => {
    const { session, start, notices, openPicker } = await harness("tui");
    await start("printf '%s' \"$$\" > pid; exec sleep 60");
    const pid = await childPid();
    expect(setWidget).toHaveBeenLastCalledWith(
      "watcher-await",
      ["Watcher: w1 · Ctrl+Alt+W"],
      { placement: "belowEditor" },
    );
    select
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async (_title, [first]) => first);
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await openPicker(); // View only
    expect(confirm).not.toHaveBeenCalled();
    await openPicker(); // Decline cancellation
    expect(() => process.kill(pid, 0)).not.toThrow();
    await openPicker();
    expect(select).toHaveBeenLastCalledWith(
      expect.any(String),
      [expect.stringContaining("w1 [running")],
      expect.any(Object),
    );
    expect(notify).toHaveBeenCalledWith(
      "Cancellation requested for w1",
      "info",
    );
    await vi.waitFor(() =>
      expect(notices()[0]).toMatchObject({
        content: expect.stringContaining("w1 cancelled"),
      }),
    );
    await session.waitForIdle();
    expect(() => process.kill(pid, 0)).toThrow("ESRCH");
  });

  it("defers the wake while inspecting and doesn't cancel a stale selection", async () => {
    const { session, start, notices, openPicker } = await harness("tui");
    await start("while [ ! -e release ]; do sleep 0.02; done");
    let dismiss: (() => void) | undefined;
    select.mockImplementation(async (_title, [first]) => {
      await new Promise<void>((resolve) => {
        dismiss = resolve;
      });
      return first;
    });
    const picker = openPicker();
    try {
      await vi.waitFor(() => expect(dismiss).toBeDefined());
      await writeFile(join(cwd, "release"), "");
      await vi.waitFor(() =>
        expect(setWidget).toHaveBeenLastCalledWith("watcher-await", undefined, {
          placement: "belowEditor",
        }),
      );
      expect(notices()).toHaveLength(0);
    } finally {
      dismiss?.();
      await picker;
    }
    expect(confirm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(notices()).toHaveLength(1));
    await session.waitForIdle();
  });

  it("holds completion until a busy foreground run settles", async () => {
    let unblock: () => void;
    const hold = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered = false;
    const { session, start, notices } = await harness("rpc", (pi) => {
      pi.on("before_agent_start", async (event) => {
        if (event.messageType === "user" && event.prompt === "hold") {
          entered = true;
          await hold;
        }
      });
    });
    await start("while [ ! -e release ]; do sleep 0.02; done");
    const foreground = session.prompt("hold");
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      await writeFile(join(cwd, "release"), "");
      await vi.waitFor(() =>
        expect(setWidget).toHaveBeenLastCalledWith("watcher-await", undefined, {
          placement: "belowEditor",
        }),
      );
      expect(notices()).toHaveLength(0);
    } finally {
      unblock!();
      await foreground;
    }
    await vi.waitFor(() => expect(notices()).toHaveLength(1));
    await session.waitForIdle();
  });

  it("updates opt-in progress without adding a message or waking the agent", async () => {
    const tick = vi.spyOn(globalThis, "setInterval");
    try {
      const { start, faux, notices } = await harness();
      await start("printf 'step one complete\\n'; exec sleep 60", true);
      const callback = tick.mock.calls.find(([, ms]) => ms === 15_000)?.[0];
      expect(typeof callback).toBe("function");
      await vi.waitFor(() => {
        (callback as () => void)();
        expect(setWidget).toHaveBeenLastCalledWith(
          "watcher-await",
          [expect.stringContaining("step one complete")],
          { placement: "belowEditor" },
        );
      });
      expect(notices()).toHaveLength(0);
      expect(faux.state.callCount).toBe(2);
    } finally {
      tick.mockRestore();
    }
  });

  it.each(["reload", "tree", "new", "quit"] as const)(
    "stops and reaps jobs on %s without delivering a stale completion",
    async (operation) => {
      const { session, host, start, notices, faux } = await harness();
      await start("printf '%s' \"$$\" > pid; exec sleep 60");
      const pid = await childPid();
      if (operation === "reload") {
        await session.reload();
        expect(session.getActiveToolNames()).toContain("watcher_await");
      }
      if (operation === "new")
        expect((await host.newSession()).cancelled).toBe(false);
      if (operation === "quit") {
        await host.dispose();
        runtime = undefined;
      }
      if (operation === "tree") {
        const user = session.sessionManager
          .getBranch()
          .find((e) => e.type === "message" && e.message.role === "user");
        expect(await session.navigateTree(user!.id)).toMatchObject({
          cancelled: false,
        });
      }
      expect(() => process.kill(pid, 0)).toThrow("ESRCH");
      expect(notices()).toHaveLength(0);
      expect(faux.state.callCount).toBe(2);
    },
  );

  it.each(["print", "json"] as const)(
    "does not expose background jobs in %s mode",
    async (mode) => {
      const { session } = await harness(mode);
      expect(session.getActiveToolNames()).not.toContain("watcher_await");
    },
  );
});

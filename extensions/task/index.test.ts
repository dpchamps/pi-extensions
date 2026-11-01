import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import taskExtension from "./index.js";
import type { GoalChecker } from "./goal-checker.js";
import type { Component } from "@earendil-works/pi-tui";

type EventHandler = (event: any, ctx: ExtensionContext) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeChecker(): GoalChecker {
  return {
    initialize: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      complete: false,
      feedback: "Keep working.",
    })),
    dispose: vi.fn(async () => {}),
  };
}

function createHarness(options: Parameters<typeof taskExtension>[1] = {}) {
  const handlers = new Map<string, EventHandler[]>();
  let command:
    | {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }
    | undefined;
  const sendUserMessage = vi.fn();
  const exec = vi.fn();

  const pi = {
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerCommand: (_name: string, registered: typeof command) => {
      command = registered;
    },
    sendUserMessage,
    exec,
  } as unknown as ExtensionAPI;

  taskExtension(pi, options);

  const notify = vi.fn();
  const setStatus = vi.fn();
  let widget: Component | undefined;
  const requestRender = vi.fn();
  const unsubscribeInput = vi.fn();
  const onTerminalInput = vi.fn(() => unsubscribeInput);
  const theme = { fg: (_color: string, text: string) => text };
  const setWidget = vi.fn((_key, factory) => {
    widget = factory?.({ terminal: { rows: 30 }, requestRender }, theme);
  });
  const isIdle = vi.fn(() => true);
  const abort = vi.fn();
  const compact = vi.fn((compactOptions: { onComplete?: () => void }) =>
    compactOptions.onComplete?.(),
  );
  const context = {
    cwd: "/workspace",
    hasUI: true,
    mode: "tui",
    model: { provider: "test", id: "model" },
    thinkingLevel: "medium",
    ui: {
      notify,
      setStatus,
      setWidget,
      onTerminalInput,
      theme,
    },
    getContextUsage: () => ({ tokens: 60, contextWindow: 100, percent: 60 }),
    compact,
    isIdle,
    abort,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;

  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? [])
      await handler(event, context);
  };

  return {
    command: (args: string) => command!.handler(args, context),
    emit,
    context,
    sendUserMessage,
    exec,
    compact,
    notify,
    setStatus,
    setWidget,
    isIdle,
    abort,
    unsubscribeInput,
    renderWidget: () => widget?.render(100).join("\n") ?? "",
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("task loops", () => {
  it("repeats the exact oracle prompt after a non-zero verifier exit", async () => {
    const harness = createHarness({ launchArgs: [] });
    harness.exec
      .mockResolvedValueOnce({
        stdout: "failure details",
        stderr: "",
        code: 1,
        killed: false,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
      });

    await harness.command('--verify "npm test" fix the tests');
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith("fix the tests");

    await harness.emit("agent_settled", { aborted: false });
    expect(harness.exec).toHaveBeenCalledWith(
      "bash",
      ["-c", "npm test"],
      expect.objectContaining({
        cwd: "/workspace",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith("fix the tests");
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);

    await harness.emit("agent_settled", { aborted: false });
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Task oracle: verification passed after 2 run(s)",
      "info",
    );
  });

  it("compacts focus at 60 percent before sending the continuation", async () => {
    const order: string[] = [];
    const harness = createHarness({ launchArgs: [] });
    harness.compact.mockImplementation(
      (options: { onComplete?: () => void }) => {
        order.push("compact");
        options.onComplete?.();
      },
    );
    harness.sendUserMessage.mockImplementation(() => order.push("send"));

    await harness.command("--focus --limit 2 explore alternatives");
    order.length = 0;
    await harness.emit("agent_settled", { aborted: false });

    expect(order).toEqual(["compact", "send"]);
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "The current run is not exhausted. Be creative and try different approaches.",
      ),
    );
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("explore alternatives"),
    );

    await harness.emit("agent_settled", { aborted: false });
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Task focus: reached the limit of 2 run(s)",
      "info",
    );
  });

  it("initializes a goal checker before starting and uses its independent decision", async () => {
    const order: string[] = [];
    let streamUpdate: ((update: any) => void) | undefined;
    const checker: GoalChecker = {
      initialize: vi.fn(async () => {
        order.push("initialize");
        streamUpdate?.({
          phase: "planning",
          type: "text",
          text: "Inspecting the repository…",
        });
        streamUpdate?.({
          phase: "planning",
          type: "checklist",
          text: "# Checklist\n- [ ] Run integration tests",
        });
      }),
      evaluate: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push("evaluate-incomplete");
          return {
            complete: false,
            feedback: "The integration test still fails.",
          };
        })
        .mockImplementationOnce(async () => {
          order.push("evaluate-complete");
          return { complete: true, feedback: "All checks pass." };
        }),
      dispose: vi.fn(async () => {
        order.push("dispose");
      }),
    };
    const harness = createHarness({
      launchArgs: [],
      goalCheckerFactory: async (config) => {
        streamUpdate = config.onUpdate;
        return checker;
      },
    });
    harness.sendUserMessage.mockImplementation(() => order.push("send"));

    await harness.command("--goal implement checkout");
    expect(order.slice(0, 2)).toEqual(["initialize", "send"]);
    expect(harness.setWidget).toHaveBeenCalledWith(
      "task-goal-stream",
      expect.any(Function),
    );
    expect(harness.renderWidget()).toContain("Goal planner (live)");
    expect(harness.renderWidget()).toContain("- [ ] Run integration tests");

    await harness.emit("agent_settled", { aborted: false });
    expect(order).toContain("evaluate-incomplete");
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("The integration test still fails."),
    );

    await harness.emit("agent_settled", { aborted: false });
    expect(order).toContain("evaluate-complete");
    expect(checker.dispose).toHaveBeenCalledOnce();
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Task goal: independently verified after 2 run(s)",
      "info",
    );
  });

  it("keeps verification alive through chat and aborts it only on /task cancel", async () => {
    const harness = createHarness({ launchArgs: [] });
    harness.exec.mockImplementation(
      async (_command, _args, options: { signal: AbortSignal }) =>
        await new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => resolve({ stdout: "", stderr: "", code: 1, killed: true }),
            { once: true },
          );
        }),
    );

    await harness.command('--verify "sleep 10" keep going');
    const settling = harness.emit("agent_settled", { aborted: false });
    const signal = harness.exec.mock.calls[0][2].signal as AbortSignal;
    await harness.emit("input", { source: "interactive" });
    await harness.emit("input", { source: "rpc" });
    expect(signal.aborted).toBe(false);
    await harness.emit("agent_settled", { aborted: false });
    expect(harness.exec).toHaveBeenCalledOnce();

    await harness.command("cancel");
    await settling;

    expect(signal.aborted).toBe(true);
    expect(harness.notify).toHaveBeenCalledWith(
      "Task oracle: cancelled",
      "info",
    );
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    '--verify "false" original goal',
    "--focus original goal",
    "--goal original goal",
  ])("keeps %s active when ordinary chat is submitted", async (args) => {
    const checker = fakeChecker();
    const harness = createHarness({
      launchArgs: [],
      goalCheckerFactory: () => checker,
    });
    harness.exec.mockResolvedValue({ code: 1, killed: false });
    await harness.command(args);
    await harness.emit("input", {
      source: "interactive",
      text: "Here is more context",
    });
    await harness.command("--focus another task");
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Task: a task is already running. Use /task cancel to cancel it first.",
      "warning",
    );
    await harness.emit("agent_settled", { aborted: false });
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(checker.dispose).not.toHaveBeenCalled();
    await harness.command("cancel");
  });

  it.each([
    '--verify "false" original goal',
    "--focus original goal",
    "--goal original goal",
  ])(
    "resumes %s after a run interruption instead of cancelling it",
    async (args) => {
      const checker = fakeChecker();
      const harness = createHarness({
        launchArgs: [],
        goalCheckerFactory: () => checker,
      });
      await harness.command(args);
      await harness.emit("agent_settled", { aborted: true });
      expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
      expect(harness.sendUserMessage).toHaveBeenLastCalledWith("original goal");
      expect(checker.dispose).not.toHaveBeenCalled();
      expect(checker.evaluate).not.toHaveBeenCalled();
      expect(harness.exec).not.toHaveBeenCalled();
      await harness.command("--focus another task");
      expect(harness.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("already running"),
        "warning",
      );
      await harness.command("cancel");
    },
  );

  it("cancels a working task, aborts the main run, and allows a new task", async () => {
    const harness = createHarness({ launchArgs: [] });
    await harness.command("--focus keep working");
    harness.isIdle.mockReturnValue(false);
    await harness.command(" cancel ");
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.setStatus).toHaveBeenLastCalledWith("task", undefined);
    await harness.emit("agent_settled", { aborted: true });
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    harness.isIdle.mockReturnValue(true);
    await harness.command("--focus new goal");
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith("new goal");
    await harness.command("cancel");
  });

  it("reports cancellation without an active task without aborting chat", async () => {
    const harness = createHarness();
    harness.isIdle.mockReturnValue(false);
    await harness.command("cancel");
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Task: no task is running.",
      "warning",
    );
    expect(harness.abort).not.toHaveBeenCalled();
    await harness.command("--help");
    expect(harness.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("/task cancel"),
      "info",
    );
  });

  it("allows chat during goal planning and queues implementation after the active chat run", async () => {
    const initialized = deferred<void>();
    const checker = fakeChecker();
    vi.mocked(checker.initialize).mockReturnValue(initialized.promise);
    const harness = createHarness({
      launchArgs: [],
      goalCheckerFactory: () => checker,
    });
    const starting = harness.command("--goal original goal");
    await vi.waitFor(() => expect(checker.initialize).toHaveBeenCalledOnce());
    await harness.emit("input", { source: "interactive" });
    await harness.emit("agent_settled", { aborted: false });
    expect(checker.evaluate).not.toHaveBeenCalled();
    expect(checker.dispose).not.toHaveBeenCalled();
    harness.isIdle.mockReturnValue(false);
    initialized.resolve();
    await starting;
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    harness.isIdle.mockReturnValue(true);
    await harness.emit("agent_settled", { aborted: false });
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith("original goal");
    expect(checker.evaluate).not.toHaveBeenCalled();
    await harness.command("cancel");
  });

  it.each(["planning", "checking"])(
    "cancels a goal during %s without a late continuation",
    async (phase) => {
      const operation = deferred<any>();
      const checker = fakeChecker();
      let signal: AbortSignal | undefined;
      const block = vi.fn((operationSignal: AbortSignal) => {
        signal = operationSignal;
        return operation.promise;
      });
      if (phase === "planning") checker.initialize = block;
      else checker.evaluate = block;
      const harness = createHarness({
        launchArgs: [],
        goalCheckerFactory: () => checker,
      });
      const starting = harness.command("--goal implement feature");
      let pending = starting;
      if (phase === "checking") {
        await starting;
        pending = harness.emit("agent_settled", { aborted: false });
      }
      await vi.waitFor(() => expect(block).toHaveBeenCalledOnce());
      const sent = harness.sendUserMessage.mock.calls.length;
      await harness.command("cancel");
      expect(signal?.aborted).toBe(true);
      expect(checker.dispose).toHaveBeenCalledOnce();
      expect(harness.unsubscribeInput).toHaveBeenCalledOnce();
      expect(harness.setWidget).toHaveBeenLastCalledWith(
        "task-goal-stream",
        undefined,
      );
      operation.resolve({ complete: false, feedback: "Late result" });
      await pending;
      await harness.emit("agent_settled", { aborted: false });
      expect(harness.sendUserMessage).toHaveBeenCalledTimes(sent);
    },
  );

  it("serializes goal evaluation when another chat run settles while it is checking", async () => {
    const evaluated = deferred<{ complete: boolean; feedback: string }>();
    const checker = fakeChecker();
    vi.mocked(checker.evaluate).mockReturnValue(evaluated.promise);
    const harness = createHarness({
      launchArgs: [],
      goalCheckerFactory: () => checker,
    });
    await harness.command("--goal original goal");
    const settling = harness.emit("agent_settled", { aborted: false });
    await harness.emit("input", { source: "interactive" });
    await harness.emit("agent_settled", { aborted: false });
    expect(checker.evaluate).toHaveBeenCalledOnce();
    harness.isIdle.mockReturnValue(false);
    evaluated.resolve({ complete: false, feedback: "Gap to address" });
    await settling;
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    harness.isIdle.mockReturnValue(true);
    await harness.emit("agent_settled", { aborted: false });
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Gap to address"),
    );
    expect(checker.evaluate).toHaveBeenCalledOnce();
    await harness.command("cancel");
  });

  it("discards pending task prompts on cancellation without leaving them in Pi's queue", async () => {
    const harness = createHarness({ launchArgs: [] });
    harness.isIdle.mockReturnValue(false);
    await harness.command("--focus pending task");
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    await harness.command("cancel");
    harness.isIdle.mockReturnValue(true);
    await harness.emit("agent_settled", { aborted: false });
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("shuts down a goal checker and its output pane", async () => {
    const checker = fakeChecker();
    const harness = createHarness({
      launchArgs: [],
      goalCheckerFactory: () => checker,
    });
    await harness.command("--goal implement feature");
    await harness.emit("session_shutdown");
    await harness.emit("session_shutdown");
    expect(checker.dispose).toHaveBeenCalledOnce();
    expect(harness.unsubscribeInput).toHaveBeenCalledOnce();
  });
});

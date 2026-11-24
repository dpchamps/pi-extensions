import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import taskExtension from "./index.js";
import type { GoalChecker } from "./goal-checker.js";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";

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
  const shortcuts = new Map<string, (ctx: ExtensionContext) => unknown>();
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
    registerShortcut: (
      key: string,
      { handler }: { handler: (ctx: ExtensionContext) => unknown },
    ) => shortcuts.set(key, handler),
    sendUserMessage,
    exec,
  } as unknown as ExtensionAPI;

  taskExtension(pi, options);

  const notify = vi.fn();
  const setStatus = vi.fn();
  let overlay: Component | undefined;
  const requestRender = vi.fn();
  const theme = { fg: (_color: string, text: string) => text };
  const setWidget = vi.fn();
  const custom = vi.fn(
    (factory) =>
      new Promise((resolve) => {
        overlay = factory(
          { terminal: { rows: 30 }, requestRender },
          theme,
          getKeybindings(),
          (result: unknown) => {
            overlay = undefined;
            resolve(result);
          },
        );
      }),
  );
  const select = vi.fn();
  const input = vi.fn();
  const editor = vi.fn();
  const confirm = vi.fn();
  const model = { provider: "test", id: "model", reasoning: true };
  const getAvailable = vi.fn(() => [
    model,
    {
      provider: "another",
      id: "reviewer",
      reasoning: true,
      thinkingLevelMap: { low: null, xhigh: "xhigh" },
    },
  ]);
  const isIdle = vi.fn(() => true);
  const abort = vi.fn();
  const compact = vi.fn((compactOptions: { onComplete?: () => void }) =>
    compactOptions.onComplete?.(),
  );
  const context = {
    cwd: "/workspace",
    hasUI: true,
    mode: "tui",
    model,
    thinkingLevel: "medium",
    modelRegistry: { getAvailable },
    ui: {
      notify,
      setStatus,
      setWidget,
      custom,
      select,
      input,
      editor,
      confirm,
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
    custom,
    select,
    input,
    editor,
    confirm,
    getAvailable,
    key: (data: string) => overlay?.handleInput?.(data),
    shortcut: (key: string) => shortcuts.get(key)?.(context),
    renderOverlay: () => overlay?.render(100).join("\n") ?? "",
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

const choose = (value: string) => (_title: string, options: string[]) =>
  options.find(
    (option) => option === value || option.startsWith(`${value} — `),
  );

describe("/task configure", () => {
  it("explains each task type when invoked with no arguments", async () => {
    const harness = createHarness();
    await harness.command("");
    expect(harness.select).toHaveBeenCalledExactlyOnceWith("Task type", [
      "oracle — Keep working until a command passes (e.g. npm test)",
      "focus — Keep exploring and iterating until you stop it or it reaches a run limit",
      "goal — Keep working until a separate reviewer verifies the result",
    ]);
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });
  it("searches reviewer models and only starts after confirming the multiline prompt", async () => {
    const goalCheckerFactory = vi.fn(() => fakeChecker());
    const harness = createHarness({ launchArgs: [], goalCheckerFactory });
    const prompt =
      "Fix the parser's escaping.\nKeep literal `\\n` and --flags intact.";
    const approval = deferred<boolean>();
    harness.select
      .mockImplementationOnce(choose("goal"))
      .mockImplementationOnce(choose("xhigh"));
    harness.editor.mockResolvedValue(prompt);
    harness.confirm.mockReturnValue(approval.promise);

    const configuring = harness.command("configure");
    await vi.waitFor(() =>
      expect(harness.renderOverlay()).toContain("Goal reviewer model"),
    );
    expect(harness.renderOverlay()).toContain("Same as session (test/model)");
    for (const key of "reviewer") harness.key(key);
    expect(harness.renderOverlay()).not.toContain("Same as session");
    expect(harness.renderOverlay()).toContain("another/reviewer");
    harness.key("\r");
    await vi.waitFor(() =>
      expect(harness.select).toHaveBeenLastCalledWith(
        "Goal reviewer thinking level",
        [
          "medium — Moderate reasoning",
          "off — No reasoning",
          "minimal — Very brief reasoning",
          "high — Deep reasoning",
          "xhigh — Extra-high reasoning",
        ],
      ),
    );
    await vi.waitFor(() =>
      expect(harness.confirm).toHaveBeenCalledWith(
        "Start this task?",
        `Type: goal\nReviewer: another/reviewer\nThinking level: xhigh\n\n${prompt}`,
      ),
    );
    expect(goalCheckerFactory).not.toHaveBeenCalled();
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    approval.resolve(true);
    await configuring;
    await vi.waitFor(() =>
      expect(harness.sendUserMessage).toHaveBeenCalledWith(prompt),
    );
    expect(goalCheckerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: "another", id: "reviewer" },
        thinkingLevel: "xhigh",
        prompt,
      }),
    );
    expect(harness.context.model).toMatchObject({
      provider: "test",
      id: "model",
    });
    expect(harness.context.thinkingLevel).toBe("medium");
    await harness.command("cancel");
  });

  it.each([
    ["oracle", "configure"],
    ["focus", ""],
  ])(
    "confirms a configured %s task and skips model selection (/task %s)",
    async (kind, args) => {
      const harness = createHarness({ launchArgs: [] });
      const verifier = 'printf "%s" "it\'s quoted"';
      harness.select.mockImplementationOnce(choose(kind));
      harness.input.mockResolvedValue(kind === "oracle" ? verifier : "1");
      harness.editor.mockResolvedValue("Baseline prompt");
      harness.confirm.mockResolvedValue(true);
      harness.exec.mockResolvedValue({ code: 0, killed: false });
      await harness.command(args);
      expect(harness.getAvailable).not.toHaveBeenCalled();
      expect(harness.sendUserMessage).toHaveBeenCalledWith("Baseline prompt");
      await harness.emit("agent_settled", { aborted: false });
      if (kind === "oracle")
        expect(harness.exec).toHaveBeenCalledWith(
          "bash",
          ["-c", verifier],
          expect.anything(),
        );
      else
        expect(harness.notify).toHaveBeenLastCalledWith(
          "Task focus: reached the limit of 1 run(s)",
          "info",
        );
    },
  );

  it("does not start a task when confirmation is declined", async () => {
    const harness = createHarness();
    harness.select.mockImplementationOnce(choose("focus"));
    harness.input.mockResolvedValue("");
    harness.editor.mockResolvedValue("Don't execute");
    harness.confirm.mockResolvedValue(false);
    await harness.command("configure");
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    await harness.command("--focus another prompt");
    expect(harness.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
      "another prompt",
    );
  });

  it("keeps the session model available in the RPC picker", async () => {
    const goalCheckerFactory = vi.fn(() => fakeChecker());
    const harness = createHarness({ launchArgs: [], goalCheckerFactory });
    Object.assign(harness.context, { mode: "rpc" });
    harness.select
      .mockImplementationOnce(choose("goal"))
      .mockResolvedValueOnce("Same as session (test/model)")
      .mockImplementationOnce(choose("low"));
    harness.editor.mockResolvedValue("Goal prompt");
    harness.confirm.mockResolvedValue(true);
    await harness.command("configure");
    expect(harness.select).toHaveBeenNthCalledWith(2, "Goal reviewer model", [
      "Same as session (test/model)",
      "another/reviewer",
    ]);
    expect(goalCheckerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: "test", id: "model" },
        thinkingLevel: "low",
      }),
    );
    expect(harness.custom).not.toHaveBeenCalled();
    await harness.command("cancel");
  });

  it("offers only off for a non-reasoning reviewer and exits if the choice is cancelled", async () => {
    const goalCheckerFactory = vi.fn(() => fakeChecker());
    const harness = createHarness({ launchArgs: [], goalCheckerFactory });
    Object.assign(harness.context, { mode: "rpc" });
    harness.getAvailable.mockReturnValue([
      { provider: "another", id: "reviewer", reasoning: false },
    ]);
    harness.select
      .mockImplementationOnce(choose("goal"))
      .mockResolvedValueOnce("another/reviewer");
    await harness.command("configure");
    expect(harness.select).toHaveBeenLastCalledWith(
      "Goal reviewer thinking level",
      ["off — No reasoning"],
    );
    expect(harness.editor).not.toHaveBeenCalled();
    expect(goalCheckerFactory).not.toHaveBeenCalled();
  });
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
    await vi.waitFor(() =>
      expect(order.slice(0, 2)).toEqual(["initialize", "send"]),
    );
    expect(harness.setWidget).not.toHaveBeenCalled();
    expect(harness.custom).not.toHaveBeenCalled();
    expect(harness.setStatus).toHaveBeenLastCalledWith(
      "task",
      expect.stringContaining("Ctrl+Alt+R reviewer"),
    );
    const viewing = harness.command("reviewer");
    expect(harness.renderOverlay()).toContain("Goal planner (following)");
    expect(harness.renderOverlay()).toContain("- [ ] Run integration tests");
    harness.key("\x1b");
    await viewing;

    await harness.emit("agent_settled", { aborted: false });
    expect(order).toContain("evaluate-incomplete");
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("The integration test still fails."),
    );

    await harness.emit("agent_settled", { aborted: false });
    await vi.waitFor(() => expect(checker.dispose).toHaveBeenCalledOnce());
    expect(order).toContain("evaluate-complete");
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
    await harness.command("--goal original goal");
    expect(checker.initialize).toHaveBeenCalledOnce();
    await harness.emit("input", { source: "interactive" });
    await harness.emit("agent_settled", { aborted: false });
    expect(checker.evaluate).not.toHaveBeenCalled();
    expect(checker.dispose).not.toHaveBeenCalled();
    harness.isIdle.mockReturnValue(false);
    initialized.resolve();
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "task",
        expect.stringContaining("task goal 1"),
      ),
    );
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
      await harness.command("--goal implement feature");
      if (phase === "checking") {
        await vi.waitFor(() =>
          expect(harness.sendUserMessage).toHaveBeenCalledOnce(),
        );
        await harness.emit("agent_settled", { aborted: false });
      }
      expect(block).toHaveBeenCalledOnce();
      const sent = harness.sendUserMessage.mock.calls.length;
      const viewing = harness.shortcut("ctrl+alt+r");
      expect(harness.renderOverlay()).not.toBe("");
      await harness.command("cancel");
      await viewing;
      expect(signal?.aborted).toBe(true);
      expect(checker.dispose).toHaveBeenCalledOnce();
      expect(harness.renderOverlay()).toBe("");
      operation.resolve({ complete: false, feedback: "Late result" });
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
    await vi.waitFor(() =>
      expect(harness.sendUserMessage).toHaveBeenCalledOnce(),
    );
    await harness.emit("agent_settled", { aborted: false });
    await harness.emit("input", { source: "interactive" });
    await harness.emit("agent_settled", { aborted: false });
    expect(checker.evaluate).toHaveBeenCalledOnce();
    harness.isIdle.mockReturnValue(false);
    evaluated.resolve({ complete: false, feedback: "Gap to address" });
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "task",
        expect.stringContaining("task goal 2"),
      ),
    );
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
    const viewing = harness.command("reviewer");
    expect(harness.renderOverlay()).not.toBe("");
    await harness.emit("session_shutdown");
    await harness.emit("session_shutdown");
    await viewing;
    expect(checker.dispose).toHaveBeenCalledOnce();
    expect(harness.renderOverlay()).toBe("");
  });
});

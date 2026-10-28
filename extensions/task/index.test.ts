import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import taskExtension from "./index.js";
import type { GoalChecker } from "./goal-checker.js";

type EventHandler = (event: any, ctx: ExtensionContext) => unknown;

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
      theme: { fg: (_color: string, text: string) => text },
    },
    getContextUsage: () => ({ tokens: 60, contextWindow: 100, percent: 60 }),
    compact,
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
    const checker: GoalChecker = {
      initialize: vi.fn(async () => {
        order.push("initialize");
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
      goalCheckerFactory: async () => checker,
    });
    harness.sendUserMessage.mockImplementation(() => order.push("send"));

    await harness.command("--goal implement checkout");
    expect(order.slice(0, 2)).toEqual(["initialize", "send"]);

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

  it("stops and aborts the active operation on interactive input", async () => {
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
    await harness.emit("input", { source: "interactive" });
    await settling;

    expect(harness.notify).toHaveBeenCalledWith("Task oracle: stopped", "info");
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
  });
});

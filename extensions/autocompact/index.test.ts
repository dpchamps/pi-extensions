import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import autocompact from "./index.js";
import { cacheLifetimeMs, compactionDelayMs } from "./cache.js";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
const model = (
  promptCache: Model<any>["promptCache"] = { short: 300, long: 3600 },
) =>
  ({
    provider: "test",
    id: "model",
    api: "openai-completions",
    promptCache,
  }) as Model<any>;

function harness(config?: unknown) {
  const handlers = new Map<string, Handler[]>();
  let command: {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  const entries: any[] = [];
  let sessionId = "session-one";
  let commands: { name: string; source: string }[] = [];
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn((customType: string, data: unknown) =>
    entries.push({ type: "custom", customType, data }),
  );
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: (_name: string, value: typeof command) => {
      command = value;
    },
    getCommands: () => commands,
    getSettings: () => ({ autocompact: config }),
    appendEntry,
    sendUserMessage,
  } as unknown as ExtensionAPI;
  autocompact(pi);
  const ctx = {
    model: model(),
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    compact: vi.fn((options) => options.onComplete?.({})),
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? [])
      result = await handler(event, ctx);
    return result;
  };
  const start = () => emit("session_start", { reason: "startup" });
  const run = async (
    duration = 0,
    stopReason = "stop",
    payload: unknown = {},
  ) => {
    await emit("agent_start");
    await emit("before_provider_request", { payload });
    await vi.advanceTimersByTimeAsync(duration);
    await emit("message_end", {
      message: {
        role: "assistant",
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        stopReason,
      },
    });
    await emit("agent_settled");
  };
  return {
    ctx,
    entries,
    emit,
    start,
    run,
    appendEntry,
    sendUserMessage,
    command: (args: string) => command.handler(args, ctx),
    clm: (source = "extension") => {
      commands = [{ name: "clm-compact", source }];
    },
    session: (id: string) => {
      sessionId = id;
    },
    settings: (value: unknown) => {
      config = value;
    },
    notify: vi.mocked(ctx.ui.notify),
    compact: vi.mocked(ctx.compact),
    idle: vi.mocked(ctx.isIdle),
    pending: vi.mocked(ctx.hasPendingMessages),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cache policy", () => {
  it("uses declared tiers and actual OpenAI retention instead of assuming every long tier is 24 hours", () => {
    expect(cacheLifetimeMs(model(), {}, "short")).toBe(300_000);
    expect(cacheLifetimeMs(model(), {}, "long")).toBe(3_600_000);
    expect(
      cacheLifetimeMs(model(), { prompt_cache_retention: "24h" }, "short"),
    ).toBe(3_600_000);
    expect(
      cacheLifetimeMs(model(), { prompt_cache_retention: "in_memory" }, "long"),
    ).toBe(300_000);
    expect(
      cacheLifetimeMs(
        model(),
        { prompt_cache_options: { ttl: "30m" } },
        "long",
      ),
    ).toBe(300_000);
    expect(
      cacheLifetimeMs(
        model(),
        { prompt_cache_options: { ttl: "12h" } },
        "short",
      ),
    ).toBe(3_600_000);
    expect(
      cacheLifetimeMs(model(), { prompt_cache_options: { mode: "explicit" } }),
    ).toBeUndefined();
  });

  it("reads Anthropic block-level and automatic cache control, conservatively using mixed TTLs", () => {
    const anthropic = { ...model(), api: "anthropic-messages" };
    const long = { cache_control: { type: "ephemeral", ttl: "1h" } };
    expect(cacheLifetimeMs(anthropic, long)).toBe(3_600_000);
    expect(
      cacheLifetimeMs(anthropic, {
        tools: [long],
        system: [long],
        messages: [{ content: [long] }],
      }),
    ).toBe(3_600_000);
    expect(
      cacheLifetimeMs(anthropic, {
        system: [long],
        messages: [{ content: [{ cache_control: { type: "ephemeral" } }] }],
      }),
    ).toBe(300_000);
    expect(cacheLifetimeMs(anthropic, {}, "long")).toBeUndefined();
  });

  it.each([0, -1, NaN, Infinity, Number.MAX_VALUE])(
    "rejects unusable TTL %s",
    (seconds) => {
      expect(
        cacheLifetimeMs(model({ short: seconds }), {}, "short"),
      ).toBeUndefined();
    },
  );

  it("does not guess missing tier metadata or schedule timers too close to expiry", () => {
    expect(cacheLifetimeMs(model({}), {})).toBeUndefined();
    expect(cacheLifetimeMs(model({ short: 300 }), {}, "long")).toBeUndefined();
    expect(compactionDelayMs(10_000)).toBeUndefined();
    expect(compactionDelayMs(300_000)).toBe(270_000);
    expect(compactionDelayMs(3_600_000)).toBe(3_540_000);
  });
});

describe("autocompact", () => {
  it("does nothing at factory load and defaults to off", async () => {
    const h = harness();
    expect(vi.getTimerCount()).toBe(0);
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.compact).not.toHaveBeenCalled();
    await h.command("");
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("off"),
      "info",
    );
  });

  it("requires explicit on and compacts only once per idle period", async () => {
    const h = harness();
    await h.start();
    await h.command("on");
    await h.run();
    await vi.advanceTimersByTimeAsync(269_999);
    expect(h.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.compact).toHaveBeenCalledTimes(1);
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).toHaveBeenCalledTimes(2);
  });

  it("schedules GPT-6.1 Sol on ChatGPT/Codex without catalog TTL metadata", async () => {
    const h = harness();
    h.ctx.model = {
      ...model({}),
      provider: "openai-codex",
      api: "openai-codex-responses",
      id: "gpt-6.1-sol",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    await h.start();
    await h.command("on");
    await h.run();
    await h.command("status");
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("cache TTL 1800s; Codex default (estimate)"),
      "info",
    );
    await vi.advanceTimersByTimeAsync(1_739_999);
    expect(h.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.compact).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it.each([true, { enabled: true }])(
    "accepts persistent config %j",
    async (config) => {
      const h = harness(config);
      await h.start();
      await h.run();
      await vi.advanceTimersByTimeAsync(270_000);
      expect(h.compact).toHaveBeenCalledOnce();
    },
  );

  it("saves explicit on/off across reload/resume, but not into a new/forked session", async () => {
    const h = harness(true);
    await h.start();
    await h.command("off");
    await h.emit("session_shutdown");
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).not.toHaveBeenCalled();
    await h.command("on");
    await h.emit("session_shutdown");
    h.settings(false);
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).toHaveBeenCalledOnce();
    h.session("forked-session");
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("does not enable if saving explicit consent fails", async () => {
    const h = harness();
    await h.start();
    h.appendEntry.mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(h.command("on")).rejects.toThrow("disk full");
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("counts from request start, not the end of a slow response", async () => {
    const h = harness(true);
    await h.start();
    await h.run(240_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("starts immediately when a run settles inside the pre-expiry margin", async () => {
    const h = harness(true);
    await h.start();
    await h.run(280_000);
    expect(h.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("does not start cold after a response takes longer than the lifetime", async () => {
    const h = harness(true);
    await h.start();
    await h.run(301_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("resets after actual activity and does not compact an active tool/streaming run", async () => {
    const h = harness(true);
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(250_000);
    await h.emit("agent_start");
    await h.emit("before_provider_request", { payload: {} });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(h.compact).not.toHaveBeenCalled();
    await h.emit("message_end", {
      message: {
        role: "assistant",
        provider: "test",
        model: "model",
        stopReason: "stop",
      },
    });
    await h.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(220_000);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it.each(["error", "aborted"])(
    "does not arm after an %s response",
    async (reason) => {
      const h = harness(true);
      await h.start();
      await h.run(0, reason);
      await vi.advanceTimersByTimeAsync(270_000);
      expect(h.compact).not.toHaveBeenCalled();
    },
  );

  it("does not infer a lifetime for a missing tier", async () => {
    const h = harness(true);
    h.ctx.model = model({});
    await h.start();
    await h.run();
    await h.command("status");
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("no usable cache lifetime"),
      "info",
    );
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("turning off cancels the pending timer", async () => {
    const h = harness(true);
    await h.start();
    await h.run();
    await h.command("off");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("enabling while idle uses the observed request clock, not a new full TTL", async () => {
    const h = harness();
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(260_000);
    await h.command("on");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it.each([
    "model_select",
    "session_tree",
    "session_before_compact",
    "input",
    "session_shutdown",
  ])("disarms for %s", async (event) => {
    const h = harness(true);
    await h.start();
    await h.run();
    await h.emit(event);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("defers for queued messages and compaction already in progress", async () => {
    const h = harness(true);
    await h.start();
    await h.run();
    h.pending.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).not.toHaveBeenCalled();
    h.pending.mockReturnValue(false);
    h.idle.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.compact).not.toHaveBeenCalled();
    h.idle.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("does not interrupt a blocking UI dialog", async () => {
    const h = harness(true);
    await h.start();
    await h.run();
    await h.emit("ui_prompt_start");
    await vi.advanceTimersByTimeAsync(275_000);
    expect(h.compact).not.toHaveBeenCalled();
    await h.emit("ui_prompt_end");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("does not run a stale timer after machine sleep", async () => {
    const h = harness(true);
    await h.start();
    await h.run();
    vi.setSystemTime(400_000);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("prefers the CLM extension command and suppresses timers from its own run", async () => {
    const h = harness(true);
    h.clm();
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.sendUserMessage).toHaveBeenCalledExactlyOnceWith("/clm-compact", {
      expandPromptTemplates: true,
    });
    expect(h.compact).not.toHaveBeenCalled();
    await h.emit("input", { source: "extension" });
    await h.run();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.sendUserMessage).toHaveBeenCalledOnce();
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a prompt named clm-compact for the extension", async () => {
    const h = harness(true);
    h.clm("prompt");
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.compact).toHaveBeenCalledOnce();
    expect(h.sendUserMessage).not.toHaveBeenCalled();
  });

  it("reports a CLM refusal once, with no automatic native fallback or retry", async () => {
    const h = harness(true);
    h.clm();
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("did not start"),
      "warning",
    );
    expect(h.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.sendUserMessage).toHaveBeenCalledOnce();
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("reports native errors without retrying, and ignores callbacks after shutdown", async () => {
    const h = harness(true);
    let fail!: (error: Error) => void;
    h.compact.mockImplementation((options) => {
      fail = options!.onError!;
    });
    await h.start();
    await h.run();
    await vi.advanceTimersByTimeAsync(270_000);
    fail(new Error("too small"));
    expect(h.notify).toHaveBeenLastCalledWith(
      "Autocompact failed: too small",
      "warning",
    );
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.compact).toHaveBeenCalledOnce();
    await h.emit("session_shutdown");
    h.notify.mockClear();
    fail(new Error("late"));
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("stops idle warming only while enabled", async () => {
    const h = harness();
    await h.start();
    expect(await h.emit("cache_warming_decision")).toBeUndefined();
    await h.command("on");
    expect(await h.emit("cache_warming_decision")).toEqual({ action: "stop" });
    h.idle.mockReturnValue(false);
    expect(await h.emit("cache_warming_decision")).toBeUndefined();
  });
});

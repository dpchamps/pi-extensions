import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lazyStream } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import autocompact from "../extensions/autocompact/index.js";

let cwd: string;
let sessions: AgentSession[];
let errors: unknown[];
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-autocompact-"));
  sessions = [];
  errors = [];
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const session of sessions) {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
  vi.useRealTimers();
  await rm(cwd, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

async function createHarness(
  options: {
    extensions?: ExtensionFactory[];
    manager?: SessionManager;
    enabled?: boolean;
    codex?: boolean;
    deepseek?: boolean;
  } = {},
) {
  const manager = options.manager ?? SessionManager.inMemory(cwd);
  const faux = options.codex
    ? fauxProvider({
        provider: "openai-codex",
        api: "openai-codex-responses",
        models: [{ id: "gpt-6.1-sol" }],
      })
    : options.deepseek
      ? fauxProvider({
          provider: "deepseek",
          api: "openai-completions",
          models: [{ id: "deepseek-chat" }],
        })
      : fauxProvider();
  if (options.codex)
    faux.getModel().baseUrl = "https://chatgpt.com/backend-api";
  else if (options.deepseek)
    faux.getModel().baseUrl = "https://api.deepseek.com";
  else faux.getModel().promptCache = { short: 15 };
  // Faux emits responses but has no wire payload. Exercise the actual SDK
  // onPayload -> before_provider_request path rather than mocking the runner.
  const stream = faux.provider.streamSimple.bind(faux.provider);
  faux.provider.streamSimple = (model, context, streamOptions) =>
    lazyStream(model, async () => {
      await streamOptions?.onPayload?.({ model: model.id }, model);
      return stream(model, context, streamOptions);
    });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 },
    retry: { enabled: false },
    cacheWarming: "off",
    ...{ autocompact: options.enabled ?? false },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.registerProvider(faux.provider);
      },
      autocompact,
      ...(options.extensions ?? []),
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    model: faux.getModel(),
    tools: [],
  });
  sessions.push(session);
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error),
  });
  return { session, manager, faux };
}

const summary: ExtensionFactory = (pi) => {
  pi.on("session_before_compact", (event) => ({
    compaction: {
      summary: "Idle session summary.",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  }));
};

function userMessages(session: AgentSession): string[] {
  return session.messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : [
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
        ],
  );
}

describe("autocompact through Pi's real runtime", () => {
  it.each(["codex", "deepseek"] as const)(
    "compacts %s without any promptCache override",
    async (provider) => {
      const { session, manager, faux } = await createHarness({
        [provider]: true,
        extensions: [summary],
      });
      expect(session.model?.promptCache).toBeUndefined();
      faux.setResponses([fauxAssistantMessage("Done.")]);
      await session.prompt("Work on this task.");
      await session.prompt("/autocompact on");
      await vi.advanceTimersByTimeAsync(1_739_999);
      expect(
        manager.getEntries().some((entry) => entry.type === "compaction"),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        manager.getEntries().filter((entry) => entry.type === "compaction"),
      ).toHaveLength(1);
      expect(faux.state.callCount).toBe(1);
      expect(session.model?.promptCache).toBeUndefined();
    },
  );

  it("dispatches native compaction, not literal slash-command text, and rearms only after real work", async () => {
    const { session, manager, faux } = await createHarness({
      extensions: [summary],
    });
    faux.setResponses([
      fauxAssistantMessage("Done."),
      fauxAssistantMessage("More work done."),
    ]);
    await session.prompt("Work on this task.");
    await session.prompt("/autocompact on");
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      manager.getEntries().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    expect(faux.state.callCount).toBe(1);
    expect(userMessages(session)).not.toContain("/compact");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      manager.getEntries().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    await session.prompt("Another task.");
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      manager.getEntries().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(2);
  });

  it("executes a registered clm-compact command and does not compact its resulting tool turns again", async () => {
    const handler = vi.fn();
    const clm: ExtensionFactory = (pi) => {
      pi.registerCommand("clm-compact", {
        description: "Test CLM command",
        handler: async (_args, ctx) => {
          await ctx.waitForIdle();
          handler();
          pi.sendUserMessage("Compress the live context now.");
        },
      });
      pi.registerTool({
        name: "noop",
        label: "No-op",
        description: "No-op",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: undefined,
        }),
      });
    };
    const { session, manager, faux } = await createHarness({
      enabled: true,
      extensions: [clm],
    });
    session.setActiveToolsByName(["noop"]);
    faux.setResponses([
      fauxAssistantMessage("Done."),
      fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Context compressed."),
    ]);
    await session.prompt("Work on this task.");
    await vi.advanceTimersByTimeAsync(5000);
    // Nested command and model dispatch are asynchronous, so allow I/O/microtasks
    // to complete without advancing to another expiry.
    await vi.waitFor(() => expect(faux.state.callCount).toBe(3));
    await session.waitForIdle();
    expect(handler).toHaveBeenCalledOnce();
    expect(userMessages(session)).toContain("Compress the live context now.");
    expect(userMessages(session)).not.toContain("/clm-compact");
    expect(
      manager.getEntries().some((entry) => entry.type === "compaction"),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledOnce();
    expect(faux.state.callCount).toBe(3);
  });

  it("restores session opt-in in a fresh extension runtime without assuming the old cache is still warm", async () => {
    const first = await createHarness();
    await first.session.prompt("/autocompact on");
    await first.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "reload",
    });
    first.session.dispose();
    sessions = sessions.filter((session) => session !== first.session);
    const restored = await createHarness({
      manager: first.manager,
      extensions: [summary],
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restored.faux.state.callCount).toBe(0);
    restored.faux.setResponses([fauxAssistantMessage("Done.")]);
    await restored.session.prompt("Fresh task.");
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      restored.manager
        .getEntries()
        .filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
  });

  it("silently drops a timer when an SDK host disposes without a shutdown event", async () => {
    const { session, faux } = await createHarness({ enabled: true });
    faux.setResponses([fauxAssistantMessage("Done.")]);
    await session.prompt("Task.");
    session.dispose();
    sessions = [];
    await vi.advanceTimersByTimeAsync(5000);
    expect(faux.state.callCount).toBe(1);
  });
});

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
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
import listen from "./index.js";
import { connect, deferred, exchange } from "./test-helpers.js";

let cwd: string;
let runtime: AgentSessionRuntime | undefined;
let errors: unknown[];
let releases: Array<() => void>;
const notify = vi.fn();
const ui = new Proxy(
  { notify },
  {
    get: (object, key) =>
      key in object ? object[key as keyof typeof object] : () => {},
  },
) as unknown as ExtensionUIContext;

beforeEach(() => {
  cwd = fs.mkdtempSync(join(tmpdir(), "listen-session-test-"));
  errors = [];
  releases = [];
  notify.mockReset();
});
afterEach(async () => {
  for (const release of releases) release();
  if (runtime) {
    runtime.session.clearQueue();
    await runtime.session.abort();
    await runtime.dispose();
  }
  runtime = undefined;
  fs.rmSync(cwd, { recursive: true, force: true });
  expect(errors).toEqual([]);
});
function gate() {
  const result = deferred<void>();
  releases.push(() => result.resolve());
  return result;
}

async function harness(extensions: ExtensionFactory[] = [], retry = false) {
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
        retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 },
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => pi.registerProvider(faux.provider),
          (pi) => listen(pi, { tempDirectory: cwd, dispatchTimeoutMs: 30 }),
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
  const bind = async () =>
    runtime!.session.bindExtensions({
      mode: "rpc",
      uiContext: ui,
      onError: (error) => errors.push(error),
      commandContextActions: {
        waitForIdle: () => runtime!.session.waitForIdle(),
        newSession: (options) => runtime!.newSession(options),
        switchSession: (file, options) => runtime!.switchSession(file, options),
        fork: (id, options) => runtime!.fork(id, options),
        navigateTree: (id, options) =>
          runtime!.session.navigateTree(id, options),
        reload: () => runtime!.session.reload(),
      },
    });
  runtime.setRebindSession(bind);
  await bind();
  const command = (args = "") =>
    runtime!.session.prompt(`/listen${args ? ` ${args}` : ""}`);
  const start = async () => {
    await command();
    const content = notify.mock.calls.at(-1)![0] as string;
    const directory = content.split("\n")[0];
    return { directory, socket: join(directory, "inbox.sock") };
  };
  return { faux, command, start };
}

describe("/listen with real Pi lifecycle and local faux provider", () => {
  it("is opt-in, idempotent, and status prints the directory without starting a listener", async () => {
    const { command, start } = await harness();
    await command("status");
    expect(notify).toHaveBeenLastCalledWith("Listen: not listening.", "info");
    const first = await start();
    await command("status");
    expect(notify).toHaveBeenLastCalledWith(first.directory, "info");
    expect(await start()).toEqual(first);
    await command("invalid");
    expect(notify).toHaveBeenLastCalledWith(
      "Listen: Usage: /listen [status|stop]",
      "error",
    );
    await command("stop");
    await command("stop");
    expect(fs.existsSync(first.directory)).toBe(false);
    await command("status");
    expect(notify).toHaveBeenLastCalledWith("Listen: not listening.", "info");
  });

  it("submits real user input, returns only final text, and deduplicates completed requests", async () => {
    let accidentalCommand = 0;
    const { faux, start } = await harness([
      (pi) =>
        pi.registerCommand("danger", {
          description: "test",
          handler: async () => {
            accidentalCommand++;
          },
        }),
    ]);
    faux.setResponses([
      fauxAssistantMessage([
        fauxThinking("private reasoning"),
        fauxText("Final reply"),
      ]),
    ]);
    const endpoint = await start();
    const request = {
      op: "submit",
      id: "handoff-1",
      message: "/danger",
      wait: true,
    };
    const messages = await exchange(endpoint.socket, request);
    expect(messages[0]).toMatchObject({ type: "received", status: "queued" });
    expect(messages.at(-1)).toMatchObject({
      type: "response",
      status: "completed",
      message: "Final reply",
    });
    expect(JSON.stringify(messages)).not.toContain("private reasoning");
    expect(JSON.stringify(messages)).not.toContain("pi-listen:");
    expect(accidentalCommand).toBe(0);
    expect(
      runtime!.session.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("/danger"),
      ),
    ).toBe(true);
    const recovered = await exchange(endpoint.socket, request);
    expect(recovered).toEqual([messages.at(-1)]);
    expect(faux.state.callCount).toBe(1);
  });

  it("waits behind ordinary work and serializes external requests without returning the ordinary response", async () => {
    const pause = gate();
    const { faux, start } = await harness();
    faux.setResponses([
      async () => {
        await pause.promise;
        return fauxAssistantMessage("Unrelated human response");
      },
      fauxAssistantMessage("First handoff response"),
      fauxAssistantMessage("Second handoff response"),
    ]);
    const endpoint = await start();
    const human = runtime!.session.prompt("Ordinary human request");
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    const first = connect(endpoint.socket, {
      op: "submit",
      id: "first",
      message: "First handoff",
    });
    await first.first;
    const second = connect(endpoint.socket, {
      op: "submit",
      id: "second",
      message: "Second handoff",
    });
    await second.first;
    expect(
      (await exchange(endpoint.socket, { op: "get", id: "first" }))[0].status,
    ).toBe("queued");
    expect(faux.state.callCount).toBe(1);
    pause.resolve();
    await human;
    expect((await first.done).at(-1)?.message).toBe("First handoff response");
    expect((await second.done).at(-1)?.message).toBe("Second handoff response");
    expect(faux.state.callCount).toBe(3);
  });

  it("recovers from a disconnected sender by reconnecting while work is still running", async () => {
    const pause = gate();
    const { faux, start } = await harness();
    faux.setResponses([
      async () => {
        await pause.promise;
        return fauxAssistantMessage("Recovered answer");
      },
    ]);
    const endpoint = await start();
    const original = connect(endpoint.socket, {
      op: "submit",
      id: "recover",
      message: "work",
    });
    await original.first;
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    original.socket.destroy();
    const reattached = connect(endpoint.socket, {
      op: "get",
      id: "recover",
      wait: true,
    });
    expect(await reattached.first).toMatchObject({ status: "running" });
    pause.resolve();
    expect((await reattached.done).at(-1)).toMatchObject({
      status: "completed",
      message: "Recovered answer",
    });
    expect(faux.state.callCount).toBe(1);
  });

  it("retains completed replies across /reload but never automatically starts listening again", async () => {
    const { faux, start, command } = await harness();
    faux.setResponses([fauxAssistantMessage("Saved answer")]);
    const first = await start();
    await exchange(first.socket, {
      op: "submit",
      id: "saved",
      message: "work",
    });
    await runtime!.session.reload();
    expect(fs.existsSync(first.directory)).toBe(false);
    await command("status");
    expect(notify).toHaveBeenLastCalledWith("Listen: not listening.", "info");
    const second = await start();
    expect(second.directory).not.toBe(first.directory);
    expect(
      (await exchange(second.socket, { op: "get", id: "saved" }))[0],
    ).toMatchObject({ status: "completed", message: "Saved answer" });
    expect(faux.state.callCount).toBe(1);
  });

  it("stops on session replacement, scopes IDs to the session, and recovers when the original session resumes", async () => {
    const { faux, start, command } = await harness();
    faux.setResponses([fauxAssistantMessage("Original session answer")]);
    const first = await start();
    await exchange(first.socket, {
      op: "submit",
      id: "same-id",
      message: "work",
    });
    const originalFile = runtime!.session.sessionManager.getSessionFile()!;
    await runtime!.newSession();
    expect(fs.existsSync(first.directory)).toBe(false);
    await command("status");
    expect(notify).toHaveBeenLastCalledWith("Listen: not listening.", "info");
    const other = await start();
    expect(
      (await exchange(other.socket, { op: "get", id: "same-id" }))[0].code,
    ).toBe("not_found");
    await runtime!.switchSession(originalFile);
    const resumed = await start();
    expect(
      (await exchange(resumed.socket, { op: "get", id: "same-id" }))[0],
    ).toMatchObject({
      status: "completed",
      message: "Original session answer",
    });
    expect(faux.state.callCount).toBe(1);
  });

  it("stops listening on a fork without inheriting request IDs", async () => {
    const { faux, start, command } = await harness();
    faux.setResponses([fauxAssistantMessage("answer")]);
    const first = await start();
    await exchange(first.socket, {
      op: "submit",
      id: "parent",
      message: "work",
    });
    const user = runtime!.session.sessionManager
      .getBranch()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )!;
    await runtime!.fork(user.id);
    expect(fs.existsSync(first.directory)).toBe(false);
    await command("status");
    expect(notify).toHaveBeenLastCalledWith("Listen: not listening.", "info");
    const fork = await start();
    expect(
      (await exchange(fork.socket, { op: "get", id: "parent" }))[0].code,
    ).toBe("not_found");
  });

  it("interrupts pending work on stop, does not abort the Pi run, and never replays it", async () => {
    const pause = gate();
    const { faux, start, command } = await harness();
    faux.setResponses([
      async () => {
        await pause.promise;
        return fauxAssistantMessage("Late response");
      },
    ]);
    const first = await start();
    const waiting = connect(first.socket, {
      op: "submit",
      id: "active",
      message: "work",
    });
    await waiting.first;
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    await command("stop");
    expect((await waiting.done).at(-1)).toMatchObject({
      status: "interrupted",
    });
    expect(runtime!.session.isStreaming).toBe(true);
    const second = await start();
    expect(
      (
        await exchange(second.socket, {
          op: "submit",
          id: "active",
          message: "work",
        })
      )[0].status,
    ).toBe("interrupted");
    pause.resolve();
    await runtime!.session.waitForIdle();
    expect(faux.state.callCount).toBe(1);
  });

  it("does not leak answers after unrelated user input takes over the shared run", async () => {
    const pause = gate();
    const { faux, start } = await harness();
    faux.setResponses([
      async () => {
        await pause.promise;
        return fauxAssistantMessage("Handoff response before steering");
      },
      fauxAssistantMessage("Private human answer"),
    ]);
    const endpoint = await start();
    const handoff = connect(endpoint.socket, {
      op: "submit",
      id: "handoff",
      message: "work",
    });
    await handoff.first;
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    await runtime!.session.prompt("Unrelated private human request", {
      streamingBehavior: "steer",
    });
    pause.resolve();
    const result = (await handoff.done).at(-1)!;
    expect(result.status).toBe("interrupted");
    expect(result.message).toBeUndefined();
    await runtime!.session.waitForIdle();
  });

  it("honors downstream message replacement/redaction before storing a reply", async () => {
    const { faux, start } = await harness([
      (pi) => {
        pi.on("message_end", (event) => {
          if (event.message.role === "assistant")
            return {
              message: {
                ...event.message,
                content: [{ type: "text", text: "Redacted answer" }],
              },
            };
        });
      },
    ]);
    faux.setResponses([fauxAssistantMessage("Secret original")]);
    const endpoint = await start();
    const result = await exchange(endpoint.socket, {
      op: "submit",
      id: "redacted",
      message: "work",
    });
    expect(result.at(-1)).toMatchObject({
      status: "completed",
      message: "Redacted answer",
    });
    expect(JSON.stringify(result)).not.toContain("Secret original");
  });

  it("waits for automatic retries rather than replying at the first low-level agent_end", async () => {
    let ends = 0;
    const { faux, start } = await harness(
      [
        (pi) => {
          pi.on("agent_end", () => {
            ends++;
          });
        },
      ],
      true,
    );
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "429 rate limit exceeded",
      }),
      fauxAssistantMessage("Recovered after retry"),
    ]);
    const endpoint = await start();
    const messages = await exchange(endpoint.socket, {
      op: "submit",
      id: "retry",
      message: "work",
    });
    expect(messages.at(-1)).toMatchObject({
      status: "completed",
      message: "Recovered after retry",
    });
    expect(
      messages.filter((message) => message.type === "response"),
    ).toHaveLength(1);
    expect(ends).toBeGreaterThanOrEqual(2);
  });

  it("waits for actionable-boundary continuations and returns their final answer", async () => {
    let continued = false;
    const { faux, start } = await harness([
      (pi) => {
        pi.on("agent_before_settle", () => {
          if (continued) return;
          continued = true;
          return {
            entries: [
              {
                type: "custom_message",
                customType: "test-continuation",
                content: "Finish the remaining work",
                display: false,
              },
            ],
            continue: true,
          };
        });
      },
    ]);
    faux.setResponses([
      fauxAssistantMessage("Intermediate answer"),
      fauxAssistantMessage("Really finished"),
    ]);
    const endpoint = await start();
    const messages = await exchange(endpoint.socket, {
      op: "submit",
      id: "continue",
      message: "work",
    });
    expect(messages.at(-1)).toMatchObject({
      status: "completed",
      message: "Really finished",
    });
    expect(faux.state.callCount).toBe(2);
  });

  it("does not return an unrelated answer when an input extension removes the request identity", async () => {
    const { faux, start } = await harness([
      (pi) => {
        pi.on("input", (event) => {
          if (event.source === "extension")
            return { action: "transform", text: "Different input" };
        });
      },
    ]);
    faux.setResponses([fauxAssistantMessage("Answer to transformed input")]);
    const endpoint = await start();
    const messages = await exchange(endpoint.socket, {
      op: "submit",
      id: "transformed",
      message: "work",
    });
    expect(messages.at(-1)).toMatchObject({ status: "failed" });
    expect(messages.at(-1)?.message).toBeUndefined();
  });

  it("reports input interception without hanging forever or attributing later responses to it", async () => {
    const { faux, start } = await harness([
      (pi) => {
        pi.on("input", (event) => {
          if (event.source === "extension") return { action: "handled" };
        });
      },
    ]);
    const endpoint = await start();
    const result = await exchange(endpoint.socket, {
      op: "submit",
      id: "handled",
      message: "work",
    });
    expect(result.at(-1)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("did not consume"),
    });
    expect(faux.state.callCount).toBe(0);
  });

  it("records failed and aborted model work without exposing private partial text", async () => {
    const pause = gate();
    const { faux, start } = await harness();
    faux.setResponses([
      fauxAssistantMessage("Partial text", {
        stopReason: "error",
        errorMessage: "Provider failed",
      }),
      async () => {
        await pause.promise;
        return fauxAssistantMessage("Late partial text");
      },
    ]);
    const endpoint = await start();
    const failure = await exchange(endpoint.socket, {
      op: "submit",
      id: "failed",
      message: "work",
    });
    expect(failure.at(-1)).toMatchObject({
      status: "failed",
      error: "Provider failed",
    });
    expect(failure.at(-1)?.message).toBeUndefined();
    const aborted = connect(endpoint.socket, {
      op: "submit",
      id: "aborted",
      message: "more work",
    });
    await aborted.first;
    await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
    const aborting = runtime!.session.abort();
    pause.resolve();
    await aborting;
    expect((await aborted.done).at(-1)).toMatchObject({
      status: "interrupted",
    });
  });
});

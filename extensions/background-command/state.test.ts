import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  SessionManager,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inheritedArgs, hostInvocation } from "./launch.js";
import { PromptTracker } from "./prompt.js";
import { forkReplaySession, promptContent } from "./runner.js";
import { BackgroundStore, type BackgroundTask } from "./store.js";
import { BackgroundSupervisor, sharedSupervisor } from "./supervisor.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "background-state-test-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const user = (content: UserMessage["content"], timestamp = 1): UserMessage => ({
  role: "user",
  content,
  timestamp,
});

describe("branch snapshots and structured prompts", () => {
  it("persists only the active path before the replayed request, including across reopen", async () => {
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    const ancestor = manager.appendMessage(user("earlier"));
    manager.appendMessage(user("abandoned branch", 2));
    manager.branch(ancestor);
    const prior = manager.appendMessage(fauxAssistantMessage("active reply"));
    const id = manager.appendMessage(user("current", 3));
    manager.appendMessage(
      fauxAssistantMessage("partial", { stopReason: "aborted" }),
    );
    const request = manager.getEntry(id) as SessionMessageEntry;
    const file = await forkReplaySession(manager, request, cwd);
    const reopened = SessionManager.open(file);
    expect(reopened.getLeafId()).toBe(prior);
    expect(reopened.getEntries()).toHaveLength(2);
    expect(reopened.getHeader()?.parentSession).toBe(manager.getSessionFile());
    expect(reopened.getSessionId()).not.toBe(manager.getSessionId());
    expect(manager.getEntries()).toHaveLength(5);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("materializes an empty fork for a root request and rejects off-branch requests", async () => {
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    const root = manager.appendMessage(user("first"));
    const request = manager.getEntry(root) as SessionMessageEntry;
    const file = await forkReplaySession(manager, request, cwd);
    expect(SessionManager.open(file).getEntries()).toEqual([]);
    manager.resetLeaf();
    manager.appendMessage(user("other root", 2));
    await expect(forkReplaySession(manager, request, cwd)).rejects.toThrow(
      "active branch",
    );
  });

  it("preserves image-only and mixed prompts without trimming significant whitespace", () => {
    const manager = SessionManager.inMemory(cwd);
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "YWJj",
    };
    const mixed = manager.appendMessage(
      user([{ type: "text", text: "  inspect\n" }, image]),
    );
    expect(
      promptContent(manager.getEntry(mixed) as SessionMessageEntry),
    ).toEqual({ text: "  inspect\n", images: [image] });
    const imageOnly = manager.appendMessage(user([image]));
    expect(
      promptContent(manager.getEntry(imageOnly) as SessionMessageEntry),
    ).toEqual({ text: "", images: [image] });
  });
});

describe("PromptTracker", () => {
  it.each(["interactive", "rpc"] as const)(
    "tracks a live %s request using input provenance",
    (source) => {
      const tracker = new PromptTracker();
      const manager = SessionManager.inMemory(cwd);
      tracker.input(source, false);
      tracker.begin("user");
      const message = user("expanded and transformed request");
      tracker.message(message);
      const id = manager.appendMessage(message);
      expect(tracker.current(manager)?.id).toBe(id);
      tracker.reset();
      expect(tracker.current(manager)).toBeUndefined();
    },
  );

  it("rejects extension/custom/queued/multiple-user/abandoned/restored requests", () => {
    const tracker = new PromptTracker();
    const manager = SessionManager.inMemory(cwd);
    const first = manager.appendMessage(user("old"));
    const message = user("new", 2);
    const track = () => {
      tracker.input("interactive", false);
      tracker.begin("user");
      tracker.message(message);
    };
    manager.appendMessage(message);
    expect(tracker.current(manager)).toBeUndefined(); // restored history is not provenance
    tracker.input("extension", false);
    tracker.begin("user");
    tracker.message(message);
    expect(tracker.current(manager)).toBeUndefined();
    tracker.input("interactive", false);
    tracker.begin("custom");
    tracker.message(message);
    expect(tracker.current(manager)).toBeUndefined();
    track();
    tracker.input("interactive", true);
    expect(tracker.current(manager)).toBeUndefined();
    track();
    tracker.message(user("extra", 3));
    expect(tracker.current(manager)).toBeUndefined();
    track();
    manager.branch(first);
    expect(tracker.current(manager)).toBeUndefined();
  });
});

function task(
  id: string,
  overrides: Partial<BackgroundTask> = {},
): BackgroundTask {
  return {
    id,
    client: {
      isAlive: () => true,
      start: async () => {},
      prompt: async () => "started",
      stop: async () => {},
    },
    sessionFile: `${id}.jsonl`,
    parentSessionFile: "foreground.jsonl",
    sourceEntryId: `entry-${id}`,
    cwd,
    firstPrompt: id,
    startedAt: new Date(Number(id.replace(/\D/g, "")) || 0),
    killed: false,
    isStreaming: true,
    ...overrides,
  };
}

describe("BackgroundStore", () => {
  it("detects dead clients even without an exit event", () => {
    const store = new BackgroundStore();
    const dead = task("bg-1");
    dead.client.isAlive = () => false;
    expect(store.statusOf(dead)).toBe("killed");
    expect(store.statusOf(task("bg-2", { isStreaming: false }))).toBe("paused");
    expect(store.statusOf(task("bg-3", { killed: true }))).toBe("killed");
  });

  it("keeps resumed ancestors for descendants without making them actionable tasks", () => {
    const store = new BackgroundStore();
    const parent = task(store.allocId());
    store.register(parent);
    store.archive(parent.id);
    expect(store.all()).toEqual([]);
    const child = task(store.allocId(), {
      parentSessionFile: parent.sessionFile,
    });
    store.register(child);
    expect(store.tree()).toMatchObject([
      {
        archived: true,
        task: { id: parent.id },
        children: [{ archived: false, task: { id: child.id } }],
      },
    ]);
    expect(
      store.wasDetached(parent.parentSessionFile, parent.sourceEntryId),
    ).toBe(true);
    expect(store.get(parent.id)).toBeUndefined();
    store.remove(child.id);
    expect(store.tree()).toEqual([]);
  });

  it("retains ancestor context under filters and tolerates cycles", () => {
    const store = new BackgroundStore();
    store.register(task("bg-1"));
    store.register(
      task("bg-2", { parentSessionFile: "bg-1.jsonl", isStreaming: false }),
    );
    expect(
      store.tree((item) => store.statusOf(item) === "paused")[0].children[0]
        .task.id,
    ).toBe("bg-2");
    const cyclic = new BackgroundStore();
    cyclic.register(task("bg-1", { parentSessionFile: "bg-2.jsonl" }));
    cyclic.register(task("bg-2", { parentSessionFile: "bg-1.jsonl" }));
    expect(cyclic.tree()).toHaveLength(2);
  });
});

describe("process supervisor", () => {
  it("keeps the same supervisor even when the extension module is reloaded", async () => {
    const original = sharedSupervisor();
    vi.resetModules();
    expect((await import("./supervisor.js")).sharedSupervisor()).toBe(original);
  });

  it("installs process-exit fallback only when a command registers a task and removes it after shutdown", async () => {
    const supervisor = new BackgroundSupervisor();
    const before = new Set(process.listeners("exit"));
    const record = task("bg-1");
    record.client.terminate = vi.fn();
    supervisor.register(record);
    supervisor.register(record);
    const hooks = process
      .listeners("exit")
      .filter((listener) => !before.has(listener));
    expect(hooks).toHaveLength(1);
    hooks[0](0); // invoke just our fallback, never emit process.exit in the test host
    expect(record.client.terminate).toHaveBeenCalledTimes(1);
    await supervisor.shutdown();
    expect(process.listeners("exit")).not.toContain(hooks[0]);
  });

  it("has a stable global identity, queues notices, and safely rebinds subscribers", () => {
    expect(sharedSupervisor()).toBe(sharedSupervisor());
    const supervisor = new BackgroundSupervisor();
    supervisor.changed({ message: "between sessions", level: "warning" });
    const first = vi.fn();
    const unsubscribe = supervisor.subscribe(first);
    expect(first).toHaveBeenCalledWith({
      message: "between sessions",
      level: "warning",
    });
    unsubscribe();
    supervisor.changed();
    expect(first).toHaveBeenCalledTimes(1);
    supervisor.subscribe(() => {
      throw new Error("stale");
    });
    expect(() => supervisor.changed()).not.toThrow();
  });

  it("serializes mutations and cleans every child on quit, even if one stop fails", async () => {
    const supervisor = new BackgroundSupervisor();
    let release!: () => void;
    const operation = supervisor.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    await expect(supervisor.exclusive(async () => {})).rejects.toThrow(
      "in progress",
    );
    const a = task("bg-1"),
      b = task("bg-2");
    a.client.stop = vi.fn(async () => {
      throw new Error("cannot terminate");
    });
    b.client.stop = vi.fn(async () => {});
    supervisor.store.register(a);
    supervisor.store.register(b);
    const shutdown = supervisor.shutdown();
    expect(b.client.stop).not.toHaveBeenCalled();
    release();
    await operation;
    await expect(shutdown).rejects.toThrow("cannot terminate");
    expect(a.client.stop).toHaveBeenCalledTimes(1);
    expect(b.client.stop).toHaveBeenCalledTimes(1);
    await expect(supervisor.exclusive(async () => {})).rejects.toThrow(
      "shutting down",
    );
  });
});

describe("launch configuration", () => {
  it("uses the host installation instead of a PATH lookup", () => {
    const invocation = hostInvocation();
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toMatch(/pi-coding-agent\/dist\/cli\.js$/);
    expect(hostInvocation("/opt/pi/pi")).toEqual({
      command: "/opt/pi/pi",
      args: [],
    });
  });

  it("never forwards a CLI API key to a different provider", () => {
    const args = ["--provider", "original", "--api-key", "secret"];
    expect(inheritedArgs(args, cwd, "original", "original")).toEqual([
      "--api-key",
      "secret",
    ]);
    expect(inheritedArgs(args, cwd, "different", "original")).toEqual([]);
    expect(() =>
      inheritedArgs(["--api-key", "secret"], cwd, "current"),
    ).toThrow("safely scope");
  });

  it("inherits resource, permission, tool, and extension flags but not prompts or session actions", () => {
    const args = inheritedArgs(
      [
        "-e",
        "guard.ts",
        "--no-extensions",
        "--tools",
        "read",
        "--exclude-tools",
        "bash",
        "--no-context-files",
        "--no-approve",
        "--skill",
        "./skills",
        "--offline",
        "--no-mcp",
        "--system-prompt",
        "custom",
        "--append-system-prompt",
        "more",
        "--policy=strict",
        "--session",
        "parent.jsonl",
        "--session-id",
        "parent",
        "--mode",
        "json",
        "-p",
        "do not replay this prompt",
        "@private.txt",
      ],
      cwd,
    );
    expect(args).toEqual([
      "--system-prompt",
      "custom",
      "--append-system-prompt",
      "more",
      "--extension",
      join(cwd, "guard.ts"),
      "--skill",
      join(cwd, "skills"),
      "--no-extensions",
      "--no-mcp",
      "--no-context-files",
      "--offline",
      "--tools",
      "read",
      "--exclude-tools",
      "bash",
      "--no-approve",
      "--policy=strict",
    ]);
    expect(inheritedArgs(["-e", "builtin:mcp"], cwd)).toEqual([
      "--extension",
      "builtin:mcp",
    ]);
    expect(() => inheritedArgs(["--mode", "unknown"], cwd)).toThrow(
      "invalid Pi launch",
    );
  });
});

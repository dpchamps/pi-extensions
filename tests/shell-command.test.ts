import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shell from "../extensions/shell-command/index.js";

let cwd: string;
let session: AgentSession | undefined;
let events: string[];
const notify = vi.fn();
const tui = {
  stop: vi.fn(() => events.push("stop")),
  start: vi.fn(() => events.push("start")),
  requestRender: vi.fn(() => events.push("render")),
};
const custom: ExtensionUIContext["custom"] = (factory) =>
  new Promise((resolve, reject) => {
    Promise.resolve(
      factory(
        tui as unknown as Parameters<typeof factory>[0],
        {} as Parameters<typeof factory>[1],
        {} as Parameters<typeof factory>[2],
        resolve,
      ),
    ).catch(reject);
  });

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-shell-test-")));
  events = [];
  vi.clearAllMocks();
  notify.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (String(chunk).includes("\x1b")) events.push(String(chunk));
    return true;
  });
});
afterEach(async () => {
  session?.dispose();
  session = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

async function harness(mode: "tui" | "rpc" | "print" = "tui") {
  const faux = fauxProvider();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const manager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), shell],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  ({ session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    model: faux.getModel(),
    tools: [],
  }));
  await session.bindExtensions({
    mode,
    uiContext: { notify, custom } as unknown as ExtensionUIContext,
    commandContextActions: {
      waitForIdle: async () => {
        events.push("idle");
        await session!.waitForIdle();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {},
    },
  });
  return { manager, faux, command: () => session!.prompt("/shell") };
}

const handoff = [
  "idle",
  "stop",
  "\x1b[?1049h\x1b[0m\x1b[2J\x1b[H",
  "\x1b[0m\x1b[?1049l",
  "start",
  "render",
];

describe.skipIf(process.platform === "win32")("/shell", () => {
  it("runs a fresh child in the session cwd and silently restores Pi, even after nonzero exit", async () => {
    const executable = join(cwd, "test shell");
    const log = join(cwd, "shell.log");
    await writeFile(
      executable,
      `#!/bin/sh
pwd >> "$PI_SHELL_TEST_LOG"
printf '%s\\n' "$1" "$$" "\${PI_SHELL_TEST_VALUE-unset}" >> "$PI_SHELL_TEST_LOG"
export PI_SHELL_TEST_VALUE=child-only
cd /
exit 7
`,
      { mode: 0o755 },
    );
    vi.stubEnv("SHELL", executable);
    vi.stubEnv("PI_SHELL_TEST_LOG", log);
    vi.stubEnv("PI_SHELL_TEST_VALUE", undefined);
    const { manager, faux, command } = await harness();
    const entries = structuredClone(manager.getEntries());
    const originalCwd = process.cwd();
    const listeners = process.listenerCount("SIGINT");

    await command();
    await command();

    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines.slice(0, 2)).toEqual([cwd, "-i"]);
    expect(lines.slice(4, 6)).toEqual([cwd, "-i"]);
    expect(lines[2]).not.toBe(lines[6]); // separate shell processes
    expect([lines[3], lines[7]]).toEqual(["unset", "unset"]);
    expect(process.cwd()).toBe(originalCwd);
    expect(process.env.PI_SHELL_TEST_VALUE).toBeUndefined();
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect(events).toEqual([...handoff, ...handoff]);
    expect(tui.stop).toHaveBeenCalledWith({ preserveScreen: true });
    expect(tui.requestRender).toHaveBeenCalledWith(true);
    expect(notify).not.toHaveBeenCalled();
    expect(manager.getEntries()).toEqual(entries);
    expect(session!.messages).toEqual([]);
    expect(faux.state.callCount).toBe(0);
  });

  it("restores the terminal before reporting a startup failure", async () => {
    vi.stubEnv("SHELL", join(cwd, "missing-shell"));
    const { command, manager } = await harness();
    const entries = structuredClone(manager.getEntries());
    notify.mockImplementation(() => events.push("notify"));

    await command();

    expect(events).toEqual([...handoff, "notify"]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not start shell:"),
      "error",
    );
    expect(manager.getEntries()).toEqual(entries);
  });

  it.each(["rpc", "print"] as const)(
    "rejects %s mode without touching the terminal",
    async (mode) => {
      const { command } = await harness(mode);
      await command();
      expect(tui.stop).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(notify).toHaveBeenCalledWith(
        "/shell requires interactive TUI mode.",
        "error",
      );
    },
  );
});

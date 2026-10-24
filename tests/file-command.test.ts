import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import file from "../extensions/file-command/index.js";
import { loadExplorers } from "../extensions/file-command/config.js";

let cwd: string;
let agentDir: string;
let log: string;
let session: AgentSession | undefined;
let events: string[];
const notify = vi.fn();
const input = vi.fn<ExtensionUIContext["input"]>();
const tui = {
  stop: vi.fn(() => events.push("stop")),
  start: vi.fn(() => events.push("start")),
  requestRender: vi.fn(() => events.push("render")),
};
const custom: ExtensionUIContext["custom"] = (factory) =>
  new Promise((resolve, reject) => {
    Promise.resolve()
      .then(() =>
        factory(
          tui as unknown as Parameters<typeof factory>[0],
          {} as Parameters<typeof factory>[1],
          {} as Parameters<typeof factory>[2],
          resolve,
        ),
      )
      .catch(reject);
  });

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-file-test-")));
  agentDir = join(cwd, "agent");
  log = join(cwd, "editor.json");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"));
  events = [];
  vi.clearAllMocks();
  notify.mockReset();
  input.mockReset();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("VISUAL", undefined);
  vi.stubEnv("EDITOR", undefined);
  vi.stubEnv("PI_FILE_TEST_LOG", log);
  vi.stubEnv("PI_FILE_TEST_EXIT", "0");
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

async function config(scope: "global" | "project", value: unknown) {
  await writeFile(
    join(scope === "global" ? agentDir : join(cwd, ".pi"), "file.json"),
    JSON.stringify(value),
  );
}

async function editor(name: string, flags = "") {
  const executable = join(cwd, name);
  await writeFile(
    executable,
    `#!${process.execPath}
require("node:fs").writeFileSync(process.env.PI_FILE_TEST_LOG, JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2)
}));
process.exit(Number(process.env.PI_FILE_TEST_EXIT));
`,
    { mode: 0o755 },
  );
  vi.stubEnv("EDITOR", `${executable}${flags ? ` ${flags}` : ""}`);
  return executable;
}

async function invocation() {
  return JSON.parse(await readFile(log, "utf8"));
}

async function harness(
  mode: ExtensionContext["mode"] = "tui",
  projectTrusted = true,
) {
  const faux = fauxProvider();
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: false },
      retry: { enabled: false },
    },
    { projectTrusted },
  );
  const manager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), file],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    model: faux.getModel(),
    tools: [],
  }));
  const errors: unknown[] = [];
  await session.bindExtensions({
    mode,
    onError: (error) => errors.push(error),
    uiContext: { notify, input, custom } as unknown as ExtensionUIContext,
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
  return {
    manager,
    faux,
    errors,
    command: (args = "") => session!.prompt(`/file${args ? ` ${args}` : ""}`),
  };
}

const handoff = ["idle", "stop", "\x1b[2J\x1b[H", "start", "render"];

describe.skipIf(process.platform === "win32")("/file", () => {
  it.each(["vi", "vim"])(
    "opens %s's built-in explorer without prompting",
    async (name) => {
      await editor(name, "-u NONE");
      const { command, manager, faux, errors } = await harness();
      const entries = structuredClone(manager.getEntries());

      await command("   ");

      expect(await invocation()).toEqual({
        cwd,
        args: ["-u", "NONE", "-c", "Explore"],
      });
      expect(input).not.toHaveBeenCalled();
      expect(events).toEqual(handoff);
      expect(tui.requestRender).toHaveBeenCalledWith(true);
      expect(notify).toHaveBeenCalledWith(`closed ${cwd}`, "info");
      expect(manager.getEntries()).toEqual(entries);
      expect(session!.messages).toEqual([]);
      expect(faux.state.callCount).toBe(0);
      expect(errors).toEqual([]);
    },
  );

  it.each(["docs/my note.md", "~/notes.md", "~", "/tmp/absolute.txt"])(
    "opens explicit path %s without consulting explorer config",
    async (target) => {
      await editor("vim");
      await writeFile(join(cwd, ".pi", "file.json"), "not JSON");
      const { command } = await harness();
      await command(target);

      const expanded =
        target === "~" ? homedir() : target.replace(/^~\//, `${homedir()}/`);
      const resolved = resolve(cwd, expanded);
      expect(await invocation()).toEqual({ cwd, args: [resolved] });
      expect(input).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        `closed ${resolved}`,
        "info",
      );
    },
  );

  it("keeps the existing path prompt for an unknown editor", async () => {
    await editor("nano");
    input.mockResolvedValue("  docs/my note.md  ");
    const { command } = await harness();
    await command();
    expect(input.mock.calls[0]?.[0]).toBe("File path to open");
    expect(await invocation()).toEqual({
      cwd,
      args: [join(cwd, "docs/my note.md")],
    });
  });

  it("uses VISUAL's declaration and preserves its flags over EDITOR", async () => {
    const executable = await editor("code");
    vi.stubEnv("VISUAL", `${executable} --wait`);
    vi.stubEnv("EDITOR", "vim");
    await config("project", { explorers: { code: ["{cwd}"] } });
    const { command } = await harness();
    await command();
    expect(await invocation()).toEqual({ cwd, args: ["--wait", cwd] });
    expect(input).not.toHaveBeenCalled();
  });

  it("loads plugin declarations and rereads project overrides on each invocation", async () => {
    await editor("nvim");
    await config("global", { explorers: { nvim: ["-c", "Explore"] } });
    await config("project", { explorers: { nvim: ["-c", "Oil", "{cwd}"] } });
    const { command } = await harness();
    await command();
    expect(await invocation()).toEqual({ cwd, args: ["-c", "Oil", cwd] });

    await config("project", { explorers: { nvim: false } });
    input.mockResolvedValue("chosen.txt");
    await command();
    expect(await invocation()).toEqual({
      cwd,
      args: [join(cwd, "chosen.txt")],
    });
    expect(input).toHaveBeenCalledOnce();
  });

  it("allows disabling a built-in explorer", async () => {
    await editor("vim");
    await config("project", { explorers: { vim: false } });
    input.mockResolvedValue("chosen.txt");
    const { command } = await harness();
    await command();
    expect(await invocation()).toEqual({
      cwd,
      args: [join(cwd, "chosen.txt")],
    });
  });

  it("allows empty arguments for editors that open an explorer by default", async () => {
    await editor("custom-editor");
    await config("project", { explorers: { "custom-editor": [] } });
    const { command } = await harness();
    await command();
    expect(await invocation()).toEqual({ cwd, args: [] });
    expect(input).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])(
    "does nothing when the picker returns %j",
    async (answer) => {
      await editor("nano");
      input.mockResolvedValue(answer);
      const { command } = await harness();
      await command();
      expect(events).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      await expect(readFile(log)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("ignores project declarations when the project is not trusted", async () => {
    await editor("nvim");
    await config("project", { explorers: { nvim: ["-c", "Oil"] } });
    input.mockResolvedValue("chosen.txt");
    const { command } = await harness("tui", false);
    await command();
    expect(await invocation()).toEqual({
      cwd,
      args: [join(cwd, "chosen.txt")],
    });
  });

  it("reports a missing editor configuration without touching the terminal", async () => {
    const { command } = await harness();
    await command();
    expect(notify).toHaveBeenCalledWith(
      "No editor configured. Set $VISUAL or $EDITOR.",
      "error",
    );
    expect(events).toEqual([]);
    expect(input).not.toHaveBeenCalled();
  });

  it.each(["rpc", "json", "print"] as const)(
    "rejects %s mode",
    async (mode) => {
      const { command } = await harness(mode);
      await command();
      expect(events).toEqual([]);
      expect(input).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        "/file requires interactive TUI mode.",
        "error",
      );
    },
  );

  it("restores the terminal before reporting startup failure", async () => {
    vi.stubEnv("EDITOR", join(cwd, "missing-editor"));
    const { command } = await harness();
    notify.mockImplementation(() => events.push("notify"));
    await command("file.txt");
    expect(events).toEqual([...handoff, "notify"]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not start editor:"),
      "error",
    );
  });

  it("restores the terminal on an unexpected spawn error", async () => {
    await editor("nvim");
    await config("project", { explorers: { nvim: ["\u0000"] } });
    const { command, errors } = await harness();
    await command();
    expect(events).toEqual(handoff);
    expect(errors).toHaveLength(1);
  });

  it("reports nonzero editor exits", async () => {
    await editor("vim");
    vi.stubEnv("PI_FILE_TEST_EXIT", "7");
    const { command } = await harness();
    await command();
    expect(events).toEqual(handoff);
    expect(notify).toHaveBeenCalledWith("editor exited with code 7", "warning");
  });
});

describe("explorer config", () => {
  it("merges per editor, with project > global > defaults", async () => {
    await config("global", {
      explorers: { vim: ["-c", "Vexplore"], nvim: ["-c", "Oil"] },
    });
    await config("project", { explorers: { vim: false, hx: ["{cwd}"] } });
    const warn = vi.fn();
    const explorers = loadExplorers(cwd, true, warn);
    expect(Object.fromEntries(explorers)).toEqual({
      vi: ["-c", "Explore"],
      vim: false,
      nvim: ["-c", "Oil"],
      hx: ["{cwd}"],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    { explorers: [] },
    { explorers: { vim: "Explore" } },
    { explorers: { vim: [1] } },
  ])("ignores invalid config %j and retains valid layers", async (invalid) => {
    await config("global", { explorers: { vim: ["-c", "Vexplore"] } });
    await config("project", invalid);
    const warn = vi.fn();
    expect(loadExplorers(cwd, true, warn).get("vim")).toEqual([
      "-c",
      "Vexplore",
    ]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(join(cwd, ".pi", "file.json")),
    );
  });

  it("warns about malformed JSON but still loads later valid config", async () => {
    await writeFile(join(agentDir, "file.json"), "{");
    await config("project", { explorers: { nvim: ["-c", "Oil"] } });
    const warn = vi.fn();
    expect(loadExplorers(cwd, true, warn).get("nvim")).toEqual(["-c", "Oil"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not read untrusted project config, even if malformed", async () => {
    await writeFile(join(cwd, ".pi", "file.json"), "{");
    const warn = vi.fn();
    const explorers = loadExplorers(cwd, false, warn);
    expect(explorers.get("vim")).toEqual(["-c", "Explore"]);
    expect(explorers.get("constructor")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

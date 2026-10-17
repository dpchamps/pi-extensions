import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const activeExtensions = [
  "background-command",
  "clear-command",
  "file-command",
  "pipeline-command",
  "runinfra",
  "scratchpad",
  "shell-command",
  "task",
  "web-fetch-tool",
  "worktree-command",
];

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-compatibility-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function loaderOptions() {
  return {
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  };
}

describe("Pi compatibility", () => {
  it("loads every active extension through Pi's real extension loader", async () => {
    const loader = new DefaultResourceLoader({
      ...loaderOptions(),
      additionalExtensionPaths: activeExtensions.map((name) =>
        join(root, "extensions", name, "index.ts"),
      ),
    });
    await loader.reload();

    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(activeExtensions.length);
  });

  it("fires before_agent_start per run and does not duplicate unchanged prompt sections", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("First run complete."),
      fauxAssistantMessage("Second run complete."),
    ]);
    let starts = 0;
    let turns = 0;
    const options = loaderOptions();
    const loader = new DefaultResourceLoader({
      ...options,
      extensionFactories: [
        (pi) => {
          pi.registerProvider(faux.provider);
          pi.registerTool({
            name: "noop",
            label: "No-op",
            description: "A no-op for the compatibility test.",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "ok" }],
              details: undefined,
            }),
          });
          pi.on("before_agent_start", (event) => {
            starts += 1;
            event.systemPromptOptions.sections.compatibility_guidance =
              "Stable guidance for the compatibility test.";
          });
          pi.on("turn_start", () => {
            turns += 1;
          });
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      ...options,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      model: faux.getModel(),
      tools: ["noop"],
    });
    const errors: unknown[] = [];
    try {
      await session.bindExtensions({
        mode: "print",
        onError: (error) => errors.push(error),
      });
      await session.prompt("Use noop, then finish.");
      expect(starts).toBe(1);
      expect(turns).toBe(2);

      await session.prompt("Finish without tools.");
      expect(starts).toBe(2);
      expect(turns).toBe(3);
      expect(faux.state.callCount).toBe(3);
      expect(errors).toEqual([]);

      const declarations = session.messages.filter(
        (message) =>
          message.role === "system" && message.sections?.compatibility_guidance,
      );
      expect(declarations).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
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
  type CustomMessageEntry,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import scratchpad, {
  SCRATCHPAD_MESSAGE_TYPE,
} from "../extensions/scratchpad/index.js";
import { scratchpadDirectory } from "../extensions/scratchpad/directory.js";
import type { ContextMessages } from "../lib/ensure-context.js";

let cwd: string;
let sessions: AgentSession[];
let extensionErrors: unknown[];
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "scratchpad-integration-"));
  sessions = [];
  extensionErrors = [];
});
afterEach(async () => {
  for (const session of sessions) session.dispose();
  await rm(cwd, { recursive: true, force: true });
  expect(extensionErrors).toEqual([]);
});

function notices(manager: SessionManager): CustomMessageEntry[] {
  return manager
    .getEntries()
    .filter(
      (entry): entry is CustomMessageEntry =>
        entry.type === "custom_message" &&
        entry.customType === SCRATCHPAD_MESSAGE_TYPE,
    );
}

function requestText(messages: TranscriptContext["messages"]): string {
  return messages
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      return message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    })
    .join("\n");
}

function countDeclaration(
  messages: TranscriptContext["messages"],
  declaration: string,
): number {
  return requestText(messages).split(declaration).length - 1;
}

async function createHarness(
  options: {
    manager?: SessionManager;
    extensions?: ExtensionFactory[];
    compaction?: NonNullable<
      Parameters<typeof SettingsManager.inMemory>[0]
    >["compaction"];
    toolOutput?: string;
    contextWindow?: number;
  } = {},
) {
  const manager = options.manager ?? SessionManager.inMemory(cwd);
  const faux = fauxProvider({
    models: [{ id: "test", contextWindow: options.contextWindow ?? 100_000 }],
  });
  const requests: TranscriptContext["messages"][] = [];
  const stream = faux.provider.streamSimple.bind(faux.provider);
  faux.provider.streamSimple = (model, context, streamOptions) => {
    requests.push(structuredClone(context.messages));
    return stream(model, context, streamOptions);
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: false,
      keepRecentTokens: 0,
      reserveTokens: 0,
      ...options.compaction,
    },
    retry: { enabled: false },
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
        pi.registerTool({
          name: "noop",
          label: "No-op",
          description: "No-op for scratchpad tests.",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: options.toolOutput ?? "ok" }],
            details: undefined,
          }),
        });
      },
      (pi) => scratchpad(pi, { tempDir: join(cwd, "temp") }),
      // Ordinary context transformations run before the invariant even when
      // these extensions load after scratchpad.
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
    tools: ["noop"],
  });
  sessions.push(session);
  await session.bindExtensions({
    mode: "print",
    onError: (error) => extensionErrors.push(error),
  });
  const directory = scratchpadDirectory(
    manager.getSessionId(),
    join(cwd, "temp"),
  );
  return { session, manager, faux, requests, directory };
}

const completed = () => fauxAssistantMessage("Done.");

describe("scratchpad context invariant", () => {
  it("introduces the directory once without a model run or per-prompt reminders", async () => {
    const { session, manager, faux, requests, directory } =
      await createHarness();
    expect(faux.state.callCount).toBe(0);
    expect(manager.getSessionFile()).toBeUndefined(); // --no-session works too
    expect(notices(manager)).toHaveLength(1);
    const declaration = notices(manager)[0].content as string;
    expect(declaration).toContain(directory);
    await writeFile(join(directory, "calculation.txt"), "42");
    faux.setResponses([completed(), completed(), completed()]);

    for (const prompt of ["First task", "Another task", "One more task"]) {
      await session.prompt(prompt);
    }

    expect(faux.state.callCount).toBe(3);
    expect(notices(manager)).toHaveLength(1);
    expect(
      requests.map((messages) => countDeclaration(messages, declaration)),
    ).toEqual([1, 1, 1]);
    expect(session.systemPrompt).not.toContain(declaration);
    expect(requestText(requests[0])).not.toContain("restorationId");
    expect(await readFile(join(directory, "calculation.txt"), "utf8")).toBe(
      "42",
    );
  });

  it("repairs arbitrary projections immediately, persists one suffix, and leaves anchored history untouched", async () => {
    let checkpoint:
      | { count: number; digest: string; projected: ContextMessages }
      | undefined;
    const digest = (messages: ContextMessages) =>
      createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    const projection: ExtensionFactory = (pi) => {
      pi.on("context", (event) => {
        if (!checkpoint) {
          checkpoint = {
            count: event.messages.length,
            digest: digest(event.messages),
            projected: event.messages.filter(
              (message) =>
                message.role !== "custom" ||
                message.customType !== SCRATCHPAD_MESSAGE_TYPE,
            ),
          };
          return;
        }
        expect(digest(event.messages.slice(0, checkpoint.count))).toBe(
          checkpoint.digest,
        );
        return {
          messages: [
            ...checkpoint.projected,
            ...event.messages.slice(checkpoint.count),
          ],
        };
      });
    };
    const { session, manager, faux, requests } = await createHarness({
      extensions: [projection],
    });
    const declaration = notices(manager)[0].content as string;
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("noop", {}, { id: "first-tool" }),
          fauxToolCall("noop", {}, { id: "second-tool" }),
        ],
        { stopReason: "toolUse" },
      ),
      completed(),
      completed(),
      completed(),
    ]);

    await session.prompt("Use both tools, then finish.");
    expect(faux.state.callCount).toBe(2); // repair must not trigger another response
    expect(notices(manager)).toHaveLength(2);
    expect(
      requests.map((messages) => countDeclaration(messages, declaration)),
    ).toEqual([1, 1]);
    expect(
      requests[1].filter((message) => message.role === "toolResult"),
    ).toHaveLength(2);
    expect(requests[1][0].role).toBe("system");

    await session.prompt("Next task");
    expect(notices(manager)).toHaveLength(2); // persisted repair stays in the raw suffix
    expect(countDeclaration(requests[2], declaration)).toBe(1);

    // A manager reset re-admits both historical notices. Only one is sent.
    checkpoint = undefined;
    await session.prompt("After the context-manager reset");
    expect(countDeclaration(requests[3], declaration)).toBe(1);
    expect(notices(manager)).toHaveLength(2);
  });

  it("recognizes guidance retained verbatim inside rewritten summary messages", async () => {
    const rewrite: ExtensionFactory = (pi) => {
      pi.on("context", (event) => ({
        messages: event.messages.map((message) =>
          message.role === "custom" &&
          message.customType === SCRATCHPAD_MESSAGE_TYPE
            ? {
                ...message,
                customType: "rewritten-memory",
                content: `Retained guidance:\n${message.content}`,
              }
            : message,
        ),
      }));
    };
    const { session, manager, faux, requests } = await createHarness({
      extensions: [rewrite],
    });
    const declaration = notices(manager)[0].content as string;
    faux.setResponses([completed(), completed()]);
    await session.prompt("First task");
    await session.prompt("Next task");
    expect(notices(manager)).toHaveLength(1);
    expect(
      requests.map((messages) => countDeclaration(messages, declaration)),
    ).toEqual([1, 1]);
  });

  it("does not mistake retained metadata for model-visible guidance", async () => {
    const rewrite: ExtensionFactory = (pi) => {
      pi.on("context", (event) => ({
        messages: event.messages.map((message) =>
          message.role === "custom" &&
          message.customType === SCRATCHPAD_MESSAGE_TYPE
            ? { ...message, content: "The original guidance was removed." }
            : message,
        ),
      }));
    };
    const { session, manager, faux, requests } = await createHarness({
      extensions: [rewrite],
    });
    const declaration = notices(manager)[0].content as string;
    faux.setResponses([completed()]);
    await session.prompt("Work after a rewrite");
    expect(countDeclaration(requests[0], declaration)).toBe(1);
    expect(notices(manager)).toHaveLength(2);
  });

  it("restores after repeated native manual compaction, without relying on its summary", async () => {
    const { session, manager, faux, requests } = await createHarness({
      extensions: [
        (pi) => {
          pi.on("session_before_compact", (event) => ({
            compaction: {
              summary: "Work so far; deliberately no scratchpad guidance.",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          }));
        },
      ],
    });
    const declaration = notices(manager)[0].content as string;
    faux.setResponses([completed(), completed(), completed(), completed()]);
    for (let i = 0; i < 2; i += 1) {
      await session.prompt(`Work before compaction ${i}`);
      await session.compact();
      expect(
        JSON.stringify(manager.buildSessionProjection().messages),
      ).not.toContain("Current session scratchpad");
      await session.prompt(`Task after compaction ${i}`);
      expect(countDeclaration(requests.at(-1)!, declaration)).toBe(1);
    }
    expect(notices(manager)).toHaveLength(3);
    expect(faux.state.callCount).toBe(4);
  });

  it("restores before the next response when native compaction occurs between tool turns", async () => {
    const reasons: string[] = [];
    const { session, manager, faux, requests } = await createHarness({
      contextWindow: 8_192,
      compaction: {
        enabled: true,
        reserveTokens: 1_024,
        keepRecentTokens: 128,
      },
      toolOutput: "large tool output ".repeat(8_000),
      extensions: [
        (pi) => {
          pi.on("session_before_compact", (event) => {
            reasons.push(event.reason);
            return {
              compaction: {
                summary: "The tool ran. Continue the task.",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            };
          });
        },
      ],
    });
    const declaration = notices(manager)[0].content as string;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
      completed(),
    ]);
    await session.prompt("Run the tool and finish.");
    expect(reasons).toContain("threshold");
    expect(faux.state.callCount).toBe(2);
    expect(notices(manager)).toHaveLength(2);
    expect(countDeclaration(requests[1], declaration)).toBe(1);
  });

  it("reuses the directory and declaration when a session is reloaded or resumed", async () => {
    const first = await createHarness();
    first.faux.setResponses([completed(), completed()]);
    await first.session.prompt("First task");
    await writeFile(join(first.directory, "keep.txt"), "keep across resume");
    await first.session.reload();
    await first.session.prompt("Task after reload");
    expect(notices(first.manager)).toHaveLength(1);
    first.session.dispose();

    const restored = SessionManager.inMemory(cwd, undefined, [
      first.manager.getHeader()!,
      ...first.manager.getEntries(),
    ]);
    const second = await createHarness({ manager: restored });
    second.faux.setResponses([completed()]);
    await second.session.prompt("Resumed task");
    expect(second.directory).toBe(first.directory);
    expect(await readFile(join(second.directory, "keep.txt"), "utf8")).toBe(
      "keep across resume",
    );
    expect(notices(restored)).toHaveLength(1);
  });

  it("gives forked history a new path and removes the inherited stale notice from requests", async () => {
    const parent = await createHarness();
    const parentDeclaration = notices(parent.manager)[0].content as string;
    const fork = SessionManager.inMemory(cwd, undefined, [
      { ...parent.manager.getHeader()!, id: "forked-session" },
      ...parent.manager.getEntries(),
    ]);
    const child = await createHarness({ manager: fork });
    child.faux.setResponses([completed()]);
    await child.session.prompt("Work in the fork");
    expect(child.directory).not.toBe(parent.directory);
    expect(requestText(child.requests[0])).toContain(child.directory);
    expect(requestText(child.requests[0])).not.toContain(parentDeclaration);
  });

  it("repairs a native context edit without needing any compaction event", async () => {
    const { session, manager, faux, requests, directory } =
      await createHarness();
    const original = notices(manager)[0];
    faux.setResponses([completed(), completed()]);
    await session.prompt("First task");
    manager.appendContextEdit(original.id, null);
    await rm(directory, { recursive: true });
    await session.prompt("Task after the declaration was removed");
    expect(countDeclaration(requests[1], original.content as string)).toBe(1);
    expect(notices(manager)).toHaveLength(2);
    await writeFile(
      join(directory, "recreated.txt"),
      "directory recreated with context",
    );
  });
});

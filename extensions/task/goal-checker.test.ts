import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGoalChecker, parseGoalDecision } from "./goal-checker.js";

describe("parseGoalDecision", () => {
  it("accepts strict JSON", () => {
    expect(
      parseGoalDecision(
        '{"complete":false,"feedback":"The typecheck still fails."}',
      ),
    ).toEqual({ complete: false, feedback: "The typecheck still fails." });
  });

  it("accepts JSON fenced or surrounded by short prose", () => {
    expect(
      parseGoalDecision(
        'Evaluation result:\n```json\n{"complete":true,"feedback":"All checklist items verified."}\n```',
      ),
    ).toEqual({
      complete: true,
      feedback: "All checklist items verified.",
    });
  });

  it("rejects an incomplete decision without actionable feedback", () => {
    expect(() => parseGoalDecision('{"complete":false,"feedback":""}')).toThrow(
      "goal checker did not return a valid completion decision",
    );
  });

  it("runs an isolated checker process for planning and evaluation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-checker-fixture-"));
    const fixture = join(directory, "checker.mjs");
    await writeFile(
      fixture,
      `import { writeFile } from "node:fs/promises";
const request = process.argv.at(-1) ?? "";
const match = request.match(/Checklist file: ("[^\\n]+")/);
if (!match) process.exit(2);
const checklist = JSON.parse(match[1]);
const planning = request.includes("Create the independent acceptance checklist");
if (planning) await writeFile(checklist, "# Checklist\\n- [ ] Run the integration test\\n  - Verify: npm test\\n");
console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: planning ? "Planning…" : "Checking…" } }));
console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Examining evidence…" } }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "test-1", toolName: "bash", args: { command: "npm test" } }));
console.log(JSON.stringify({ type: "tool_execution_update", toolCallId: "test-1", partialResult: { content: [{ type: "text", text: "Tests running…" }] } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "test-1", result: { content: [{ type: "text", text: "Tests running…\\n1 failure" }] } }));
const text = planning
  ? '{"ready":true}'
  : '{"complete":false,"feedback":"The integration test has not passed."}';
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }));
`,
      "utf8",
    );

    const updates: Array<{ phase: string; type: string; text: string }> = [];
    const checker = await createGoalChecker({
      cwd: directory,
      prompt: "Implement the feature",
      model: { provider: "test", id: "model" },
      projectTrusted: false,
      launchArgs: [],
      invocation: { command: process.execPath, args: [fixture] },
      onUpdate: (update) => updates.push(update),
    });
    try {
      await checker.initialize(new AbortController().signal);
      await expect(
        checker.evaluate(new AbortController().signal),
      ).resolves.toEqual({
        complete: false,
        feedback: "The integration test has not passed.",
      });
      expect(updates).toEqual(
        expect.arrayContaining([
          { phase: "planning", type: "text", text: "Planning…" },
          { phase: "planning", type: "thinking", text: "Examining evidence…" },
          { phase: "planning", type: "tool", text: "$ npm test" },
          {
            phase: "planning",
            type: "tool_output",
            id: "test-1",
            text: "Tests running…",
          },
          {
            phase: "planning",
            type: "tool_output",
            id: "test-1",
            text: "Tests running…\n1 failure",
          },
          expect.objectContaining({ phase: "planning", type: "checklist" }),
          { phase: "evaluation", type: "text", text: "Checking…" },
          { phase: "evaluation", type: "tool", text: "$ npm test" },
        ]),
      );
    } finally {
      await checker.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates a running checker when its task is explicitly cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-checker-abort-"));
    const fixture = join(directory, "checker.mjs");
    await writeFile(
      fixture,
      `
console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Still working" } }));
setInterval(() => {}, 1000);
`,
    );
    const controller = new AbortController();
    const checker = await createGoalChecker({
      cwd: directory,
      prompt: "Verify output",
      model: { provider: "test", id: "model" },
      projectTrusted: false,
      invocation: { command: process.execPath, args: [fixture] },
      onUpdate: (update) => {
        if (update.type === "text") controller.abort();
      },
    });
    try {
      await expect(checker.initialize(controller.signal)).rejects.toThrow(
        "goal checker was cancelled",
      );
    } finally {
      controller.abort();
      await checker.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("streams before the child exits and does not truncate long tool calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-checker-stream-"));
    const fixture = join(directory, "checker.mjs");
    const release = join(directory, "release");
    const command = `printf '${"x".repeat(500)}'`;
    await writeFile(
      fixture,
      `
import { access, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
const request = process.argv.at(-1);
const checklist = JSON.parse(request.match(/Checklist file: ("[^\\n]+")/)[1]);
await writeFile(checklist, "# Checklist\\n- [ ] Verify the output");
console.log(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: ${JSON.stringify(command)} } }));
while (true) {
  try { await access(${JSON.stringify(release)}); break; } catch { await setTimeout(10); }
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"ready":true}' }] } }));
`,
    );
    let streamed!: () => void;
    const firstUpdate = new Promise<void>((resolve) => {
      streamed = resolve;
    });
    const updates: Array<{ type: string; text: string }> = [];
    const checker = await createGoalChecker({
      cwd: directory,
      prompt: "Verify output",
      model: { provider: "test", id: "model" },
      projectTrusted: false,
      invocation: { command: process.execPath, args: [fixture] },
      onUpdate: (update) => {
        updates.push(update);
        if (update.type === "tool") streamed();
      },
    });
    const controller = new AbortController();
    let finished = false;
    const initializing = checker.initialize(controller.signal).then(() => {
      finished = true;
    });
    try {
      await firstUpdate;
      expect(finished).toBe(false);
      expect(updates).toContainEqual({
        phase: "planning",
        type: "tool",
        text: `$ ${command}`,
      });
      await writeFile(release, "continue");
      await initializing;
      expect(updates).toContainEqual({
        phase: "planning",
        type: "text",
        text: '{"ready":true}',
      });
    } finally {
      controller.abort();
      await initializing.catch(() => {});
      await checker.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

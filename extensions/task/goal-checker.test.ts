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
const text = planning
  ? '{"ready":true}'
  : '{"complete":false,"feedback":"The integration test has not passed."}';
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }));
`,
      "utf8",
    );

    const checker = await createGoalChecker({
      cwd: directory,
      prompt: "Implement the feature",
      model: { provider: "test", id: "model" },
      projectTrusted: false,
      launchArgs: [],
      invocation: { command: process.execPath, args: [fixture] },
    });
    try {
      await checker.initialize(new AbortController().signal);
      await expect(
        checker.evaluate(new AbortController().signal),
      ).resolves.toEqual({
        complete: false,
        feedback: "The integration test has not passed.",
      });
    } finally {
      await checker.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

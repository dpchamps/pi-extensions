import { describe, expect, it } from "vitest";
import {
  buildCompletionItems,
  parseCompletionPrefix,
  truncatePrompt,
  type TaskRef,
} from "./completion.js";

describe("parseCompletionPrefix", () => {
  it("treats empty input as the subcommand stage", () => {
    expect(parseCompletionPrefix("")).toEqual({ stage: "sub", argPrefix: "" });
  });

  it("returns subcommand stage with the prefix while still typing the first token", () => {
    expect(parseCompletionPrefix("r")).toEqual({ stage: "sub", argPrefix: "r" });
    expect(parseCompletionPrefix("resume")).toEqual({
      stage: "sub",
      argPrefix: "resume",
    });
  });

  it("transitions to arg stage once a space follows the subcommand", () => {
    expect(parseCompletionPrefix("resume ")).toEqual({
      stage: "arg",
      sub: "resume",
      argPrefix: "",
    });
    expect(parseCompletionPrefix("kill ")).toEqual({
      stage: "arg",
      sub: "kill",
      argPrefix: "",
    });
  });

  it("captures the partial arg prefix mid-word", () => {
    expect(parseCompletionPrefix("resume bg")).toEqual({
      stage: "arg",
      sub: "resume",
      argPrefix: "bg",
    });
  });

  it("collapses repeated whitespace", () => {
    expect(parseCompletionPrefix("kill   bg-1")).toEqual({
      stage: "arg",
      sub: "kill",
      argPrefix: "bg-1",
    });
  });
});

describe("buildCompletionItems", () => {
  const tasks: TaskRef[] = [
    { id: "bg-1", status: "active", promptPreview: "refactor auth module" },
    { id: "bg-2", status: "paused", promptPreview: "run flaky test loop" },
    { id: "bg-3", status: "killed", promptPreview: "old experiment" },
  ];

  describe("subcommand stage", () => {
    it("returns all subcommands when prefix is empty", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "" },
        tasks,
      );
      expect(items.map((i) => i.label)).toEqual([
        "list",
        "resume",
        "kill",
        "delete",
      ]);
    });

    it("filters subcommands by typed prefix", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "k" },
        tasks,
      );
      expect(items.map((i) => i.label)).toEqual(["kill"]);
    });

    it("uses subcommand-with-trailing-space as value so the next token keeps completing", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "" },
        tasks,
      );
      expect(items.find((i) => i.label === "resume")?.value).toBe("resume ");
      expect(items.find((i) => i.label === "kill")?.value).toBe("kill ");
    });
  });

  describe("list arg stage (status filter)", () => {
    it("offers active|paused|killed filters", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "list", argPrefix: "" },
        tasks,
      );
      expect(items.map((i) => i.label)).toEqual([
        "active",
        "paused",
        "killed",
      ]);
    });

    it("filters status options by typed prefix", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "list", argPrefix: "p" },
        tasks,
      );
      expect(items.map((i) => i.label)).toEqual(["paused"]);
    });

    it("encodes value as `list <status>`", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "list", argPrefix: "" },
        tasks,
      );
      expect(items.find((i) => i.label === "active")?.value).toBe("list active");
    });
  });

  describe("resume / kill / delete arg stages", () => {
    it("offers all task IDs from the supplied set", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "resume", argPrefix: "" },
        tasks,
      );
      expect(items.map((i) => i.label)).toEqual(["bg-1", "bg-2", "bg-3"]);
    });

    it("filters task IDs by typed prefix", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "kill", argPrefix: "bg-2" },
        tasks,
      );
      expect(items.map((i) => i.label)).toEqual(["bg-2"]);
    });

    it("encodes value as `<sub> <id>` so applyCompletion preserves the subcommand", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "resume", argPrefix: "" },
        tasks,
      );
      expect(items.find((i) => i.label === "bg-1")?.value).toBe("resume bg-1");
      expect(items.find((i) => i.label === "bg-2")?.value).toBe("resume bg-2");
    });

    it("includes status and prompt preview in the description", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "kill", argPrefix: "" },
        tasks,
      );
      expect(items.find((i) => i.label === "bg-1")?.description).toBe(
        "[active] refactor auth module",
      );
      expect(items.find((i) => i.label === "bg-3")?.description).toBe(
        "[killed] old experiment",
      );
    });
  });

  describe("unknown subcommand arg stage", () => {
    it("returns no completions for unrecognized subcommands", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "nope", argPrefix: "" },
        tasks,
      );
      expect(items).toEqual([]);
    });
  });
});

describe("truncatePrompt", () => {
  it("returns the input unchanged when within the limit", () => {
    expect(truncatePrompt("short")).toBe("short");
  });

  it("collapses internal whitespace into single spaces", () => {
    expect(truncatePrompt("foo\n\n  bar\tbaz")).toBe("foo bar baz");
  });

  it("appends an ellipsis when truncating past max", () => {
    const long = "x".repeat(100);
    const result = truncatePrompt(long, 10);
    expect(result.length).toBe(10);
    expect(result.endsWith("…")).toBe(true);
  });
});

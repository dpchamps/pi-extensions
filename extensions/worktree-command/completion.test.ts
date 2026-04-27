import { describe, expect, it } from "vitest";
import {
  buildCompletionItems,
  parentBranchOf,
  parseCompletionPrefix,
  type WorktreeRef,
} from "./completion.js";

describe("parseCompletionPrefix", () => {
  it("treats empty input as the subcommand stage", () => {
    expect(parseCompletionPrefix("")).toEqual({ stage: "sub", argPrefix: "" });
  });

  it("returns subcommand stage with the prefix while still typing the first token", () => {
    expect(parseCompletionPrefix("m")).toEqual({ stage: "sub", argPrefix: "m" });
    expect(parseCompletionPrefix("merge")).toEqual({
      stage: "sub",
      argPrefix: "merge",
    });
  });

  it("transitions to arg stage once a space follows the subcommand", () => {
    expect(parseCompletionPrefix("merge ")).toEqual({
      stage: "arg",
      sub: "merge",
      argPrefix: "",
    });
    expect(parseCompletionPrefix("switch ")).toEqual({
      stage: "arg",
      sub: "switch",
      argPrefix: "",
    });
  });

  it("captures the partial arg prefix mid-word", () => {
    expect(parseCompletionPrefix("merge ma")).toEqual({
      stage: "arg",
      sub: "merge",
      argPrefix: "ma",
    });
    expect(parseCompletionPrefix("switch main")).toEqual({
      stage: "arg",
      sub: "switch",
      argPrefix: "main",
    });
  });

  it("collapses repeated whitespace", () => {
    expect(parseCompletionPrefix("merge   foo")).toEqual({
      stage: "arg",
      sub: "merge",
      argPrefix: "foo",
    });
  });
});

describe("buildCompletionItems", () => {
  const mainDir = "/repo";
  const linked: WorktreeRef[] = [
    { path: "/repo/.worktrees/main-wt-1", branch: "main-wt-1" },
    { path: "/repo/.worktrees/main-wt-2", branch: "main-wt-2" },
    { path: "/repo/.worktrees/feature-wt-1", branch: "feature-wt-1" },
  ];

  describe("subcommand stage", () => {
    it("returns all subcommands when prefix is empty", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "" },
        mainDir,
        linked,
      );
      expect(items.map((i) => i.label)).toEqual(["create", "merge", "switch"]);
    });

    it("filters by typed prefix", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "m" },
        mainDir,
        linked,
      );
      expect(items.map((i) => i.label)).toEqual(["merge"]);
    });

    it("uses subcommand-with-trailing-space as value so the next token keeps completing", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "" },
        mainDir,
        linked,
      );
      expect(items.find((i) => i.label === "merge")?.value).toBe("merge ");
      expect(items.find((i) => i.label === "switch")?.value).toBe("switch ");
    });
  });

  describe("merge arg stage", () => {
    it("offers linked worktree branches but not main", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "merge", argPrefix: "" },
        mainDir,
        linked,
      );
      expect(items.map((i) => i.label)).toEqual([
        "main-wt-1",
        "main-wt-2",
        "feature-wt-1",
      ]);
    });

    it("filters by typed prefix", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "merge", argPrefix: "main" },
        mainDir,
        linked,
      );
      expect(items.map((i) => i.label)).toEqual(["main-wt-1", "main-wt-2"]);
    });

    it("encodes value as `<sub> <name>` so applyCompletion replaces the whole argument text", () => {
      // Repro for the bug where /worktree switch <Tab>main produced /worktree main:
      // pi-tui replaces argumentText (e.g. "merge m") wholesale with item.value,
      // so we MUST include the subcommand in the value.
      const items = buildCompletionItems(
        { stage: "arg", sub: "merge", argPrefix: "main" },
        mainDir,
        linked,
      );
      expect(items.find((i) => i.label === "main-wt-1")?.value).toBe(
        "merge main-wt-1",
      );
    });

    it("describes each worktree by its path relative to mainDir", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "merge", argPrefix: "" },
        mainDir,
        linked,
      );
      expect(items.find((i) => i.label === "main-wt-1")?.description).toBe(
        ".worktrees/main-wt-1",
      );
    });
  });

  describe("switch arg stage", () => {
    it("offers `main` first, then linked worktrees", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "switch", argPrefix: "" },
        mainDir,
        linked,
      );
      expect(items.map((i) => i.label)).toEqual([
        "main",
        "main-wt-1",
        "main-wt-2",
        "feature-wt-1",
      ]);
    });

    it("encodes value as `switch <name>` so applyCompletion preserves the subcommand", () => {
      // The original failing case: /worktree switch <Tab>, pick "main", expected /worktree switch main.
      const items = buildCompletionItems(
        { stage: "arg", sub: "switch", argPrefix: "" },
        mainDir,
        linked,
      );
      expect(items.find((i) => i.label === "main")?.value).toBe("switch main");
      expect(items.find((i) => i.label === "main-wt-1")?.value).toBe(
        "switch main-wt-1",
      );
    });

    it("filters across both `main` and worktree branches", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "switch", argPrefix: "main" },
        mainDir,
        linked,
      );
      expect(items.map((i) => i.label)).toEqual([
        "main",
        "main-wt-1",
        "main-wt-2",
      ]);
    });
  });

  describe("unknown subcommand arg stage", () => {
    it("returns no completions for unrecognized subcommands", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "create", argPrefix: "" },
        mainDir,
        linked,
      );
      expect(items).toEqual([]);
    });
  });
});

describe("parentBranchOf", () => {
  it("strips a `-wt-<n>` suffix to recover the parent branch", () => {
    expect(parentBranchOf("main-wt-1")).toBe("main");
    expect(parentBranchOf("feature-wt-42")).toBe("feature");
  });

  it("handles branches with hyphens that are not part of the wt suffix", () => {
    expect(parentBranchOf("feature-foo-bar-wt-3")).toBe("feature-foo-bar");
  });

  it("returns null when the branch name doesn't match the wt convention", () => {
    expect(parentBranchOf("main")).toBeNull();
    expect(parentBranchOf("main-wt-")).toBeNull();
    expect(parentBranchOf("main-wt-abc")).toBeNull();
  });
});

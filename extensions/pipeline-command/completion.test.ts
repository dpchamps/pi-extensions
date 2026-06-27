import { describe, expect, it } from "vitest";
import { buildCompletionItems, parseCompletionPrefix } from "./completion.js";

describe("parseCompletionPrefix", () => {
  it("treats empty input as the subcommand stage", () => {
    expect(parseCompletionPrefix("")).toEqual({ stage: "sub", argPrefix: "" });
  });

  it("returns subcommand stage with the prefix while still typing the first token", () => {
    expect(parseCompletionPrefix("e")).toEqual({
      stage: "sub",
      argPrefix: "e",
    });
    expect(parseCompletionPrefix("execute")).toEqual({
      stage: "sub",
      argPrefix: "execute",
    });
  });

  it("transitions to arg stage once a space follows the subcommand", () => {
    expect(parseCompletionPrefix("execute ")).toEqual({
      stage: "arg",
      sub: "execute",
      argPrefix: "",
    });
    expect(parseCompletionPrefix("validate ")).toEqual({
      stage: "arg",
      sub: "validate",
      argPrefix: "",
    });
  });

  it("captures the partial path prefix mid-word", () => {
    expect(parseCompletionPrefix("execute ./pipe")).toEqual({
      stage: "arg",
      sub: "execute",
      argPrefix: "./pipe",
    });
  });
});

describe("buildCompletionItems", () => {
  const jsonPaths = [
    "./pipelines/auth.json",
    "./pipelines/migration.json",
    "./test-fixtures/sample.json",
  ];

  describe("subcommand stage", () => {
    it("returns both subcommands when prefix is empty", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "" },
        jsonPaths,
      );
      expect(items.map((i) => i.label)).toEqual(["execute", "validate"]);
    });

    it("filters by typed prefix", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "v" },
        jsonPaths,
      );
      expect(items.map((i) => i.label)).toEqual(["validate"]);
    });

    it("appends a trailing space so the next token keeps completing", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "" },
        jsonPaths,
      );
      expect(items.find((i) => i.label === "execute")?.value).toBe("execute ");
      expect(items.find((i) => i.label === "validate")?.value).toBe(
        "validate ",
      );
    });

    it("provides a description for each subcommand", () => {
      const items = buildCompletionItems(
        { stage: "sub", argPrefix: "" },
        jsonPaths,
      );
      expect(
        items.find((i) => i.label === "execute")?.description,
      ).toBeTruthy();
      expect(
        items.find((i) => i.label === "validate")?.description,
      ).toBeTruthy();
    });
  });

  describe("execute arg stage", () => {
    it("offers all json paths when prefix is empty", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "execute", argPrefix: "" },
        jsonPaths,
      );
      expect(items.map((i) => i.label)).toEqual(jsonPaths);
    });

    it("filters by typed prefix", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "execute", argPrefix: "./pipelines" },
        jsonPaths,
      );
      expect(items.map((i) => i.label)).toEqual([
        "./pipelines/auth.json",
        "./pipelines/migration.json",
      ]);
    });

    it("encodes the value as a full replacement including the subcommand", () => {
      // pi-tui's applyCompletion replaces the whole argumentText (everything after `/pipeline `)
      // with item.value, so the value MUST include the subcommand or the user loses it.
      const items = buildCompletionItems(
        { stage: "arg", sub: "execute", argPrefix: "" },
        jsonPaths,
      );
      expect(
        items.find((i) => i.label === "./pipelines/auth.json")?.value,
      ).toBe("execute ./pipelines/auth.json");
    });
  });

  describe("validate arg stage", () => {
    it("offers paths under validate verb too", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "validate", argPrefix: "./test" },
        jsonPaths,
      );
      expect(items.map((i) => i.value)).toEqual([
        "validate ./test-fixtures/sample.json",
      ]);
    });
  });

  describe("unknown subcommand arg stage", () => {
    it("returns no completions for unrecognized subcommands", () => {
      const items = buildCompletionItems(
        { stage: "arg", sub: "destroy", argPrefix: "" },
        jsonPaths,
      );
      expect(items).toEqual([]);
    });
  });
});

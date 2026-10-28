import { describe, expect, it } from "vitest";
import { parseTaskArgs } from "./arguments.js";

describe("parseTaskArgs", () => {
  it("parses the default oracle with a quoted verifier", () => {
    expect(
      parseTaskArgs('--verify "npm test -- --runInBand" fix the failing tests'),
    ).toEqual({
      ok: true,
      value: {
        kind: "oracle",
        prompt: "fix the failing tests",
        verify: "npm test -- --runInBand",
        limit: undefined,
      },
    });
  });

  it("parses focus and its optional limit", () => {
    expect(parseTaskArgs("--focus --limit 7 explore other designs")).toEqual({
      ok: true,
      value: {
        kind: "focus",
        prompt: "explore other designs",
        verify: undefined,
        limit: 7,
      },
    });
  });

  it("parses goal through the canonical type flag", () => {
    expect(parseTaskArgs("--type=goal implement and verify checkout")).toEqual({
      ok: true,
      value: {
        kind: "goal",
        prompt: "implement and verify checkout",
        verify: undefined,
        limit: undefined,
      },
    });
  });

  it("supports -- before a flag-like prompt", () => {
    expect(parseTaskArgs('--verify true -- "--repair the parser"')).toEqual({
      ok: true,
      value: {
        kind: "oracle",
        prompt: "--repair the parser",
        verify: "true",
        limit: undefined,
      },
    });
  });

  it("restricts verifier and limit flags to their task types", () => {
    expect(parseTaskArgs("--focus --verify true keep working")).toEqual({
      ok: false,
      error: "--verify is only valid for oracle tasks, not focus",
    });
    expect(parseTaskArgs("--goal --limit 2 finish it")).toEqual({
      ok: false,
      error: "--limit is only valid for focus tasks",
    });
    expect(parseTaskArgs("--verify true --limit 2 finish it")).toEqual({
      ok: false,
      error: "--limit is only valid for focus tasks",
    });
  });

  it("rejects malformed input instead of partially accepting it", () => {
    expect(parseTaskArgs("--focus --limit 3oops work")).toEqual({
      ok: false,
      error: "--limit must be a positive integer",
    });
    expect(parseTaskArgs('--verify "npm test work')).toEqual({
      ok: false,
      error: 'unterminated " quote',
    });
    expect(parseTaskArgs("--goal")).toEqual({
      ok: false,
      error: "a task prompt is required",
    });
  });
});

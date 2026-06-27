/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Pipeline } from "./schema.js";
import {
  loadPipeline,
  PipelineLoadError,
  resolveStartId,
  validateSemantics,
} from "./loader.js";
import { evalCondition, renderConditionLabel } from "./conditions.js";
import { toCytoscapeElements } from "./lowering.js";
import { executePipeline } from "./runner.js";
import type { RunRecord, TCond, TPipeline } from "./schema.js";

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("Pipeline schema", () => {
  it("accepts a minimal pipeline (one unit, no flow)", () => {
    const p = { units: [{ id: "a" }] };
    expect(Value.Check(Pipeline, p)).toBe(true);
  });

  it("accepts a full pipeline with all unit fields", () => {
    const p: TPipeline = {
      name: "x",
      version: 1,
      start: "a",
      units: [
        {
          id: "a",
          kind: "start",
          prompt: { inline: "do it" },
          systemPrompt: { file: "./sp.md" },
          model: {
            provider: "openrouter",
            model: "z-ai/glm-5.1",
            thinking: "high",
          },
          preScript: "echo pre",
          postScript: "echo post",
          worktree: true,
          fresh: false,
        },
        { id: "b", kind: "terminal" },
      ],
      flow: [{ from: "a", to: "b" }],
      meta: { maxSteps: 10, description: "test" },
    };
    expect(Value.Check(Pipeline, p)).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    expect(Value.Check(Pipeline, { units: [{ id: "a" }], extra: 1 })).toBe(
      false,
    );
  });

  it("rejects empty units array", () => {
    expect(Value.Check(Pipeline, { units: [] })).toBe(false);
  });

  it("rejects unit with empty id", () => {
    expect(Value.Check(Pipeline, { units: [{ id: "" }] })).toBe(false);
  });

  it("rejects unknown unit fields", () => {
    expect(Value.Check(Pipeline, { units: [{ id: "a", junk: 1 }] })).toBe(
      false,
    );
  });

  it("rejects unknown kind", () => {
    expect(Value.Check(Pipeline, { units: [{ id: "a", kind: "weird" }] })).toBe(
      false,
    );
  });

  it("rejects unknown thinking level", () => {
    expect(
      Value.Check(Pipeline, {
        units: [
          {
            id: "a",
            model: {
              provider: "x",
              model: "y",
              thinking: "ultra-mega-think" as any,
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects edge missing from/to", () => {
    expect(
      Value.Check(Pipeline, {
        units: [{ id: "a" }],
        flow: [{ from: "a" }],
      }),
    ).toBe(false);
  });

  it("validates recursive conditions (and/or/not)", () => {
    const p = {
      units: [{ id: "a" }],
      flow: [
        {
          from: "a",
          to: "a",
          when: {
            and: [
              { not: { always: true } },
              { or: [{ exitCode: 0 }, { exitCode: { ne: 0 } }] },
            ],
          },
        },
      ],
    };
    expect(Value.Check(Pipeline, p)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

describe("validateSemantics", () => {
  it("returns no issues for a clean pipeline", () => {
    expect(
      validateSemantics({
        units: [
          { id: "a", prompt: { inline: "x" } },
          { id: "b", kind: "terminal" },
        ],
        flow: [{ from: "a", to: "b" }],
      }),
    ).toEqual([]);
  });

  it("flags duplicate unit ids", () => {
    const issues = validateSemantics({
      units: [{ id: "a" }, { id: "a" }],
    });
    expect(issues.some((i) => i.includes("duplicate"))).toBe(true);
  });

  it("flags unknown start", () => {
    const issues = validateSemantics({
      units: [{ id: "a" }],
      start: "missing",
    });
    expect(issues.some((i) => i.includes("start"))).toBe(true);
  });

  it("flags multiple kind:start units", () => {
    const issues = validateSemantics({
      units: [
        { id: "a", kind: "start" },
        { id: "b", kind: "start" },
      ],
    });
    expect(issues.some((i) => i.includes("multiple"))).toBe(true);
  });

  it("flags edge with unknown from", () => {
    const issues = validateSemantics({
      units: [{ id: "a" }],
      flow: [{ from: "ghost", to: "a" }],
    });
    expect(issues.some((i) => i.includes("edge.from"))).toBe(true);
  });

  it("flags edge with unknown to (not $end)", () => {
    const issues = validateSemantics({
      units: [{ id: "a" }],
      flow: [{ from: "a", to: "nowhere" }],
    });
    expect(issues.some((i) => i.includes("edge.to"))).toBe(true);
  });

  it("accepts edge.to = $end", () => {
    expect(
      validateSemantics({
        units: [{ id: "a" }],
        flow: [{ from: "a", to: "$end" }],
      }),
    ).toEqual([]);
  });

  it("flags outgoing edges from a terminal unit", () => {
    const issues = validateSemantics({
      units: [{ id: "a", kind: "terminal" }, { id: "b" }],
      flow: [{ from: "a", to: "b" }],
    });
    expect(issues.some((i) => i.includes("terminal"))).toBe(true);
  });

  it("flags prompt with both inline and file", () => {
    const issues = validateSemantics({
      units: [
        {
          id: "a",
          prompt: { inline: "x", file: "y" },
        },
      ],
    });
    expect(issues.some((i) => i.includes("only one of"))).toBe(true);
  });

  it("flags prompt with neither inline nor file", () => {
    const issues = validateSemantics({
      units: [{ id: "a", prompt: {} }],
    });
    expect(issues.some((i) => i.includes("must specify one of"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveStartId
// ---------------------------------------------------------------------------

describe("resolveStartId", () => {
  it("uses explicit start when present", () => {
    expect(
      resolveStartId({
        start: "b",
        units: [{ id: "a" }, { id: "b" }],
      }),
    ).toBe("b");
  });

  it("falls back to kind:start unit", () => {
    expect(
      resolveStartId({
        units: [{ id: "a" }, { id: "b", kind: "start" }],
      }),
    ).toBe("b");
  });

  it("falls back to first unit", () => {
    expect(
      resolveStartId({
        units: [{ id: "a" }, { id: "b" }],
      }),
    ).toBe("a");
  });

  it("explicit start beats kind:start", () => {
    expect(
      resolveStartId({
        start: "a",
        units: [{ id: "a" }, { id: "b", kind: "start" }],
      }),
    ).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// File loader
// ---------------------------------------------------------------------------

describe("loadPipeline", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads + validates a good pipeline", async () => {
    const file = path.join(dir, "good.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        units: [{ id: "a", prompt: { inline: "go" } }],
        flow: [{ from: "a", to: "$end" }],
      }),
    );
    const r = await loadPipeline(file);
    expect(r.pipeline.units.length).toBe(1);
    expect(r.dir).toBe(dir);
  });

  it("throws PipelineLoadError on missing file", async () => {
    await expect(loadPipeline(path.join(dir, "nope.json"))).rejects.toThrow(
      PipelineLoadError,
    );
  });

  it("throws PipelineLoadError on invalid JSON", async () => {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{not json");
    await expect(loadPipeline(file)).rejects.toThrow(PipelineLoadError);
  });

  it("collects schema issues in error.issues", async () => {
    const file = path.join(dir, "schemabad.json");
    fs.writeFileSync(file, JSON.stringify({ units: [] })); // empty units
    try {
      await loadPipeline(file);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineLoadError);
      expect((e as PipelineLoadError).issues.length).toBeGreaterThan(0);
    }
  });

  it("collects semantic issues in error.issues", async () => {
    const file = path.join(dir, "sembad.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        units: [{ id: "a" }, { id: "a" }],
      }),
    );
    try {
      await loadPipeline(file);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineLoadError);
      expect(
        (e as PipelineLoadError).issues.some((i) => i.includes("duplicate")),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

describe("evalCondition", () => {
  const baseRecord: RunRecord = {
    unitId: "a",
    iterations: 2,
    preExitCode: 0,
    postExitCode: 1,
    worktreeMergeFailed: false,
  };

  const cases: [string, TCond, RunRecord | undefined, boolean][] = [
    ["always", { always: true }, baseRecord, true],
    ["always with no record", { always: true }, undefined, true],
    ["exitCode equal match", { exitCode: 1 }, baseRecord, true],
    ["exitCode equal mismatch", { exitCode: 0 }, baseRecord, false],
    ["exitCode ne match", { exitCode: { ne: 0 } }, baseRecord, true],
    ["exitCode ne mismatch", { exitCode: { ne: 1 } }, baseRecord, false],
    ["preExitCode targets pre", { preExitCode: 0 }, baseRecord, true],
    ["postExitCode targets post", { postExitCode: 1 }, baseRecord, true],
    ["postExitCode mismatch with pre", { postExitCode: 0 }, baseRecord, false],
    ["iterations gte true", { iterations: { gte: 2 } }, baseRecord, true],
    ["iterations gte false", { iterations: { gte: 3 } }, baseRecord, false],
    ["iterations lte true", { iterations: { lte: 5 } }, baseRecord, true],
    ["iterations lte false", { iterations: { lte: 1 } }, baseRecord, false],
    ["iterations eq true", { iterations: { eq: 2 } }, baseRecord, true],
    [
      "iterations range hit",
      { iterations: { gte: 1, lte: 3 } },
      baseRecord,
      true,
    ],
    [
      "iterations range miss",
      { iterations: { gte: 3, lte: 5 } },
      baseRecord,
      false,
    ],
    [
      "worktreeMergeFailed false matches",
      { worktreeMergeFailed: false },
      baseRecord,
      true,
    ],
    [
      "worktreeMergeFailed true rejects",
      { worktreeMergeFailed: true },
      baseRecord,
      false,
    ],
    [
      "and (all true)",
      { and: [{ always: true }, { exitCode: 1 }] },
      baseRecord,
      true,
    ],
    [
      "and (one false)",
      { and: [{ always: true }, { exitCode: 0 }] },
      baseRecord,
      false,
    ],
    [
      "or (one true)",
      { or: [{ exitCode: 0 }, { exitCode: 1 }] },
      baseRecord,
      true,
    ],
    [
      "or (none true)",
      { or: [{ exitCode: 0 }, { exitCode: 99 }] },
      baseRecord,
      false,
    ],
    ["not flips false to true", { not: { exitCode: 0 } }, baseRecord, true],
    [
      "nested and(or(...))",
      {
        and: [
          { or: [{ exitCode: 1 }, { exitCode: 0 }] },
          { iterations: { gte: 2 } },
        ],
      },
      baseRecord,
      true,
    ],
    [
      "record-dependent without record returns false",
      { exitCode: 0 },
      undefined,
      false,
    ],
    [
      "unmatched key returns false (defensive)",
      { mystery: 1 } as any,
      baseRecord,
      false,
    ],
  ];

  for (const [desc, cond, rec, expected] of cases) {
    it(desc, () => {
      expect(evalCondition(cond, rec)).toBe(expected);
    });
  }
});

describe("renderConditionLabel", () => {
  it("returns empty string for always", () => {
    expect(renderConditionLabel({ always: true })).toBe("");
  });
  it("renders exit code label", () => {
    expect(renderConditionLabel({ exitCode: 0 })).toBe("exit = 0");
    expect(renderConditionLabel({ exitCode: { ne: 0 } })).toBe("exit ≠ 0");
  });
  it("renders post/pre prefixes", () => {
    expect(renderConditionLabel({ postExitCode: 1 })).toBe("post = 1");
    expect(renderConditionLabel({ preExitCode: 0 })).toBe("pre = 0");
  });
  it("renders iterations", () => {
    expect(renderConditionLabel({ iterations: { gte: 3 } })).toBe("iters ≥ 3");
    expect(renderConditionLabel({ iterations: { eq: 1, lte: 5 } })).toBe(
      "iters = 1, ≤ 5",
    );
  });
  it("renders worktree status", () => {
    expect(renderConditionLabel({ worktreeMergeFailed: true })).toBe(
      "wt merge failed",
    );
  });
  it("joins and/or/not", () => {
    expect(
      renderConditionLabel({
        and: [{ exitCode: 0 }, { iterations: { gte: 1 } }],
      }),
    ).toBe("exit = 0 ∧ iters ≥ 1");
    expect(renderConditionLabel({ not: { exitCode: 0 } })).toBe("¬(exit = 0)");
  });
});

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

describe("toCytoscapeElements", () => {
  it("emits one node per unit + edges", () => {
    const p: TPipeline = {
      units: [{ id: "a" }, { id: "b", kind: "terminal" }],
      flow: [{ from: "a", to: "b", label: "ok" }],
    };
    const out = toCytoscapeElements(p);
    expect(out.elements.length).toBe(3);
    const nodeIds = out.elements
      .filter((e: any) => e.data.source === undefined)
      .map((e: any) => e.data.id);
    expect(nodeIds).toEqual(["a", "b"]);
  });

  it("synthesizes a $end node when an edge targets it", () => {
    const p: TPipeline = {
      units: [{ id: "a" }],
      flow: [{ from: "a", to: "$end" }],
    };
    const out = toCytoscapeElements(p);
    const ids = out.elements
      .filter((e: any) => e.data.source === undefined)
      .map((e: any) => e.data.id);
    expect(ids).toContain("$end");
  });

  it("does not synthesize $end when no edge targets it", () => {
    const p: TPipeline = {
      units: [{ id: "a", kind: "terminal" }],
      flow: [],
    };
    const out = toCytoscapeElements(p);
    const ids = out.elements
      .filter((e: any) => e.data.source === undefined)
      .map((e: any) => e.data.id);
    expect(ids).not.toContain("$end");
  });

  it("derives edge id from from->to when not provided", () => {
    const p: TPipeline = {
      units: [{ id: "a" }, { id: "b" }],
      flow: [{ from: "a", to: "b" }],
    };
    const out = toCytoscapeElements(p);
    const edge = out.elements.find((e: any) => e.data.source === "a") as any;
    expect(edge.data.id).toBe("a->b");
  });

  it("uses condition-derived label when no explicit label", () => {
    const p: TPipeline = {
      units: [{ id: "a" }],
      flow: [{ from: "a", to: "$end", when: { exitCode: 0 } }],
    };
    const out = toCytoscapeElements(p);
    const edge = out.elements.find((e: any) => e.data.source === "a") as any;
    expect(edge.data.label).toBe("exit = 0");
  });

  it("preserves the unit object in the node's data bag", () => {
    const p: TPipeline = {
      units: [
        {
          id: "a",
          prompt: { inline: "go" },
          model: { provider: "x", model: "y" },
        },
      ],
    };
    const out = toCytoscapeElements(p);
    const node = out.elements[0] as any;
    expect(node.data.unit.prompt.inline).toBe("go");
    expect(node.data.unit.model.provider).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// Runner with MockPI
// ---------------------------------------------------------------------------

vi.mock("@dpchamps/pi-worktree-command/operations", () => ({
  createWorktreeForkSession: vi.fn(async () => ({
    ok: true,
    handle: {
      worktreePath: "/tmp/wt",
      branch: "main-wt-1",
      parent: "main",
      mainDir: "/tmp",
    },
  })),
  mergeWorktreeAndCleanup: vi.fn(async () => ({ ok: true })),
}));

interface MockHarness {
  pi: any;
  ctx: any;
  log: { script: string; cwd?: string }[];
  prompts: string[];
  notifications: { msg: string; level: string }[];
  setExitCode: (script: string, code: number) => void;
}

function makeHarness(): MockHarness {
  const log: { script: string; cwd?: string }[] = [];
  const prompts: string[] = [];
  const notifications: { msg: string; level: string }[] = [];
  const exitCodes = new Map<string, number>();

  const pi: any = {
    exec: vi.fn(async (_cmd: string, args: string[], opts?: any) => {
      const script = args[args.length - 1];
      log.push({ script, cwd: opts?.cwd });
      const code = exitCodes.get(script) ?? 0;
      return { stdout: "", stderr: "", code, killed: false };
    }),
    sendUserMessage: vi.fn((content: string) => {
      prompts.push(content);
    }),
    setModel: vi.fn(async () => true),
    getThinkingLevel: vi.fn(() => "off"),
    setThinkingLevel: vi.fn(),
  };

  const ctx: any = {
    cwd: "/test",
    signal: undefined,
    waitForIdle: vi.fn(async () => {}),
    newSession: vi.fn(async () => ({ cancelled: false })),
    ui: {
      notify: vi.fn((msg: string, level: string) => {
        notifications.push({ msg, level });
      }),
      setStatus: vi.fn(),
      theme: { fg: (_a: string, t: string) => t },
    },
  };

  return {
    pi,
    ctx,
    log,
    prompts,
    notifications,
    setExitCode: (s, c) => exitCodes.set(s, c),
  };
}

function makeLoaded(pipeline: TPipeline) {
  return {
    pipeline,
    dir: "/test/pipelines",
    filePath: "/test/pipelines/p.json",
  };
}

describe("executePipeline", () => {
  it("walks a linear two-unit pipeline in order", async () => {
    const h = makeHarness();
    const p: TPipeline = {
      units: [
        { id: "a", prompt: { inline: "first" }, postScript: "echo a-post" },
        { id: "b", prompt: { inline: "second" }, kind: "terminal" },
      ],
      flow: [{ from: "a", to: "b" }],
    };
    const r = await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    expect(r.aborted).toBe(false);
    expect(r.lastRecord?.unitId).toBe("b");
    expect(h.prompts).toEqual(["first", "second"]);
    expect(h.log.map((e) => e.script)).toEqual(["echo a-post"]);
  });

  it("loops back on postScript failure and exits when it passes", async () => {
    const h = makeHarness();
    let attempts = 0;
    h.pi.exec = vi.fn(async (_cmd: string, args: string[]) => {
      attempts++;
      const code = attempts < 3 ? 1 : 0;
      return { stdout: "", stderr: "", code, killed: false };
    });
    const p: TPipeline = {
      units: [{ id: "go", prompt: { inline: "try" }, postScript: "npm test" }],
      flow: [
        { from: "go", to: "go", when: { postExitCode: { ne: 0 } } },
        { from: "go", to: "$end", when: { postExitCode: 0 } },
      ],
      meta: { maxSteps: 10 },
    };
    const r = await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    expect(r.aborted).toBe(false);
    expect(attempts).toBe(3);
    expect(h.prompts.length).toBe(3);
    expect(r.lastRecord?.iterations).toBe(3);
    expect(r.lastRecord?.postExitCode).toBe(0);
  });

  it("trips maxSteps cap with a non-terminating loop", async () => {
    const h = makeHarness();
    const p: TPipeline = {
      units: [{ id: "a", prompt: { inline: "x" } }],
      flow: [{ from: "a", to: "a" }],
      meta: { maxSteps: 3 },
    };
    const r = await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    expect(r.aborted).toBe(false);
    expect(r.reason).toMatch(/maxSteps/);
    expect(h.prompts.length).toBe(3);
  });

  it("halts when abort flag is set between units", async () => {
    const h = makeHarness();
    const abortFlag = { aborted: false };
    let visited = 0;
    h.ctx.waitForIdle = vi.fn(async () => {
      visited++;
      if (visited === 1) abortFlag.aborted = true;
    });
    const p: TPipeline = {
      units: [
        { id: "a", prompt: { inline: "x" } },
        { id: "b", prompt: { inline: "y" } },
      ],
      flow: [
        { from: "a", to: "b" },
        { from: "b", to: "$end" },
      ],
    };
    const r = await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag,
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    expect(r.aborted).toBe(true);
    expect(h.prompts).toEqual(["x"]);
  });

  it("ends pipeline at terminal unit without evaluating outgoing edges", async () => {
    const h = makeHarness();
    const p: TPipeline = {
      units: [
        { id: "a", prompt: { inline: "x" } },
        { id: "term", kind: "terminal" },
      ],
      flow: [{ from: "a", to: "term" }],
    };
    const r = await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    expect(r.aborted).toBe(false);
    expect(r.lastRecord?.unitId).toBe("term");
  });

  it("ends when no outgoing edge matches conditions (implicit end)", async () => {
    const h = makeHarness();
    h.pi.exec = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 5,
      killed: false,
    }));
    const p: TPipeline = {
      units: [{ id: "a", prompt: { inline: "x" }, postScript: "exit 5" }],
      flow: [
        { from: "a", to: "a", when: { exitCode: 0 } },
        { from: "a", to: "$end", when: { exitCode: 1 } },
      ],
    };
    const r = await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    expect(r.aborted).toBe(false);
    expect(r.lastRecord?.postExitCode).toBe(5);
  });

  it("applies setOverride before each unit and clears after", async () => {
    const h = makeHarness();
    const overrideCalls: any[] = [];
    const setOverride = vi.fn((s: any) => overrideCalls.push(s));
    const p: TPipeline = {
      units: [
        {
          id: "a",
          prompt: { inline: "x" },
          model: { provider: "openrouter", model: "z-ai/glm-5.1" },
          systemPrompt: { inline: "be a senior" },
        },
        { id: "b", kind: "terminal" },
      ],
      flow: [{ from: "a", to: "b" }],
    };
    await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride,
      reportStatus: vi.fn(),
    });
    // a: set then clear; b is terminal with no prompt so no overrides
    expect(overrideCalls[0]).toMatchObject({
      modelRef: { provider: "openrouter", model: "z-ai/glm-5.1" },
      systemPrompt: "be a senior",
    });
    expect(overrideCalls[1]).toBe(null);
  });

  it("reads a prompt file from the pipeline directory", async () => {
    const h = makeHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-prompt-"));
    fs.writeFileSync(path.join(dir, "p.md"), "from-file");
    try {
      const p: TPipeline = {
        units: [
          { id: "a", prompt: { file: "./p.md" } },
          { id: "b", kind: "terminal" },
        ],
        flow: [{ from: "a", to: "b" }],
      };
      await executePipeline(
        h.pi,
        h.ctx,
        { pipeline: p, dir, filePath: path.join(dir, "p.json") },
        {
          abortFlag: { aborted: false },
          setOverride: vi.fn(),
          reportStatus: vi.fn(),
        },
      );
      expect(h.prompts).toEqual(["from-file"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs preScript and postScript with the unit's exit codes recorded", async () => {
    const h = makeHarness();
    h.pi.exec = vi.fn(async (_cmd: string, args: string[]) => {
      const script = args[args.length - 1];
      const code = script.includes("pre") ? 7 : 9;
      return { stdout: "", stderr: "", code, killed: false };
    });
    const p: TPipeline = {
      units: [
        {
          id: "a",
          prompt: { inline: "x" },
          preScript: "pre-cmd",
          postScript: "post-cmd",
          kind: "terminal",
        },
      ],
    };
    const r = await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    expect(r.lastRecord?.preExitCode).toBe(7);
    expect(r.lastRecord?.postExitCode).toBe(9);
  });

  it("does not call sendUserMessage when unit has no prompt", async () => {
    const h = makeHarness();
    const p: TPipeline = {
      units: [
        {
          id: "scripts-only",
          preScript: "echo a",
          postScript: "echo b",
          kind: "terminal",
        },
      ],
    };
    await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    expect(h.prompts.length).toBe(0);
    expect(h.log.length).toBe(2);
  });

  it("auto-stages and commits worktree changes after postScript before merging", async () => {
    const h = makeHarness();
    h.pi.exec = vi.fn(async (cmd: string, args: string[]) => {
      // Simulate "the agent left changes" — git status --porcelain reports
      // dirty so the runner should follow up with a commit.
      if (
        cmd === "git" &&
        args[0] === "status" &&
        args.includes("--porcelain")
      ) {
        return { stdout: " M file.ts\n", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    const p: TPipeline = {
      units: [
        {
          id: "wt-unit",
          prompt: { inline: "do work" },
          postScript: "npm test",
          worktree: true,
          kind: "terminal",
        },
      ],
    };
    await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    const calls = (h.pi.exec as any).mock.calls.map(
      ([cmd, args]: [string, string[]]) =>
        cmd === "bash" ? args[args.length - 1] : `git ${args[0]}`,
    );
    // Order matters: postScript must run first, then add → status → commit.
    const postIdx = calls.indexOf("npm test");
    const addIdx = calls.indexOf("git add");
    const statusIdx = calls.indexOf("git status");
    const commitIdx = calls.indexOf("git commit");
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(postIdx);
    expect(statusIdx).toBeGreaterThan(addIdx);
    expect(commitIdx).toBeGreaterThan(statusIdx);
  });

  it("skips the commit when the worktree has no pending changes", async () => {
    const h = makeHarness();
    // Default exec returns empty stdout for status → nothing to commit.
    const p: TPipeline = {
      units: [
        {
          id: "wt-clean",
          prompt: { inline: "look around" },
          worktree: true,
          kind: "terminal",
        },
      ],
    };
    await executePipeline(h.pi, h.ctx, makeLoaded(p), {
      abortFlag: { aborted: false },
      setOverride: vi.fn(),
      reportStatus: vi.fn(),
    });
    const gitOps = (h.pi.exec as any).mock.calls
      .filter(([cmd]: [string, string[]]) => cmd === "git")
      .map(([, args]: [string, string[]]) => args[0]);
    expect(gitOps).toContain("add");
    expect(gitOps).toContain("status");
    expect(gitOps).not.toContain("commit");
  });
});

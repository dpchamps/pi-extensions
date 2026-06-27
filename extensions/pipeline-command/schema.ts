/**
 * TypeBox schema for the pipeline DSL. Source of truth for both static types
 * and runtime validation.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";

const Thinking = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

const ModelRef = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    thinking: Type.Optional(Thinking),
  },
  { additionalProperties: false },
);

const PromptObj = Type.Object(
  {
    inline: Type.Optional(Type.String()),
    file: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const UnitKind = Type.Union([
  Type.Literal("unit"),
  Type.Literal("start"),
  Type.Literal("terminal"),
]);

export const Unit = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: Type.Optional(UnitKind),
    prompt: Type.Optional(PromptObj),
    systemPrompt: Type.Optional(PromptObj),
    model: Type.Optional(ModelRef),
    preScript: Type.Optional(Type.String()),
    postScript: Type.Optional(Type.String()),
    worktree: Type.Optional(Type.Boolean()),
    fresh: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const ExitMatch = Type.Union([
  Type.Integer(),
  Type.Object({ ne: Type.Integer() }, { additionalProperties: false }),
]);

const IterationsMatch = Type.Object(
  {
    gte: Type.Optional(Type.Integer({ minimum: 0 })),
    lte: Type.Optional(Type.Integer({ minimum: 0 })),
    eq: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

// Condition union. Combinator branches (and/or/not) take Type.Any() rather
// than a self-reference because we avoid Type.Recursive — pi's extension
// loader has a bundling path that drops TypeBox's recursive helper. Shape
// validation of nested conditions falls through to evalCondition's defensive
// switch, which treats unrecognized keys as `false`.
export const Cond: TSchema = Type.Union([
  Type.Object({ always: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({ exitCode: ExitMatch }, { additionalProperties: false }),
  Type.Object({ preExitCode: ExitMatch }, { additionalProperties: false }),
  Type.Object({ postExitCode: ExitMatch }, { additionalProperties: false }),
  Type.Object(
    { iterations: IterationsMatch },
    { additionalProperties: false },
  ),
  Type.Object(
    { worktreeMergeFailed: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    { and: Type.Array(Type.Any()) },
    { additionalProperties: false },
  ),
  Type.Object(
    { or: Type.Array(Type.Any()) },
    { additionalProperties: false },
  ),
  Type.Object({ not: Type.Any() }, { additionalProperties: false }),
]);

export const Edge = Type.Object(
  {
    from: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
    when: Type.Optional(Cond),
    label: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const Pipeline = Type.Object(
  {
    name: Type.Optional(Type.String()),
    version: Type.Optional(Type.Literal(1)),
    start: Type.Optional(Type.String()),
    units: Type.Array(Unit, { minItems: 1 }),
    flow: Type.Optional(Type.Array(Edge)),
    meta: Type.Optional(
      Type.Object(
        {
          maxSteps: Type.Optional(Type.Integer({ minimum: 1 })),
          description: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type TUnit = Static<typeof Unit>;
export type TModelRef = Static<typeof ModelRef>;
export type TPromptObj = Static<typeof PromptObj>;
export type TThinking = Static<typeof Thinking>;

/**
 * Recursive Cond union — TypeBox's Static<> can't infer recursive shapes
 * cleanly, so we declare the structural type by hand. Keep this in sync with
 * the Cond schema above.
 */
export type TCond =
  | { always: true }
  | { exitCode: number | { ne: number } }
  | { preExitCode: number | { ne: number } }
  | { postExitCode: number | { ne: number } }
  | { iterations: { gte?: number; lte?: number; eq?: number } }
  | { worktreeMergeFailed: boolean }
  | { and: TCond[] }
  | { or: TCond[] }
  | { not: TCond };

export type TEdge = Omit<Static<typeof Edge>, "when"> & { when?: TCond };
export type TPipeline = Omit<Static<typeof Pipeline>, "flow"> & {
  flow?: TEdge[];
};

/** Snapshot of one completed unit's run, used by condition evaluation. */
export interface RunRecord {
  unitId: string;
  iterations: number;
  preExitCode?: number;
  postExitCode?: number;
  worktreeMergeFailed?: boolean;
}

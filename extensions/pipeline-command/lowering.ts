/**
 * Lower a pipeline to Cytoscape.js's `elements[]` JSON shape so future
 * visualizers can read pipeline files directly.
 *
 * https://js.cytoscape.org/#notation/elements-json
 *
 * The shape is also a near-superset of React Flow's {nodes, edges}; a small
 * follow-up function can hoist `data.source`/`data.target` out of `data` and
 * synthesize positions to produce React Flow input.
 */

import { renderConditionLabel } from "./conditions.js";
import type { TCond, TEdge, TPipeline, TUnit } from "./schema.js";

export interface CytoscapeNode {
  data: {
    id: string;
    label: string;
    kind: string;
    unit?: TUnit;
  };
}

export interface CytoscapeEdge {
  data: {
    id: string;
    source: string;
    target: string;
    label: string;
    when?: TCond;
  };
}

export interface CytoscapeElements {
  elements: (CytoscapeNode | CytoscapeEdge)[];
}

export function toCytoscapeElements(pipeline: TPipeline): CytoscapeElements {
  const nodes: CytoscapeNode[] = pipeline.units.map((u) => ({
    data: {
      id: u.id,
      label: u.id,
      kind: u.kind ?? "unit",
      unit: u,
    },
  }));

  const flow: TEdge[] = pipeline.flow ?? [];
  const needsEnd = flow.some((e) => e.to === "$end");
  const endNode: CytoscapeNode[] = needsEnd
    ? [{ data: { id: "$end", label: "end", kind: "synthetic" } }]
    : [];

  const edges: CytoscapeEdge[] = flow.map((e) => ({
    data: {
      id: e.id ?? `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      label: e.label ?? renderConditionLabel(e.when),
      when: e.when,
    },
  }));

  return { elements: [...nodes, ...endNode, ...edges] };
}

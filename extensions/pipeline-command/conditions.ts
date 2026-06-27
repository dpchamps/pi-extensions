/**
 * Pure condition evaluator for pipeline edge guards.
 *
 * Conditions are evaluated against the RunRecord of the unit whose outgoing
 * edge is being considered. They never throw — invalid combinations of keys
 * fall through to `false` (the schema validator catches malformed conditions
 * at load time).
 */

import type { RunRecord, TCond } from "./schema.js";

export function evalCondition(
  cond: TCond,
  record: RunRecord | undefined,
): boolean {
  if ("always" in cond) return cond.always === true;
  if ("and" in cond) return cond.and.every((c) => evalCondition(c, record));
  if ("or" in cond) return cond.or.some((c) => evalCondition(c, record));
  if ("not" in cond) return !evalCondition(cond.not, record);

  if (!record) return false;

  if ("exitCode" in cond) {
    return matchExit(cond.exitCode, record.postExitCode);
  }
  if ("preExitCode" in cond) {
    return matchExit(cond.preExitCode, record.preExitCode);
  }
  if ("postExitCode" in cond) {
    return matchExit(cond.postExitCode, record.postExitCode);
  }
  if ("iterations" in cond) {
    const n = record.iterations;
    const m = cond.iterations;
    if (m.eq !== undefined && n !== m.eq) return false;
    if (m.gte !== undefined && n < m.gte) return false;
    if (m.lte !== undefined && n > m.lte) return false;
    return true;
  }
  if ("worktreeMergeFailed" in cond) {
    return Boolean(record.worktreeMergeFailed) === cond.worktreeMergeFailed;
  }

  return false;
}

function matchExit(
  spec: number | { ne: number },
  actual: number | undefined,
): boolean {
  if (actual === undefined) return false;
  if (typeof spec === "number") return actual === spec;
  return actual !== spec.ne;
}

/** Short human-readable label for an edge condition (for visualization). */
export function renderConditionLabel(cond: TCond | undefined): string {
  if (!cond) return "";
  if ("always" in cond) return "";
  if ("exitCode" in cond) return `exit ${exitText(cond.exitCode)}`;
  if ("preExitCode" in cond) return `pre ${exitText(cond.preExitCode)}`;
  if ("postExitCode" in cond) return `post ${exitText(cond.postExitCode)}`;
  if ("iterations" in cond) {
    const parts: string[] = [];
    if (cond.iterations.eq !== undefined) parts.push(`= ${cond.iterations.eq}`);
    if (cond.iterations.gte !== undefined)
      parts.push(`≥ ${cond.iterations.gte}`);
    if (cond.iterations.lte !== undefined)
      parts.push(`≤ ${cond.iterations.lte}`);
    return `iters ${parts.join(", ")}`;
  }
  if ("worktreeMergeFailed" in cond) {
    return cond.worktreeMergeFailed ? "wt merge failed" : "wt merge ok";
  }
  if ("and" in cond)
    return cond.and.map(renderConditionLabel).filter(Boolean).join(" ∧ ");
  if ("or" in cond)
    return cond.or.map(renderConditionLabel).filter(Boolean).join(" ∨ ");
  if ("not" in cond) return `¬(${renderConditionLabel(cond.not)})`;
  return "";
}

function exitText(spec: number | { ne: number }): string {
  if (typeof spec === "number") return `= ${spec}`;
  return `≠ ${spec.ne}`;
}

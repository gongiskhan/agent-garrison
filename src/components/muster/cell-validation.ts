// Client-safe replica of the cell-compatibility rule for Muster's live
// validation. The CANONICAL server-side copy is `validateCellCompatibility` +
// `AGENTIC_RUNTIMES` in src/lib/router-migrate.ts; that module imports node:fs
// at module scope (it is the router->duties migrator), so it cannot be pulled
// into a "use client" bundle. This file replicates ONLY the pure rule so the UI
// can validate optimistic edits instantly, without a server round-trip. A unit
// test (tests/muster-model.test.ts) asserts this replica agrees with the
// canonical function so the two never drift.
//
// The rule: a skill-shaped cell (a cell that owns a skill) must run on an
// AGENTIC target - a target whose runtime hosts an agent loop. garrison-call is
// single-shot and deliberately ineligible for a skill cell.

export const AGENTIC_RUNTIMES = ["claude-code", "agent-sdk", "codex", "gemini", "opencode"] as const;
const AGENTIC_RUNTIME_SET = new Set<string>(AGENTIC_RUNTIMES);

export interface CellLike {
  skill?: string;
  target?: string;
}
export interface TargetLike {
  id: string;
  runtime: string;
}
export interface CellIssue {
  code: "skill-without-target" | "skill-unknown-target" | "skill-needs-agentic-target";
  message: string;
}

export function validateCell(cell: CellLike, targets: TargetLike[]): CellIssue[] {
  if (!cell.skill) return [];
  if (!cell.target) {
    return [
      {
        code: "skill-without-target",
        message: `skill "${cell.skill}" needs a target - assign an agentic runtime`
      }
    ];
  }
  const target = targets.find((t) => t.id === cell.target);
  if (!target) {
    return [
      {
        code: "skill-unknown-target",
        message: `target "${cell.target}" is not defined in this composition`
      }
    ];
  }
  if (!AGENTIC_RUNTIME_SET.has(target.runtime)) {
    return [
      {
        code: "skill-needs-agentic-target",
        message:
          `"${cell.target}" runs on "${target.runtime}", which is not an agent loop. ` +
          `A skill needs an agentic runtime (${AGENTIC_RUNTIMES.join(", ")}); garrison-call is single-shot.`
      }
    ];
  }
  return [];
}

// True when a target is eligible to host a skill cell (an agent loop).
export function isAgenticRuntime(runtime: string): boolean {
  return AGENTIC_RUNTIME_SET.has(runtime);
}

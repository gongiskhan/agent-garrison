// Typed loader for the level-resolution core.
//
// This is deliberately NOT a reimplementation. The canonical implementation lives
// in `fittings/seed/orchestrator/lib/level-resolution.mjs` because the gateway
// needs it at runtime and cannot import from `src/`; the shell reaches the SAME
// module through a dynamic import, exactly as it already does for routing-core.
// One implementation, so the level a duty resolves to can never differ between the
// screen that shows it and the router that acts on it.
//
// (Contrast `src/lib/flow-compat.ts`, which IS mirrored — that one sits in
// synchronous hot read paths and is needed by a fitting that cannot reach the
// orchestrator fitting at all.)

import path from "node:path";
import { pathToFileURL } from "node:url";

const LEVEL_CORE_PATH = path.join(
  process.cwd(),
  "fittings/seed/orchestrator/lib/level-resolution.mjs"
);

/** Where a duty's level came from, in precedence order. */
export type LevelSource = "inherit" | "pin" | "escalation";

export interface DutyLevelResolution {
  level: number;
  source: LevelSource;
  /** The flow level, i.e. what the duty would run at with no pin and no escalation. */
  inherited: number;
  /** The level pinned for this duty in the flow definition, if any. */
  pinned: number | null;
  /** The level a runtime escalation raised this duty to, if any. */
  escalated: number | null;
  /** Why it was escalated. Null unless `escalated` is set. */
  reason: string | null;
  /** Set when an escalation tried to LOWER a level; the level returned is the un-escalated one. */
  rejected: { requested: number; keptAt: number; why: string } | null;
}

export interface FlowLevelDefinition {
  duties?: string[];
  /** duty -> level, applied at THIS flow level only. */
  pins?: Record<string, number>;
  definitionOfDone?: string;
  evidence?: string;
}

export interface FlowDefinition {
  description?: string;
  /** Which Phase-0 cluster of real work this flow covers. */
  cluster?: string;
  /** Real observed tasks this flow is for. A flow with none should not exist. */
  examples?: string[];
  defaultLevel?: number;
  levels?: Record<string, FlowLevelDefinition>;
}

export interface ResolvedFlowPlan {
  flowLevel: number;
  duties: (DutyLevelResolution & { duty: string })[];
  definitionOfDone: string | null;
  evidence: string | null;
}

export interface EscalationRecord {
  kind: "escalation";
  at: string | null;
  cardId: string | null;
  duty: string;
  flowLevel: number;
  from: number;
  to: number;
  reason: string | null;
  applied: boolean;
  rejected?: { requested: number; keptAt: number; why: string };
}

export interface EscalationGroup {
  flow: string | null;
  flowLevel: number | null;
  duty: string | null;
  to: number | null;
  count: number;
  reasons: string[];
  cardIds: string[];
  /** True once this shape has escalated often enough to be evidence the flow
   *  definition is wrong rather than evidence about one card. */
  recurring: boolean;
}

interface LevelCore {
  MIN_LEVEL: number;
  MAX_LEVEL: number;
  clampLevel: (n: unknown) => number | null;
  resolveFlowLevel: (flow: FlowDefinition | null | undefined, requested: unknown) => number;
  dutiesForLevel: (flow: FlowDefinition | null | undefined, flowLevel: number) => string[];
  resolveDutyLevel: (
    flow: FlowDefinition | null | undefined,
    flowLevel: number,
    duty: string,
    escalation?: { level?: number; reason?: string } | null
  ) => DutyLevelResolution;
  resolveFlowPlan: (
    flow: FlowDefinition | null | undefined,
    flowLevel: number,
    escalations?: Record<string, { level?: number; reason?: string }>
  ) => ResolvedFlowPlan;
  escalateDuty: (input: {
    flow: FlowDefinition | null | undefined;
    flowLevel: number;
    duty: string;
    toLevel: number;
    reason?: string | null;
    cardId?: string | null;
    at?: string | null;
  }) => { applied: boolean; resolved: DutyLevelResolution; record: EscalationRecord };
  summariseEscalations: (
    records: unknown[],
    opts?: { threshold?: number }
  ) => EscalationGroup[];
}

let cached: Promise<LevelCore> | null = null;

export function loadLevelCore(): Promise<LevelCore> {
  // webpackIgnore keeps the dynamic specifier out of the Next bundle — without it
  // webpack compiles it into an empty lazy context that rejects every request
  // (the same trap routing-core documents).
  cached ??= import(/* webpackIgnore: true */ pathToFileURL(LEVEL_CORE_PATH).href) as Promise<LevelCore>;
  return cached;
}

/** Test seam: drop the memoised module so a test can re-import it. */
export function resetLevelCoreCache(): void {
  cached = null;
}

// The cold-start seed expander and the autonomy core are plain .mjs modules in
// the orchestrator fitting. These ambient declarations give the TS tests types
// so tsc --noEmit does not flag the imports as implicit-any, exactly like
// tests/ack-mjs.d.ts does for the kanban notify modules.
//
// The routing-autonomy declaration covers the module's WHOLE export surface,
// permissively: a wildcard `declare module` applies to every test that imports
// it (tests/routing-autonomy.test.ts, tests/autonomy-consult.test.ts,
// tests/outbox-buffer.test.ts...), so a partial declaration here would break
// files this one never meant to touch. Track records are deliberately loose
// (Record<string, any>) - their shape belongs to the .mjs, and the tests that
// probe it do so through the module's own functions.

declare module "*/orchestrator/lib/autonomy-seed.mjs" {
  export const SEED_CAP_DEFAULT: number;
  export const SEED_CATEGORIES: readonly string[];
  export function expandAutonomySeed(
    doc: unknown,
    opts?: { cap?: number | null; categories?: readonly string[] }
  ): { shape: string; category: string }[];
}

declare module "*/orchestrator/lib/routing-autonomy.mjs" {
  // recurrenceBoost is declared required although only the override/escalation
  // signals carry it: an ambient test declaration prefers a runtime undefined
  // over forcing every comparison through a non-null assertion.
  export const SIGNALS: Record<
    string,
    { weight: number; direction: string; recurrenceBoost: number; [k: string]: unknown }
  >;
  export const SIGNAL_KINDS: readonly string[];
  export const CATEGORIES: readonly string[];
  export const REVERSIBILITY: Record<string, { autonomous: boolean; [k: string]: unknown }>;
  export const ACTION_REVERSIBILITY: Record<string, string>;
  export function reversibilityOf(action: unknown): string;
  export const OUTBOUND_DELAY_SECONDS: number;
  export const DEFAULT_THRESHOLDS: {
    lower: number;
    upper: number;
    minObservations: number;
    maxQuestionsPerDay: number;
  };
  export const EVIDENCE_PRIOR: number;
  export const SILENCE_CAP: number;
  export function emptyTrack(overrides?: Record<string, unknown>): Record<string, any>;
  export function recordSignal(
    track: unknown,
    kind: string,
    opts?: { at?: string | null }
  ): Record<string, any>;
  export function confidenceOf(track: unknown, thresholds?: unknown): number;
  export function bandFor(
    track: unknown,
    opts?: { thresholds?: unknown; action?: string; now?: string | null }
  ): { band: "ask" | "act-revert" | "act-inform"; confidence: number; reversibility: string; delaySeconds: number };
  export const ASK_REASONS: readonly string[];
  export function shouldAsk(
    track: unknown,
    opts?: { thresholds?: unknown; askedToday?: number; action?: string; now?: string | null }
  ): { ask: boolean; reason: string | null; defer: boolean };
  export function seedFromHistory(
    entries: readonly unknown[] | null | undefined,
    opts?: { weight?: number }
  ): Record<string, Record<string, any>>;
  export function trackKey(category: string, shape: string): string;
}

// Hand-written types for dispatch-core.mjs so TypeScript consumers (tests, the
// gateway hook) get types without a build step — mirrors routing-core.d.mts.

export type DutyEffort = "low" | "medium" | "high" | "xhigh" | "max";

// The Dispatcher treats a cell as opaque (it never validates or resolves effort —
// resolveSequence does), so `effort` is typed as a plain string here, not the
// DutyEffort enum, to avoid coupling callers to the enum for a field the
// Dispatcher only passes through.
export interface DutyLevelCell {
  skill?: string;
  target?: string;
  effort?: string;
}
export interface DutySequenceEntry {
  duty: string;
  level?: number;
}
export interface DutyLevel {
  description: string;
  cell?: DutyLevelCell;
  sequence?: DutySequenceEntry[];
}
export interface DutySpecLike {
  id: string;
  title: string;
  description: string;
  levels: DutyLevel[];
}

// The resolved model shape the Dispatcher reads (a subset of the Resolver's
// ResolvedModel: the duties + the selected duty ids).
export interface DispatchModel {
  duties: Record<string, DutySpecLike>;
  selectedDuties: string[];
}

// S3d (D9b): the specification-clarity verdict - orthogonal to the (duty, level).
export type Clarity = "clear" | "needs-discuss";

export interface DispatchPick {
  duty: string;
  level: number;
  confidence: "low" | "medium" | "high";
  // S3d (D9b): parseDispatch/fallbackDispatch always populate clarity; optional so a
  // hand-built pick (a caller / test constructing one for applyOverride) may omit it.
  clarity?: Clarity;
  reason: string;
}
export interface OverriddenPick extends DispatchPick {
  overridden: boolean;
  overrideSource: "message" | "card" | null;
}

export interface RoutingEvidence {
  kind: "dispatch";
  at: string | null;
  messageDigest: string;
  duty: string | null;
  level: number | null;
  confidence: "low" | "medium" | "high" | null;
  clarity: Clarity | null;
  clarityOverrideSource: "message" | null;
  overrideSource: "message" | "card" | null;
  reason: string | null;
}

export interface DispatchSchema {
  type: "object";
  required: string[];
  properties: Record<string, { type: string; enum?: unknown[] }>;
}

// A garrison-call result (single-shot / structured).
export interface CallResult {
  ok: boolean;
  structured?: unknown;
  text?: string;
  error?: string;
  usage?: unknown;
}
export type CallFn = (spec: Record<string, unknown>) => Promise<CallResult>;

export interface DispatchOptions {
  call: CallFn;
  shape?: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  cardLevel?: number;
  now?: () => string;
  evidenceFile?: string;
  // S3d (D9b): the editable rubric folded into the dispatch prompt's clarity line.
  clarityRubric?: string;
  fallback?: (model: DispatchModel, message: string) => DispatchPick;
}

export interface DispatchResult extends OverriddenPick {
  // S3d: the specification-clarity verdict + whether a phrasing override set it.
  clarityOverrideSource: "message" | null;
  dispatchOk: boolean;
  callError: string | null;
  evidence: RoutingEvidence;
}

// S3d (D9b): the default clarity rubric text + the valid verdict set.
export const DEFAULT_CLARITY_RUBRIC: string;
export const CLARITY_VALUES: Set<string>;
// The phrasing short-circuit for clarity - an explicit "just do it" / "let's discuss
// first" wins over the model, both directions. Null when no explicit phrasing matches.
export function clarityShortCircuit(message: string): { clarity: Clarity; overrideSource: "message" } | null;

export function buildDispatchPrompt(model: DispatchModel, userPrompt: string, opts?: { clarityRubric?: string }): string;
export function dispatchSchema(): DispatchSchema;
export function parseDispatch(reply: unknown, model: DispatchModel): DispatchPick | null;
export function fallbackDispatch(model: DispatchModel, reason?: string): DispatchPick;
export function deterministicFallbackDispatch(model: DispatchModel, message: string): DispatchPick;
export function parseLevelOverride(message: string): number | null;
export function applyOverride(
  dispatch: DispatchPick,
  opts: { message?: string; cardLevel?: number },
  model: DispatchModel
): OverriddenPick;
export function messageDigest(message: string): string;
export function routingEvidence(input: {
  message: string;
  duty?: string | null;
  level?: number | null;
  confidence?: "low" | "medium" | "high" | string | null;
  clarity?: Clarity | string | null;
  clarityOverrideSource?: "message" | null;
  overrideSource?: "message" | "card" | null;
  at?: string | null;
}): RoutingEvidence;
export function appendEvidence(filePath: string, record: RoutingEvidence): Promise<void>;
export function dispatch(model: DispatchModel, message: string, opts: DispatchOptions): Promise<DispatchResult>;

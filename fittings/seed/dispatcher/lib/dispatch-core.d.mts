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

export interface DispatchPick {
  duty: string;
  level: number;
  confidence: "low" | "medium" | "high";
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
}

export interface DispatchResult extends OverriddenPick {
  dispatchOk: boolean;
  callError: string | null;
  evidence: RoutingEvidence;
}

export function buildDispatchPrompt(model: DispatchModel, userPrompt: string): string;
export function dispatchSchema(): DispatchSchema;
export function parseDispatch(reply: unknown, model: DispatchModel): DispatchPick | null;
export function fallbackDispatch(model: DispatchModel, reason?: string): DispatchPick;
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
  overrideSource?: "message" | "card" | null;
  at?: string | null;
}): RoutingEvidence;
export function appendEvidence(filePath: string, record: RoutingEvidence): Promise<void>;
export function dispatch(model: DispatchModel, message: string, opts: DispatchOptions): Promise<DispatchResult>;

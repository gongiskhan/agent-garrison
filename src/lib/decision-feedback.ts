// The dimension feedback card (§8.2) — the vocabulary and the wire contract the
// two verdict surfaces share.
//
// `decision-verdicts.ts` owns the RECORD (what a verdict is, what survives
// sanitization). This owns the CARD: which dimensions of a decision can be
// corrected, what the REAL choices are for each one, and the exact payload both
// surfaces post. The split matters because the two surfaces — the Garrison home
// Router panel and the Muster Decisions panel — must train the Improver
// identically; a second hand-rolled copy of "what should this menu offer" is how
// they would drift apart.
//
// Why the menus are not free text any more: the routing vocabulary is the
// gateway's compiled policy, and a typed value that is not in it is a correction
// the edge would refuse. It is proxied to the browser by
// `/api/orchestrator/route-options` (the shell cannot hand the browser a
// machine-local gateway URL — the browser is almost never on this box). Free text
// remains as the fallback for exactly one case: the gateway is not answering, so
// there is no vocabulary to offer. A blocked correction is worse than a typed one.
//
// PURE BY CONSTRUCTION — no `node:` imports, no filesystem, for the same reason
// `decision-verdicts.ts` is: both verdict surfaces are "use client" components,
// so a single Node builtin here breaks the browser bundle. The API route imports
// the normalizer from the same file; that direction is harmless.

import {
  CORRECTION_FIELDS,
  type Correction,
  type CorrectionField,
  type Verdict
} from "./decision-verdicts";

// ── The routing vocabulary, as the browser sees it ───────────────────────────

export interface RouteTargetOption {
  id: string;
  runtime: string | null;
  model: string | null;
  effort: string | null;
}
export interface RouteDutyOption {
  id: string;
  title: string | null;
}
export interface RouteAccountOption {
  name: string;
  platform: string | null;
}
export interface RouteFlowOption {
  id: string;
  description: string | null;
  /** The plan's phases IN PLAN ORDER — also the vocabulary for `phasesOff`. */
  phases: string[];
}

/** Exactly the lists the correction menus need, and nothing else. The gateway's
 *  `/route/options` carries more (selectedDuties, activeProfile, routing…) which
 *  belongs to the Turn Rail, not to a correction. */
export interface RouteVocabulary {
  targets: RouteTargetOption[];
  duties: RouteDutyOption[];
  efforts: string[];
  accounts: RouteAccountOption[];
  projects: string[];
  tiers: string[];
  flows: RouteFlowOption[];
  defaultFlow: string | null;
}

export interface RouteOptionsResponse extends RouteVocabulary {
  /** False when the gateway did not answer. The card then says so and falls back
   *  to typed corrections rather than rendering empty menus, which would read as
   *  "you have no options". */
  available: boolean;
  reason: string | null;
}

export const EMPTY_VOCABULARY: RouteVocabulary = {
  targets: [],
  duties: [],
  efforts: [],
  accounts: [],
  projects: [],
  tiers: [],
  flows: [],
  defaultFlow: null
};

// Bounds on an upstream answer. The gateway is local and trusted, but a
// normalizer that is not total is a normalizer that eventually renders `[object
// Object]` into a menu the user then posts back as a correction.
const MAX_VALUE = 200;
const MAX_ITEMS = 200;

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) : s;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : [];
}

function strings(value: unknown): string[] {
  const out: string[] = [];
  for (const item of list(value)) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Shape the gateway's `/route/options` into the card's vocabulary. Total: any
 *  field the gateway did not send (or sent in another shape) becomes an empty
 *  list, never a crash and never an undefined the menus would iterate. */
export function normalizeRouteOptions(raw: unknown): RouteVocabulary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_VOCABULARY };
  const src = raw as Record<string, unknown>;
  const targets: RouteTargetOption[] = [];
  for (const item of list(src.targets)) {
    const t = (item ?? {}) as Record<string, unknown>;
    const id = str(t.id);
    if (!id) continue;
    targets.push({ id, runtime: str(t.runtime), model: str(t.model), effort: str(t.effort) });
  }
  const duties: RouteDutyOption[] = [];
  for (const item of list(src.duties)) {
    const d = (item ?? {}) as Record<string, unknown>;
    const id = str(d.id);
    if (!id) continue;
    duties.push({ id, title: str(d.title) });
  }
  const accounts: RouteAccountOption[] = [];
  for (const item of list(src.accounts)) {
    const a = typeof item === "string" ? { name: item } : ((item ?? {}) as Record<string, unknown>);
    const name = str(a.name);
    if (!name) continue;
    accounts.push({ name, platform: str(a.platform) });
  }
  const flows: RouteFlowOption[] = [];
  for (const item of list(src.flows)) {
    const f = (item ?? {}) as Record<string, unknown>;
    const id = str(f.id);
    if (!id) continue;
    flows.push({ id, description: str(f.description), phases: strings(f.phases) });
  }
  return {
    targets,
    duties,
    efforts: strings(src.efforts),
    accounts,
    projects: strings(src.projects),
    tiers: strings(src.tiers),
    flows,
    defaultFlow: str(src.defaultFlow)
  };
}

// ── The decision under judgement ─────────────────────────────────────────────

/** The slice of a decision row the card reads. Structural on purpose: the feed's
 *  `DecisionView` satisfies it, and this module stays free of the reader (which
 *  imports `node:path`). */
export interface DecisionSpecSource {
  target?: string | null;
  model?: string | null;
  effort?: string | null;
  duty?: string | null;
  tier?: string | null;
  flow?: string | null;
  level?: number | null;
}

export interface FeedbackDecision extends DecisionSpecSource {
  id: string;
  sessionId?: string | null;
}

/**
 * LEVEL is not a correctable dimension today: `CORRECTION_FIELDS` (the closed
 * vocabulary `sanitizeCorrection` enforces) has no `level`, so a level sent in
 * `resolved` or `correction` would be dropped on the way to the queue — a silent
 * lie to whoever tapped it. The card therefore shows the level as part of the
 * duty it belongs to rather than as a separate tappable dimension.
 *
 * This is a runtime probe rather than a hardcoded `false` so that the day `level`
 * joins that vocabulary, both surfaces start carrying it with no further change.
 */
export const LEVEL_IS_CORRECTABLE: boolean = (CORRECTION_FIELDS as readonly string[]).includes("level");

/** What this decision actually resolved to, in the run-spec vocabulary — recorded
 *  alongside a correction so the Improver sees the delta without re-reading the log.
 *
 *  FLOW is the reason this lives here rather than inline in one panel: the
 *  autonomy reader keys a verdict's evidence on `original.flow` first, so a
 *  `resolved` without it lands every verdict on the duty track instead of the
 *  flow track it belongs to. Both surfaces now fill it from the same function. */
export function resolvedSpec(decision: DecisionSpecSource | null | undefined): Correction {
  const out: Correction = {};
  if (!decision) return out;
  if (decision.target) out.target = decision.target;
  if (decision.model) out.model = decision.model;
  if (decision.effort) out.effort = decision.effort;
  if (decision.duty) out.duty = decision.duty;
  if (decision.tier) out.tier = decision.tier;
  if (decision.flow) out.flow = decision.flow;
  if (LEVEL_IS_CORRECTABLE && typeof decision.level === "number") {
    Object.assign(out, { level: String(decision.level) });
  }
  return out;
}

/** Card order: the dimensions §8.2 names first (flow, duty, model — level rides
 *  with the duty, see LEVEL_IS_CORRECTABLE), then the rest of the run spec in its
 *  own order. Derived from CORRECTION_FIELDS so a new dimension appears here
 *  automatically instead of being silently uncorrectable. */
const LEAD_FIELDS: readonly string[] = ["flow", "duty", "model"];

export const CARD_FIELD_ORDER: CorrectionField[] = [
  ...CORRECTION_FIELDS.filter((f) => LEAD_FIELDS.includes(f)).sort(
    (a, b) => LEAD_FIELDS.indexOf(a) - LEAD_FIELDS.indexOf(b)
  ),
  ...CORRECTION_FIELDS.filter((f) => !LEAD_FIELDS.includes(f))
];

/** The dimensions this particular decision can be corrected on: the ones it
 *  actually resolved a value for. Offering "account" on a row that never named an
 *  account asks the user to correct something they were never shown. */
export function correctableFields(decision: DecisionSpecSource | null | undefined): CorrectionField[] {
  const spec: Correction = resolvedSpec(decision);
  return CARD_FIELD_ORDER.filter((field) => Boolean(spec[field]));
}

/** Human names for the wire names. camelCase uppercases into identifiers, not
 *  words, so only the ones that need it are listed. */
export const FIELD_LABEL: Partial<Record<CorrectionField, string>> = {
  phasesOff: "phases off"
};

export function fieldLabel(field: CorrectionField): string {
  return FIELD_LABEL[field] ?? field;
}

// ── The menus ────────────────────────────────────────────────────────────────

export interface FieldOption {
  value: string;
  /** Secondary line — what the value IS, not a second name for it. */
  detail?: string;
}

/**
 * The real choices for one dimension, from the gateway's live policy. An empty
 * list means "no vocabulary for this dimension here" and is the signal for the
 * typed fallback — never rendered as an empty menu.
 *
 * Pure, so the whole vocabulary is unit-testable without a DOM or a gateway.
 */
export function optionsForField(
  field: CorrectionField,
  vocab: RouteVocabulary | null | undefined,
  decision?: DecisionSpecSource | null
): FieldOption[] {
  if (!vocab) return [];
  switch (field) {
    case "target":
      return vocab.targets.map((t) => ({
        value: t.id,
        detail: [t.runtime, t.model].filter(Boolean).join(" / ") || undefined
      }));
    case "model": {
      // There is no model catalogue anywhere in the repo; the targets ARE the
      // list of models this composition can actually reach.
      const seen = new Set<string>();
      const out: FieldOption[] = [];
      for (const t of vocab.targets) {
        if (!t.model || seen.has(t.model)) continue;
        seen.add(t.model);
        out.push({ value: t.model, detail: `from target ${t.id}` });
      }
      return out;
    }
    case "effort":
      return vocab.efforts.map((value) => ({ value }));
    case "duty":
      return vocab.duties.map((d) => ({ value: d.id, detail: d.title && d.title !== d.id ? d.title : undefined }));
    case "tier":
      return vocab.tiers.map((value) => ({ value }));
    case "account":
      return vocab.accounts.map((a) => ({ value: a.name, detail: a.platform ?? undefined }));
    case "project":
      return vocab.projects.map((value) => ({ value }));
    case "flow":
      return vocab.flows.map((f) => ({
        value: f.id,
        detail: [
          f.id === vocab.defaultFlow ? "default plan" : null,
          f.description || (f.phases.length ? f.phases.join(" → ") : null)
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }));
    case "phasesOff": {
      // The phases of the plan this decision actually ran (or the default one):
      // an OFF list naming a phase from another plan disables nothing.
      const id = decision?.flow ?? vocab.defaultFlow;
      const flow = vocab.flows.find((f) => f.id === id);
      return (flow?.phases ?? []).map((value) => ({ value, detail: `phase of ${flow?.id}` }));
    }
    default:
      return [];
  }
}

// ── The wire ─────────────────────────────────────────────────────────────────

export const ROUTE_OPTIONS_ENDPOINT = "/api/orchestrator/route-options";
export const VERDICT_ENDPOINT = "/api/orchestrator/decisions";

export interface VerdictPayload {
  decisionId: string;
  verdict: Verdict;
  resolved?: Correction;
  correction?: Correction;
  sessionId?: string | null;
}

/** The one payload builder both surfaces use. A correction with no dimensions is
 *  omitted rather than sent as `{}` — a bare "wrong" is a weaker signal, not a
 *  malformed one, and the store already records it as such. */
export function verdictPayload(
  decision: FeedbackDecision,
  verdict: Verdict,
  correction?: Correction | null
): VerdictPayload {
  const resolved = resolvedSpec(decision);
  const named = correction
    ? (Object.fromEntries(
        Object.entries(correction).filter(([, v]) => typeof v === "string" && v.trim().length > 0)
      ) as Correction)
    : {};
  return {
    decisionId: decision.id,
    verdict,
    ...(Object.keys(resolved).length ? { resolved } : {}),
    ...(Object.keys(named).length ? { correction: named } : {}),
    sessionId: decision.sessionId ?? null
  };
}

/** POST one verdict. Throws on a non-2xx so a surface can show that the answer
 *  was NOT recorded; a silently dropped verdict leaves the user believing they
 *  corrected something they did not. */
export async function postVerdict(
  payload: VerdictPayload,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const res = await fetchImpl(VERDICT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Read the routing vocabulary through the shell's proxy. Never throws: a
 *  gateway that is not answering is a normal state of this page (the operative is
 *  not running), and it must degrade to typed corrections, not to a broken card. */
export async function fetchRouteOptions(fetchImpl: typeof fetch = fetch): Promise<RouteOptionsResponse> {
  const unavailable = (reason: string): RouteOptionsResponse => ({
    ...EMPTY_VOCABULARY,
    available: false,
    reason
  });
  try {
    const res = await fetchImpl(ROUTE_OPTIONS_ENDPOINT, { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data || data.available === false) {
      const reason = typeof data?.reason === "string" ? data.reason : `route options unavailable (HTTP ${res.status})`;
      return unavailable(reason);
    }
    return { ...normalizeRouteOptions(data), available: true, reason: null };
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  }
}

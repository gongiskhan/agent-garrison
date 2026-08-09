// Decision verdicts (RUN-SPEC-V1) — the user's answer to "was that the right call?"
//
// The premise of the whole change: everything defaults to AUTO, so most decisions
// on a normal day are the orchestrator's. That is only safe if the orchestrator
// can be corrected, and correction only compounds if it is CAPTURED. This module is
// the capture.
//
// It deliberately creates NO new store. `~/.garrison/improver/feedback-queue.jsonl`
// already exists, already has a writer contract (the gateway's
// `buildOverrideRecord`), and already has a consumer (the Improver's `feedback`
// rule, which turns operator answers into REVIEWABLE proposals and never
// auto-applies them). Until now that queue had exactly one producer — regex
// phrase-matching on the user's message ("run the full pipeline") — and on this box
// it has never been written to at all. A verdict from the Decisions panel is a far
// stronger signal than a phrase match: a human looked at a specific resolved route
// and said it was wrong, and said what it should have been.
//
// The record is APPEND-ONLY and carries no user prose: the decision handle, the
// verdict, and (optionally) the counterfactual expressed in the SAME run-spec
// vocabulary the dropdowns speak. No free text means nothing to redact, which is
// what keeps this consistent with the feed's strict no-user-content posture.
//
// PURE BY CONSTRUCTION — no `node:` imports, no filesystem. The Decisions panel is
// a "use client" component and imports the vocabulary from here, so a single
// `node:path` import in this file drags a Node builtin into the browser bundle and
// the Next build fails outright. The queue writer lives in
// `decision-verdicts-store.ts`; only the API route imports that.

/** A verdict is deliberately three-valued. "unsure" is not a shrug — it is the
 *  honest answer for a route the user cannot evaluate, and recording it is what
 *  stops the Improver from reading silence as approval. */
export const VERDICTS = ["right", "wrong", "unsure"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The dimensions a correction can name — exactly the run spec, so the correction
 *  UI is the same set of menus the run was decided with. */
export const CORRECTION_FIELDS = [
  "target",
  "model",
  "effort",
  "duty",
  "tier",
  "account",
  "project",
  "flow",
  "phasesOff"
] as const;
export type CorrectionField = (typeof CORRECTION_FIELDS)[number];
export type Correction = Partial<Record<CorrectionField, string>>;

export interface DecisionVerdictInput {
  decisionId: string;
  verdict: Verdict;
  /** What the decision actually resolved to — recorded alongside the correction so
   *  the Improver can see the delta without re-reading the whole decision log. */
  resolved?: Correction;
  /** What the user would have chosen instead. Only meaningful for "wrong", but not
   *  ENFORCED as such: a "right" verdict with a note that one axis was off is real
   *  feedback, and refusing to record it would just lose it. */
  correction?: Correction;
  sessionId?: string | null;
  at?: string;
}

function cleanId(raw: unknown, max = 200): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > max) return null;
  // Same posture as every other id crossing this boundary. Control characters
  // would corrupt the one-record-per-line queue format; path separators have no
  // business in a lookup key and are refused so no value here can ever be mistaken
  // for a filename by a later consumer.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (s.includes("/") || s.includes("\\")) return null;
  return s;
}

/** Keep only the known dimensions, and only as clean scalars. Returns undefined for
 *  an empty correction so an "I don't know what it should have been" verdict does
 *  not record an empty object that reads like a deliberate blank. */
export function sanitizeCorrection(raw: unknown): Correction | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Correction = {};
  for (const field of CORRECTION_FIELDS) {
    const value = cleanId(src[field], 400);
    if (value) out[field] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Build the queue record. PURE, so the shape is unit-tested without a filesystem.
 *
 * `area: "orchestrator"` and the `original`/`applied` pair mirror the gateway's
 * `buildOverrideRecord` exactly — that is the shape `feedback-rule.mjs` already
 * knows how to read, and matching it means the Improver needed one new branch
 * rather than a new parser.
 *
 * Returns null for an unusable input (no decision handle, or a verdict outside the
 * vocabulary) rather than writing a record nothing can interpret.
 */
export function buildVerdictRecord(input: DecisionVerdictInput): Record<string, unknown> | null {
  const decisionId = cleanId(input?.decisionId, 64);
  if (!decisionId) return null;
  if (!VERDICTS.includes(input?.verdict)) return null;
  const correction = sanitizeCorrection(input.correction);
  const resolved = sanitizeCorrection(input.resolved);
  const sessionId = cleanId(input.sessionId, 200);
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    area: "orchestrator",
    question: "decision-verdict",
    // The answer vocabulary is CLOSED (right/wrong/unsure), so the Improver's
    // categorizer never has to guess at prose.
    answer: input.verdict,
    decision_id: decisionId,
    ...(resolved ? { original: resolved } : {}),
    ...(correction ? { applied: correction } : {}),
    timestamp: input.at ?? new Date().toISOString(),
    provenance: "decision-verdict"
  };
}

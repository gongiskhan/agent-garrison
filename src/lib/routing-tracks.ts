// routing-tracks.ts — the router's track record, DERIVED from evidence.
//
// The autonomy bands need to know how often the router gets a shape right. The
// obvious implementation is a counter updated on every decision, and it is the
// wrong one: a counter is state that can drift from the evidence it claims to
// summarise, and when it drifts the system becomes confident for reasons nobody
// can reconstruct. That is precisely the failure the brief is trying to end.
//
// So there is no counter. Tracks are folded fresh from the two append-only logs
// that already exist:
//
//   • the state service's feedback queue (GET /v1/feedback) — every verdict
//     Gonçalo gave, with the per-dimension correction attached
//     (decision-verdicts.ts). That queue is SHARED: the gateway's conversational
//     overrides and the Improver's probe answers append to it too, so a reader
//     here has to recognise a verdict rather than assume every row is one. The
//     service joins tombstoned rows out before we ever see them.
//   • `<composition>/.garrison/decisions.jsonl` — every routing decision, incl.
//     turn-overrides and escalations
//
// Every number the band shows can therefore be traced back to a line someone can
// read. Deleting a wrong inference means deleting the record that caused it,
// which is exactly what the brief's §8.3 "delete wrong inferences" needs.

import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readFileTolerant } from "./atomic-write";
import { DECISIONS_REL } from "./decisions-feed";
import { withState } from "./state-client";

const AUTONOMY_CORE_PATH = path.join(
  process.cwd(),
  "fittings/seed/orchestrator/lib/routing-autonomy.mjs"
);

export interface AutonomyBand {
  band: "ask" | "act-revert" | "act-inform";
  confidence: number;
  reversibility: string;
  delaySeconds: number;
}

export interface TrackSummary {
  category: string;
  shape: string;
  observations: number;
  /** Which signals produced this record, so a number is always traceable. */
  signals: Record<string, number>;
  band: AutonomyBand;
}

interface AutonomyCore {
  emptyTrack: (o?: Record<string, unknown>) => Record<string, unknown>;
  recordSignal: (t: unknown, kind: string, o?: { at?: string | null }) => Record<string, unknown>;
  bandFor: (t: unknown, o?: Record<string, unknown>) => AutonomyBand;
  confidenceOf: (t: unknown, th?: unknown) => number;
  seedFromHistory: (e: unknown[], o?: Record<string, unknown>) => Record<string, unknown>;
  trackKey: (category: string, shape: string) => string;
  CATEGORIES: readonly string[];
  DEFAULT_THRESHOLDS: Record<string, number>;
}

let cached: Promise<AutonomyCore> | null = null;
export function loadAutonomyCore(): Promise<AutonomyCore> {
  cached ??= import(/* webpackIgnore: true */ pathToFileURL(AUTONOMY_CORE_PATH).href) as Promise<AutonomyCore>;
  return cached;
}

/** One piece of evidence, normalised out of whichever log it came from. */
export interface Evidence {
  category: string;
  shape: string;
  signal: string;
  at: string | null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v : null;

/** A record's sub-map, or an empty one. Anything that is not a plain object is
 *  treated as absent rather than indexed into, since these lines come off a
 *  shared append-only log that several writers and the occasional hand edit
 *  touch. */
const submap = (v: unknown): Record<string, unknown> =>
  !v || typeof v !== "object" || Array.isArray(v) ? {} : (v as Record<string, unknown>);

/** The `provenance` stamp `buildVerdictRecord` writes, and the discriminator the
 *  Improver's `feedback-rule.mjs` keys on for the same records. The queue also
 *  carries `override` records from the gateway and `probe` / `retrospective`
 *  records from the Improver: those are real evidence about other things and
 *  MUST NOT be read as verdicts, because their `answer` is free-ish text rather
 *  than this closed vocabulary. */
const VERDICT_PROVENANCE = "decision-verdict";

/**
 * Turn one feedback-queue line into evidence.
 *
 * The field names here are the PRODUCER's, not this reader's invention.
 * `buildVerdictRecord` (decision-verdicts.ts) writes `answer` (right | wrong |
 * unsure), `original` (what the decision actually resolved to), `applied` (the
 * counterfactual the user typed), and `timestamp`. This function used to read
 * `verdict` / `resolved` / `at` - a shape nothing has ever written - so every
 * real verdict folded to zero evidence and no band could improve from a verdict
 * tap, while the suite passed on fixtures in the same fictional shape. There is
 * no compat branch for it: the queue on disk has never held a line of that shape,
 * so accepting one would be dead code pretending to be caution.
 *
 * A verdict names the dimensions it corrects, so a "wrong" that corrects the flow
 * is evidence about FLOW selection and says nothing about level selection - which
 * is why the bands are per category. A verdict with no correction is a weaker
 * thing than one that carries the right answer.
 *
 * `redo-with-overrides`, the strongest signal in the registry, is deliberately
 * NOT produced here: a verdict is described, never demonstrated, and no producer
 * records a redo onto one. Whoever wires a real redo path adds it then.
 */
export function evidenceFromVerdict(raw: unknown): Evidence[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  if (str(r.provenance) !== VERDICT_PROVENANCE) return []; // another producer's record
  const verdict = str(r.answer);
  // The vocabulary is CLOSED (right | wrong | unsure). Anything else is not a
  // verdict, and must not fall through to the "wrong" branch - inventing a
  // correction out of an unrecognised value would train the router on noise.
  if (verdict !== "right" && verdict !== "wrong") return []; // incl. "unsure": not evidence
  const at = str(r.timestamp);
  const original = submap(r.original);
  const applied = submap(r.applied);
  // The shape is what the router DECIDED, never the counterfactual: evidence about
  // a bad call belongs on the track of the shape that was chosen, not on the track
  // of the one the user would have preferred.
  //
  // Both eras are read here, and the order is what makes that work.
  //
  // Current producers DO carry the flow: the home Router card and the Decisions
  // panel both fill `original` from the shared `resolvedSpec`
  // (src/lib/decision-feedback.ts), which includes it - so a fresh verdict lands
  // on the flow track it belongs to.
  //
  // The duty fallback is for the records written BEFORE that: `original` was
  // filled from the decision row, which is {target, model, effort, duty, tier},
  // so those verdicts have no flow to key on and the duty is the only shape they
  // carry. It is the same fallback evidenceFromDecision makes for the same
  // reason, which is what keeps the two logs folding into the same tracks
  // instead of two disjoint sets.
  const shape = str(original.flow) ?? str(original.duty) ?? "unknown";

  if (verdict === "right") {
    return [
      { category: "flow", shape, signal: "explicit-confirmation", at },
      { category: "level", shape, signal: "explicit-confirmation", at }
    ];
  }
  // wrong: attribute the correction to the dimensions it actually names.
  const out: Evidence[] = [];
  if (str(applied.flow)) out.push({ category: "flow", shape, signal: "explicit-negative", at });
  if (str(applied.tier) || str(applied.duty)) {
    out.push({ category: "level", shape, signal: "explicit-negative", at });
  }
  // A "wrong" that named neither category still counts against both. Two cases
  // land here and both are honestly the same one: no counterfactual at all, and a
  // counterfactual that only names dimensions these bands do not track (target,
  // model, effort, account, project, phasesOff). Either way the user says the call
  // was wrong without saying which half of the routing caused it, so the
  // pessimistic reading is the correct one - being told it was wrong is
  // information even without the answer.
  if (!out.length) {
    out.push(
      { category: "flow", shape, signal: "explicit-negative", at },
      { category: "level", shape, signal: "explicit-negative", at }
    );
  }
  return out;
}

/** Turn one decisions.jsonl record into evidence. */
export function evidenceFromDecision(raw: unknown): Evidence[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const at = str(r.at);
  // Flows were never recorded on decisions before this run, and 942 turn-overrides
  // are already on disk. Falling back to the DUTY keeps that evidence usable per
  // shape instead of collapsing every one of them into a single "unknown" bucket.
  const shape = str(r.flow) ?? str(r.duty) ?? str(r.taskType) ?? "unknown";
  if (str(r.kind) === "escalation" && r.applied === true) {
    return [{ category: "level", shape, signal: "escalation", at }];
  }
  if (str(r.via) === "turn-override") {
    // A pin set before the run. Which dimension it corrects is what it pinned.
    const out: Evidence[] = [];
    if (str(r.flow)) out.push({ category: "flow", shape, signal: "manual-override", at });
    if (r.level !== undefined && r.level !== null) {
      out.push({ category: "level", shape, signal: "manual-override", at });
    }
    return out;
  }
  return [];
}

function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // A malformed line is skipped, never fatal: this is a read path over an
      // append-only log that several writers share.
    }
  }
  return out;
}

/**
 * The feedback queue's DELETE contract, read side — PRE-MESH, off the live path.
 *
 * §8.3 of the brief needs a wrong inference to be deletable, and the whole point
 * of deriving tracks rather than counting them is that deleting the record
 * deletes its effect on the band. The service enforces that in SQL now: the
 * reader joins out every row whose `id` or `legacy_key` a tombstone names, so
 * `readEvidence` above never sees a deleted record.
 *
 * This parser survives for the one job the SQL cannot do: reading a leftover
 * `feedback-queue.jsonl(.pre-mesh)`. Its two key derivations MUST therefore stay
 * byte-identical to `fittings/seed/improver/lib/feedback-signals.mjs`
 * (`keyForRecord` / `derivedKeyForLine`) and to the importer's, which is what
 * computed the `legacy_key` column for every id-less historical record.
 * `tests/improver-signals.test.ts` pins them together.
 */
const TOMBSTONE_KIND = "tombstone";

function derivedKeyForLine(rawLine: string): string {
  return `raw:${createHash("sha256").update(rawLine.trim()).digest("hex").slice(0, 32)}`;
}

function keyForLine(record: unknown, rawLine: string): string {
  const id =
    record && typeof record === "object" && typeof (record as Record<string, unknown>).id === "string"
      ? ((record as Record<string, unknown>).id as string).trim()
      : "";
  return id.length ? id : derivedKeyForLine(rawLine);
}

/** Parse the feedback queue, dropping every record a tombstone deletes. */
export function parseFeedbackQueue(text: string): unknown[] {
  const rows: Array<{ record: unknown; key: string }> = [];
  const deleted = new Set<string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let record: unknown;
    try {
      record = JSON.parse(t);
    } catch {
      continue;
    }
    const r = record as Record<string, unknown>;
    if (r && typeof r === "object" && r.kind === TOMBSTONE_KIND) {
      if (typeof r.target === "string" && r.target.trim()) deleted.add(r.target.trim());
      continue; // a tombstone is not itself evidence
    }
    rows.push({ record, key: keyForLine(record, t) });
  }
  return rows.filter((row) => !deleted.has(row.key)).map((row) => row.record);
}

/** Retired duty -> successor, so a shape read off an old record does not appear
 *  as a separate track from the duty that absorbed it. */
const SHAPE_ALIASES: Record<string, string> = { code: "implement" };
const adoptShape = (shape: string) => SHAPE_ALIASES[shape] ?? shape;

/**
 * Seconds within which repeated identical evidence counts once.
 *
 * The live decisions log holds 784 `image` turn-overrides logged at ~15-second
 * intervals inside a single afternoon. That is Drill's vision path pinning the
 * duty on every call, not a person correcting the router 784 times, and feeding
 * it in raw would hand one machine loop 784 votes about how the router is doing.
 * Counting DISTINCT OCCASIONS rather than events is the honest measure, and it
 * costs nothing when the evidence really is 784 separate human decisions.
 */
export const BURST_WINDOW_SECONDS = 300;

/** Collapse runs of identical evidence inside the burst window. */
export function collapseBursts(evidence: Evidence[], windowSeconds = BURST_WINDOW_SECONDS): Evidence[] {
  const lastAt = new Map<string, number>();
  const out: Evidence[] = [];
  for (const e of evidence) {
    const key = `${e.category}|${e.shape}|${e.signal}`;
    const t = e.at ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(t)) {
      // No usable timestamp: keep it rather than guess, since dropping evidence
      // is worse than over-counting one record.
      out.push(e);
      continue;
    }
    const prev = lastAt.get(key);
    if (prev !== undefined && Math.abs(t - prev) < windowSeconds * 1000) continue;
    lastAt.set(key, t);
    out.push(e);
  }
  return out;
}

/** How many feedback rows a fold walks, paged. A ceiling on work rather than a
 *  silent truncation at the service's default page size. */
const FEEDBACK_READ_LIMIT = 5000;
const FEEDBACK_PAGE = 500;

/** Every live feedback record, oldest first. The service's reader has already
 *  dropped the rows a tombstone names, which is the half this fold depends on:
 *  deleting the record is what deletes the inference. */
async function readFeedbackRecords(): Promise<unknown[]> {
  return withState(async (client) => {
    const out: unknown[] = [];
    let sinceSeq = 0;
    while (out.length < FEEDBACK_READ_LIMIT) {
      const size = Math.min(FEEDBACK_PAGE, FEEDBACK_READ_LIMIT - out.length);
      const page = (await client.listFeedback({ sinceSeq, limit: size })) as Array<{
        seq: number;
        payload?: unknown;
      }>;
      if (!page.length) break;
      for (const row of page) out.push(row.payload ?? {});
      sinceSeq = page[page.length - 1].seq;
      // The tombstone join runs in SQL BEFORE the LIMIT, so a short page means
      // the scan reached the end, not that the rest was filtered away.
      if (page.length < size) break;
    }
    return out;
  });
}

/**
 * Read every piece of evidence: the feedback queue from the state service, the
 * decisions log from the composition's own directory (high-volume audit, node-local
 * by design).
 *
 * An unreachable state service THROWS rather than folding to zero evidence. Silent
 * emptiness here would read as "the router has no track record", which is a
 * different claim from "the evidence store is unreachable" and would quietly move
 * every band back to `ask`.
 */
export async function readEvidence(compositionDir: string): Promise<Evidence[]> {
  const [verdicts, decisions] = await Promise.all([
    readFeedbackRecords(),
    readFileTolerant(path.join(compositionDir, DECISIONS_REL))
  ]);
  const all = [
    ...verdicts.flatMap(evidenceFromVerdict),
    ...parseJsonl(decisions.exists ? decisions.text : "").flatMap(evidenceFromDecision)
  ].map((e) => ({ ...e, shape: adoptShape(e.shape) }));
  return collapseBursts(all);
}

/**
 * Fold evidence into a track per (category, shape) and report each one's band.
 *
 * `seed` is the Phase 0 cold-start history — historical tasks labelled with the
 * flow that SHOULD have run. It is folded in at silence weight so a brand-new
 * library does not ask about everything in week one, without ever letting
 * inferred history buy a band Gonçalo did not grant.
 */
export async function summariseTracks(
  compositionDir: string,
  { seed = [] as unknown[], action = "code-change" } = {}
): Promise<TrackSummary[]> {
  const core = await loadAutonomyCore();
  const evidence = await readEvidence(compositionDir);
  const tracks: Record<string, Record<string, unknown>> = core.seedFromHistory(seed) as Record<
    string,
    Record<string, unknown>
  >;
  const signals: Record<string, Record<string, number>> = {};

  for (const e of evidence) {
    const key = core.trackKey(e.category, e.shape);
    tracks[key] = core.recordSignal(tracks[key] ?? core.emptyTrack(), e.signal, { at: e.at });
    signals[key] ??= {};
    signals[key][e.signal] = (signals[key][e.signal] ?? 0) + 1;
  }

  return Object.entries(tracks)
    .map(([key, track]) => {
      const sep = key.indexOf(":");
      return {
        category: key.slice(0, sep),
        shape: key.slice(sep + 1),
        observations: Number(track.observations ?? 0),
        signals: signals[key] ?? {},
        band: core.bandFor(track, { action })
      };
    })
    .sort((a, b) => a.band.confidence - b.band.confidence || a.shape.localeCompare(b.shape));
}

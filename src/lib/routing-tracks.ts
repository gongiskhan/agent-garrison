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
//   • `improver/feedback-queue.jsonl` — every verdict Gonçalo gave, with the
//     per-dimension correction attached (decision-verdicts.ts)
//   • `<composition>/.garrison/decisions.jsonl` — every routing decision, incl.
//     turn-overrides and escalations
//
// Every number the band shows can therefore be traced back to a line someone can
// read. Deleting a wrong inference means deleting the record that caused it,
// which is exactly what the brief's §8.3 "delete wrong inferences" needs.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileTolerant } from "./atomic-write";
import { DECISIONS_REL } from "./decisions-feed";
import { feedbackQueuePath } from "./decision-verdicts-store";

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

/**
 * Turn one verdict record into evidence.
 *
 * A verdict names the dimensions it corrects, so a "wrong" that corrects the flow
 * is evidence about FLOW selection and says nothing about level selection — which
 * is why the bands are per category. A verdict with no correction is a weaker
 * thing than one that carries the right answer, and `redo` is the strongest of
 * all because the correction was demonstrated rather than described.
 */
export function evidenceFromVerdict(raw: unknown): Evidence[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const verdict = str(r.verdict);
  // The vocabulary is CLOSED (right | wrong | unsure). Anything else is not a
  // verdict, and must not fall through to the "wrong" branch — inventing a
  // correction out of an unrecognised value would train the router on noise.
  if (verdict !== "right" && verdict !== "wrong") return []; // incl. "unsure": not evidence
  const at = str(r.at);
  const resolved = (r.resolved ?? {}) as Record<string, unknown>;
  const applied = (r.applied ?? {}) as Record<string, unknown>;
  const shape = str(resolved.flow) ?? str(r.flow) ?? str(resolved.duty) ?? "unknown";

  if (verdict === "right") {
    return [
      { category: "flow", shape, signal: "explicit-confirmation", at },
      { category: "level", shape, signal: "explicit-confirmation", at }
    ];
  }
  // wrong: attribute the correction to the dimensions it actually names.
  const signal = r.redo === true ? "redo-with-overrides" : "explicit-negative";
  const out: Evidence[] = [];
  if (applied.flow !== undefined) out.push({ category: "flow", shape, signal, at });
  if (applied.tier !== undefined || applied.duty !== undefined) {
    out.push({ category: "level", shape, signal, at });
  }
  // A "wrong" with no correction still counts against both, just as the weaker
  // signal — being told it was wrong is information even without the answer.
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

/** Read every piece of evidence currently on disk. */
export async function readEvidence(compositionDir: string): Promise<Evidence[]> {
  const [verdicts, decisions] = await Promise.all([
    readFileTolerant(feedbackQueuePath()),
    readFileTolerant(path.join(compositionDir, DECISIONS_REL))
  ]);
  const all = [
    ...parseJsonl(verdicts.exists ? verdicts.text : "").flatMap(evidenceFromVerdict),
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

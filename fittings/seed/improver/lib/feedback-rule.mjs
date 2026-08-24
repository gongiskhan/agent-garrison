// feedback-rule.mjs — the Improver's consumer of the feedback queue
// (GARRISON-FLOW-V2 S8, D27). Three producers append to ONE queue, the state
// service's `feedback_queue` table: the Probe (probe/retrospective
// records), the gateway (conversational-override records), and the Decisions
// panel (decision-verdict records). This rule reads that queue and turns
// the operator's EXPLICIT answers into reviewable policy proposals — phase-plan
// changes, matrix-cell effort steps, and kind-matcher reviews — routed through the
// SAME review queue as every other Improver rule and rendered in the composer as
// ghost edits. NEVER auto-applied.
//
// These are HIGH-WEIGHT signals (a human tapped an answer, not a heuristic over
// logs), so the min-sample bar is lower than the coordination rule's. "dismissed"
// answers (Escape/timeout, D26) carry NO signal and are ignored.
//
// The ANALYSIS is pure (analyzeFeedbackProposals) so it unit-tests without a
// filesystem; the collector does the I/O.
import { createHash } from "node:crypto";
import { feedbackQueuePath as queuePath, readFeedbackQueue, liveRecords } from "./feedback-signals.mjs";

const shortHash = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

// ── Collector (I/O) ───────────────────────────────────────────────────────────
export { queuePath as feedbackQueuePath };

/**
 * The records this rule learns from: every queue line EXCEPT the ones a
 * tombstone deletes.
 *
 * The delete path is what makes this filter load-bearing. A wrong inference is
 * corrected by deleting the record that caused it (Signals view → DELETE
 * /api/signals/:id, which appends a tombstone), and that correction is only real
 * if the next nightly run stops counting the record. The tombstone join now runs
 * in the service, so this consumer, the Signals API and the shell's autonomy
 * bands read the same rows by construction rather than by three matching
 * implementations.
 *
 * `cap` bounds the SURVIVING records rather than the raw rows: a deleted record
 * must not go on consuming a slot it was removed from. It doubles as the read
 * ceiling handed to the service.
 *
 * ASYNC since the queue became a service call; there is no file to read and no
 * fallback if it is unreachable — the nightly run's caller logs and skips the
 * rule rather than proposing from an evidence set it could not load.
 */
export async function collectFeedback({ client, cap = 2000 } = {}) {
  const { entries } = await readFeedbackQueue({ client, limit: cap });
  return liveRecords(entries).slice(0, cap);
}

// ── Pure analysis (D27) ───────────────────────────────────────────────────────
// Direction categories a record's answer maps to, per provenance. `null` = no
// signal (a "right call" / "went well" / dismissed answer proposes nothing).
// The run dimensions a decision verdict can correct, split by WHAT they change:
// which engine ran the work, vs which pipeline the work walked. The two produce
// different proposals against different parts of the policy, so they are counted
// separately rather than collapsed into the existing deeper/lighter axis (a
// correction from haiku to opus is not "deeper", it is a different cell).
const COMPUTE_DIMENSIONS = ["target", "model", "effort", "account"];
const PLAN_DIMENSIONS = ["flow", "phasesOff", "duty", "tier"];

/** The first corrected dimension of a decision verdict, as {field, value}, or null
 *  when the user said it was wrong without saying what it should have been (still
 *  a real signal — just a weaker one, categorized as "poor"). */
function correctedDimension(rec) {
  const applied = rec?.applied;
  if (!applied || typeof applied !== "object") return null;
  for (const field of [...COMPUTE_DIMENSIONS, ...PLAN_DIMENSIONS]) {
    const value = applied[field];
    if (typeof value === "string" && value.trim()) return { field, value: value.trim() };
  }
  return null;
}

function categorize(rec) {
  const answer = String(rec?.answer ?? "").trim().toLowerCase();
  if (!answer || answer === "dismissed") return null;
  // RUN-SPEC-V1: an explicit verdict from the Decisions panel. The answer
  // vocabulary is CLOSED (right / wrong / unsure), so there is nothing to
  // pattern-match and nothing to guess at.
  if (rec.provenance === "decision-verdict") {
    // Agreement records nothing, exactly as it does for every other producer here:
    // the queue is a record of corrections, and treating "that was right" as a
    // signal would let ordinary approval drift the policy. "unsure" is likewise
    // deliberately inert — it exists so the user can answer honestly, not so it
    // can vote.
    if (answer !== "wrong") return null;
    const corrected = correctedDimension(rec);
    if (!corrected) return "poor"; // wrong, but the user did not say what instead
    return COMPUTE_DIMENSIONS.includes(corrected.field) ? "retarget" : "replan";
  }
  if (rec.provenance === "override") {
    const plan = rec?.applied?.plan || null;
    if (plan === "full") return "deeper";
    if (plan === "quick") return "lighter";
    return null;
  }
  // probe (orchestrator/went-well) + retrospective share the deterministic option labels.
  if (/(go deeper|run the full pipeline|gone deeper)/.test(answer)) return "deeper";
  if (/(overkill|too heavy|run less|should have run less)/.test(answer)) return "lighter";
  if (/wrong task type/.test(answer)) return "wrong-type";
  if (/(needed rework|wrong approach)/.test(answer)) return "poor";
  return null; // "right call" / "that was right" / "went well" / "rough but done"
}

function kindOf(rec) {
  // A decision verdict groups by the CORRECTION, not by flow: three verdicts
  // all saying "this should have run on cc-opus-high" are one accumulating signal
  // about that dimension, while three verdicts about three different dimensions are
  // three separate observations that should not add up to a proposal.
  if (rec?.provenance === "decision-verdict") {
    const corrected = correctedDimension(rec);
    return corrected ? `${corrected.field}=${corrected.value}` : "(no counterfactual)";
  }
  if (rec?.provenance === "override") return rec?.applied?.flow || rec?.original?.flow || "(unspecified)";
  return rec?.classification?.kind || "(unspecified)";
}

// The bar a tally must clear before it becomes a proposal. Exported so the
// Signals view can tell the operator how far a given group still is from
// producing one, instead of showing a row with no stated consequence.
export const DEFAULT_MIN_SIGNAL = 2;

/** What this rule makes of one record: its direction category (null = no signal)
 *  and the group it accumulates into. The Signals view renders this so a row can
 *  say which rule it feeds rather than just what it said. */
export function describeFeedbackSignal(rec) {
  const category = categorize(rec);
  return { category, group: category ? kindOf(rec) : null, minSignal: DEFAULT_MIN_SIGNAL };
}

export function analyzeFeedbackProposals({ records = [], at, minSignal = DEFAULT_MIN_SIGNAL } = {}) {
  // tally[kind][category] = { count, provenances:Set, tiers:Set }
  const tally = new Map();
  for (const rec of records) {
    const cat = categorize(rec);
    if (!cat) continue;
    const kind = kindOf(rec);
    const key = `${kind}::${cat}`;
    const agg = tally.get(key) || { kind, cat, count: 0, provenances: new Set(), tiers: new Set() };
    agg.count += 1;
    if (rec.provenance) agg.provenances.add(rec.provenance);
    if (rec?.classification?.tier) agg.tiers.add(rec.classification.tier);
    tally.set(key, agg);
  }

  const proposals = [];
  const applyVia = "PUT /routing (baselineSha, Orchestrator fitting)";
  for (const { kind, cat, count, provenances, tiers } of tally.values()) {
    if (count < minSignal) continue;
    const provs = [...provenances].sort().join("+") || "probe";
    const tierList = [...tiers].sort();
    const evidence = { kind, category: cat, count, provenances: [...provenances].sort(), tiers: tierList };
    if (cat === "deeper") {
      proposals.push({
        id: `feedback-deeper-${shortHash(kind)}`,
        rule: "feedback",
        targetClass: "orchestrator/policy",
        claim: `${count} explicit ${provs} answers say ${kind} work should have gone DEEPER (fuller pipeline / stronger target).`,
        evidence,
        diff: `flows["${kind}"].phasePlan / matrix cells — step ${kind} work UP toward the full pipeline (composer › Flows / Matrix)`,
        decision: `Give ${kind} work a fuller phase plan (or a stronger matrix target)?`,
        applyVia,
        at,
      });
    } else if (cat === "lighter") {
      proposals.push({
        id: `feedback-lighter-${shortHash(kind)}`,
        rule: "feedback",
        targetClass: "orchestrator/policy",
        claim: `${count} explicit ${provs} answers say ${kind} work was too HEAVY (overkill / should have run less).`,
        evidence,
        diff: `flows["${kind}"].phasePlan / matrix cells — step ${kind} work DOWN toward a lighter plan (composer › Flows / Matrix)`,
        decision: `Give ${kind} work a lighter phase plan (or a cheaper matrix target)?`,
        applyVia,
        at,
      });
    } else if (cat === "wrong-type") {
      proposals.push({
        id: `feedback-kindmatch-${shortHash(kind)}`,
        rule: "feedback",
        targetClass: "orchestrator/policy",
        claim: `${count} probe answers say ${kind} work was classified as the WRONG task type — the kind matcher may be mis-firing.`,
        evidence,
        diff: `exceptions / classifier keywords for ${kind} — review the matcher that routes ${kind} work (composer › Exceptions)`,
        decision: `Review the classifier/kind matcher for ${kind} work?`,
        applyVia,
        at,
      });
    } else if (cat === "retarget") {
      // `kind` here is "<dimension>=<value>" (see kindOf): the user named a
      // concrete replacement, so the claim can quote it verbatim instead of
      // gesturing at a direction.
      const [field, value] = kind.split("=");
      proposals.push({
        id: `feedback-retarget-${shortHash(kind)}`,
        rule: "feedback",
        targetClass: "orchestrator/policy",
        claim: `${count} decision verdicts say the orchestrator picked the wrong ${field} — the operator would have chosen ${value}.`,
        evidence,
        diff: `matrix cells / targets — route this work to ${field} ${value} (composer › Matrix / Targets)`,
        decision: `Make ${value} the ${field} for this kind of work?`,
        applyVia,
        at,
      });
    } else if (cat === "replan") {
      const [field, value] = kind.split("=");
      proposals.push({
        id: `feedback-replan-${shortHash(kind)}`,
        rule: "feedback",
        targetClass: "orchestrator/policy",
        claim: `${count} decision verdicts say the orchestrator planned this work wrongly — the operator would have set ${field} to ${value}.`,
        evidence,
        diff: `flows / phasePlans / tierDefinitions — make ${field} ${value} the default for this work (composer › Flows / Tiers)`,
        decision: `Default ${field} to ${value} for this kind of work?`,
        applyVia,
        at,
      });
    } else if (cat === "poor") {
      proposals.push({
        id: `feedback-wentpoorly-${shortHash(kind)}`,
        rule: "feedback",
        targetClass: "orchestrator/policy",
        claim: `${count} "how did it go" answers report ${kind} work needed rework or took the wrong approach — its plan or skill bindings may be worth reviewing.`,
        evidence,
        diff: `phaseSkills.bindings / flows["${kind}"] — review the phase plan + skill bindings ${kind} work runs through (composer › Flows / Phase skills)`,
        decision: `Review the phase plan / skill bindings for ${kind} work?`,
        applyVia,
        at,
      });
    }
  }
  // Stable order (byte-stable proposal set for a given queue).
  proposals.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return proposals;
}

// Convenience: collect + analyze in one call (the improver run path).
export async function runFeedbackRule({ now, client } = {}) {
  const records = await collectFeedback({ client });
  return {
    proposals: analyzeFeedbackProposals({ records, at: now }),
    inputs: { records: records.length },
  };
}

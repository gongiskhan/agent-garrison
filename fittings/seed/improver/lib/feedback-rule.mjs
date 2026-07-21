// feedback-rule.mjs — the Improver's consumer of the feedback queue
// (GARRISON-FLOW-V2 S8, D27). The Probe (probe/retrospective records) and the
// gateway (conversational-override records) both append to ONE queue,
// ~/.garrison/improver/feedback-queue.jsonl. This rule reads that queue and turns
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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const shortHash = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

// ── Collector (I/O) ───────────────────────────────────────────────────────────
function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length ? o : path.join(os.homedir(), ".garrison");
}

export function feedbackQueuePath() {
  return path.join(garrisonHome(), "improver", "feedback-queue.jsonl");
}

export function collectFeedback(file = feedbackQueuePath(), cap = 2000) {
  if (!existsSync(file)) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || out.length >= cap) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// ── Pure analysis (D27) ───────────────────────────────────────────────────────
// Direction categories a record's answer maps to, per provenance. `null` = no
// signal (a "right call" / "went well" / dismissed answer proposes nothing).
function categorize(rec) {
  const answer = String(rec?.answer ?? "").trim().toLowerCase();
  if (!answer || answer === "dismissed") return null;
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
  if (rec?.provenance === "override") return rec?.applied?.workKind || rec?.original?.workKind || "(unspecified)";
  return rec?.classification?.kind || "(unspecified)";
}

export function analyzeFeedbackProposals({ records = [], at, minSignal = 2 } = {}) {
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
        diff: `workKinds["${kind}"].phasePlan / matrix cells — step ${kind} work UP toward the full pipeline (composer › Work kinds / Matrix)`,
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
        diff: `workKinds["${kind}"].phasePlan / matrix cells — step ${kind} work DOWN toward a lighter plan (composer › Work kinds / Matrix)`,
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
    } else if (cat === "poor") {
      proposals.push({
        id: `feedback-wentpoorly-${shortHash(kind)}`,
        rule: "feedback",
        targetClass: "orchestrator/policy",
        claim: `${count} "how did it go" answers report ${kind} work needed rework or took the wrong approach — its plan or skill bindings may be worth reviewing.`,
        evidence,
        diff: `phaseSkills.bindings / workKinds["${kind}"] — review the phase plan + skill bindings ${kind} work runs through (composer › Work kinds / Phase skills)`,
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
export function runFeedbackRule({ now, queueFile } = {}) {
  const records = collectFeedback(queueFile);
  return {
    proposals: analyzeFeedbackProposals({ records, at: now }),
    inputs: { records: records.length },
  };
}

// coordination-rule.mjs — Improver proposals FOR the coordination policy
// (GARRISON-FLOW-V2 S6, D17).
//
// The composer (S6) surfaces the coordination section: overlap thresholds, the
// exclusive-lease list, and the plan-phase touch-set prediction. This rule
// watches what actually happened on the shared branch — the interference the
// coordination engine attributed, the ordering (overlap) decisions it made, and
// how often runs modified files OUTSIDE their predicted touch-set — and proposes
// tuning those knobs. Like every Improver policy rule it emits STANDARD-SHAPE
// proposals routed through the review queue and rendered in the composer as
// ghost edits; applyVia is the Orchestrator fitting's PUT /routing. NEVER
// auto-applied.
//
// Inputs (read-only): every ~/.garrison/kanban-loop/cards/<id>/card.json — its
// events timeline carries the durable coordination facts:
//   • kind "interference" — a run's gate failed because ANOTHER run's commits
//     touched its claims (detail names the overlap files). Real collisions.
//   • kind "coordination" — an ordering decision (heavy/medium/light overlap
//     wait); the detail carries the shared-files summary.
//   • kind "fence" — "Out-of-touch-set changes present … : <files>" means the
//     plan-phase prediction missed those paths (prediction inaccuracy).
//
// The ANALYSIS is pure (analyzeCoordinationProposals) so it unit-tests without a
// filesystem; the collectors do the I/O.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const shortHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// ── Collectors (I/O) ─────────────────────────────────────────────────────────

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length ? o : path.join(os.homedir(), ".garrison");
}

export function kanbanCardsDir() {
  const root = process.env.GARRISON_KANBAN_DIR || path.join(garrisonHome(), "kanban-loop");
  return path.join(root, "cards");
}

// Read every card.json under the kanban cards dir. Best-effort: a missing dir
// or an unreadable card is skipped, never thrown.
export function collectCards(cardsDir = kanbanCardsDir(), cap = 500) {
  const cards = [];
  if (!existsSync(cardsDir)) return cards;
  let entries = [];
  try {
    entries = readdirSync(cardsDir, { withFileTypes: true });
  } catch {
    return cards;
  }
  for (const e of entries) {
    if (!e.isDirectory() || cards.length >= cap) continue;
    const f = path.join(cardsDir, e.name, "card.json");
    if (!existsSync(f)) continue;
    try {
      cards.push(JSON.parse(readFileSync(f, "utf8")));
    } catch {
      /* unreadable card — skip */
    }
  }
  return cards;
}

// Read the current coordination knobs from the compiled policy so a proposal
// never suggests a value already in effect (already-leased path, threshold at
// the floor). Tolerant: an absent/unreadable policy yields the code defaults.
export function readPolicyCoordination() {
  const p = process.env.GARRISON_POLICY_PATH || path.join(garrisonHome(), "orchestrator", "policy.json");
  let coord = {};
  try {
    coord = JSON.parse(readFileSync(p, "utf8"))?.coordination || {};
  } catch {
    coord = {};
  }
  return {
    heavyFiles: Number.isFinite(coord?.thresholds?.heavyFiles) ? coord.thresholds.heavyFiles : 3,
    heavyRatio: Number.isFinite(coord?.thresholds?.heavyRatio) ? coord.thresholds.heavyRatio : 0.5,
    exclusiveLeases: Array.isArray(coord?.exclusiveLeases) ? coord.exclusiveLeases : []
  };
}

// ── Parsing helpers (pure) ───────────────────────────────────────────────────

// Split a "a.ts, b/, c.json …" file-list fragment into clean paths (drops the
// truncation ellipsis the engine appends when a list is long).
function splitPaths(fragment) {
  return String(fragment || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "…" && s !== "...")
    .map((s) => s.replace(/\s*(…|\.\.\.)\s*$/, "").trim())
    .filter(Boolean);
}

// Files an interference event blames. The victim's detail reads
// "broken by card X - commits <shas> touching <f1, f2>"; the offender's reads
// "<f1, f2> - it is waiting for your next fence (fix)." message and detail are
// parsed SEPARATELY (never concatenated) so the offender's message prefix can't
// bleed into the "…- it is waiting" capture, and a `.mjs`/`.json` extension in a
// path can't truncate the "touching …" capture.
function interferenceFiles(ev) {
  const fields = [String(ev?.detail || ""), String(ev?.message || "")];
  for (const s of fields) {
    const touching = s.match(/touching\s+(.+)$/i);
    if (touching) return splitPaths(touching[1]);
  }
  for (const s of fields) {
    const waiting = s.match(/^(.+?)\s+-\s+it is waiting/i);
    if (waiting) return splitPaths(waiting[1]);
  }
  return [];
}

// Files named in a coordination (ordering) event's shared-files summary, plus a
// coarse grade so heavy/medium (the ones that actually block) weigh more than a
// light heads-up. The summary lives in message or detail as "files [a, b]".
function coordinationSignal(ev) {
  const text = `${ev?.message || ""} ${ev?.detail || ""}`;
  const files = [];
  const m = text.match(/files\s+\[([^\]]*)\]/i);
  if (m) files.push(...splitPaths(m[1]));
  let grade = "light";
  if (/heavy overlap/i.test(text)) grade = "heavy";
  else if (/medium overlap/i.test(text)) grade = "medium";
  return { files, grade };
}

// Files a fence flagged as modified outside the predicted touch-set.
function outOfSetFiles(ev) {
  const text = `${ev?.message || ""} ${ev?.detail || ""}`;
  const m = text.match(/unattributable:\s+([^\n]+)$/i);
  return m ? splitPaths(m[1]) : [];
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

// ── Pure analysis (D17 heuristics) ───────────────────────────────────────────
// Three conservative, min-sample proposal kinds:
//  1. lease-list add — a file that caused >= minInterference attributed
//     collisions (or recurred in heavy-overlap ordering decisions) and is NOT
//     already leased → propose adding it to coordination.exclusiveLeases.
//  2. threshold down-step — interference recurred >= minThresholdSignal times
//     while heavyFiles is above the floor → propose lowering heavyFiles by one
//     so borderline overlaps escalate to heavy (serialize) sooner.
//  3. touch-set-prediction improvement — a file modified outside the predicted
//     touch-set >= minMisses times → propose predicting/leasing it so
//     concurrent runs stop colliding on an unpredicted path.
export function analyzeCoordinationProposals({
  cards = [],
  at,
  current = {},
  minInterference = 2,
  minMisses = 2,
  minThresholdSignal = 3,
  heavyFilesFloor = 2
} = {}) {
  const heavyFiles = Number.isFinite(current.heavyFiles) ? current.heavyFiles : 3;
  const leased = new Set((Array.isArray(current.exclusiveLeases) ? current.exclusiveLeases : []).map((p) => String(p).trim()));

  const interferenceHits = new Map(); // file -> collision count
  const heavyOverlapHits = new Map(); // file -> heavy/medium ordering count
  const outOfSetHits = new Map(); // file -> prediction-miss count
  let interferenceEvents = 0;

  for (const card of cards) {
    const events = Array.isArray(card?.events) ? card.events : [];
    for (const ev of events) {
      if (ev?.kind === "interference") {
        interferenceEvents += 1;
        for (const f of interferenceFiles(ev)) bump(interferenceHits, f);
      } else if (ev?.kind === "coordination") {
        const s = coordinationSignal(ev);
        if (s.grade === "heavy" || s.grade === "medium") for (const f of s.files) bump(heavyOverlapHits, f);
      } else if (ev?.kind === "fence") {
        for (const f of outOfSetFiles(ev)) bump(outOfSetHits, f);
      }
    }
  }

  const proposals = [];

  // 1. lease-list additions (interference-driven).
  const leaseCandidates = new Set([...interferenceHits.keys(), ...heavyOverlapHits.keys()]);
  for (const file of [...leaseCandidates].sort()) {
    if (leased.has(file)) continue;
    const collisions = interferenceHits.get(file) || 0;
    const overlaps = heavyOverlapHits.get(file) || 0;
    if (collisions < minInterference && collisions + overlaps < minInterference + 1) continue;
    proposals.push({
      id: `coordination-lease-${shortHash(file)}`,
      rule: "coordination",
      targetClass: "orchestrator/policy",
      claim:
        `${file} caused ${collisions} attributed interference collision${collisions === 1 ? "" : "s"}` +
        `${overlaps ? ` and recurred in ${overlaps} heavy/medium overlap decision${overlaps === 1 ? "" : "s"}` : ""} — ` +
        `concurrent runs keep contending for it.`,
      evidence: { file, collisions, overlaps },
      diff: `coordination.exclusiveLeases — add "${file}" so a run touching it takes an exclusive lease first (composer › Coordination › Exclusive-lease paths)`,
      decision: `Add "${file}" to the exclusive-lease list?`,
      applyVia: "PUT /routing (baselineSha, Orchestrator fitting)",
      at
    });
  }

  // 2. threshold down-step (recurrent interference despite ordering).
  if (interferenceEvents >= minThresholdSignal && heavyFiles > heavyFilesFloor) {
    proposals.push({
      id: `coordination-threshold-heavyFiles-${heavyFiles}`,
      rule: "coordination",
      targetClass: "orchestrator/policy",
      claim:
        `${interferenceEvents} interference events landed while heavyFiles=${heavyFiles} — overlaps may be grading below ` +
        `heavy (so they run in parallel) when they should serialize.`,
      evidence: { interferenceEvents, heavyFiles },
      diff: `coordination.thresholds.heavyFiles — step DOWN ${heavyFiles} → ${heavyFiles - 1} so borderline overlaps grade heavy and serialize (composer › Coordination › Heavy: shared files)`,
      decision: `Lower coordination heavyFiles ${heavyFiles} → ${heavyFiles - 1}?`,
      applyVia: "PUT /routing (baselineSha, Orchestrator fitting)",
      at
    });
  }

  // 3. touch-set-prediction improvements (chronic out-of-touch-set files).
  for (const [file, misses] of [...outOfSetHits.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (misses < minMisses) continue;
    if (leased.has(file)) continue; // already protected — no prediction proposal needed
    proposals.push({
      id: `coordination-predict-${shortHash(file)}`,
      rule: "coordination",
      targetClass: "orchestrator/policy",
      claim:
        `${file} was modified outside the predicted touch-set in ${misses} fences — the plan phase keeps under-predicting it, ` +
        `so concurrent runs can't order around it.`,
      evidence: { file, misses },
      diff: `plan-phase touch-set prediction — teach it to predict "${file}", or add "${file}" to coordination.exclusiveLeases so runs serialize on it regardless (composer › Coordination)`,
      decision: `Protect "${file}" (predict it, or add it to the exclusive-lease list)?`,
      applyVia: "PUT /routing (baselineSha, Orchestrator fitting)",
      at
    });
  }

  return proposals;
}

// Convenience: collect + analyze in one call (the improver run path).
export function runCoordinationRule({ now, cardsDir } = {}) {
  const cards = collectCards(cardsDir);
  const current = readPolicyCoordination();
  return {
    proposals: analyzeCoordinationProposals({ cards, current, at: now }),
    inputs: { cards: cards.length }
  };
}

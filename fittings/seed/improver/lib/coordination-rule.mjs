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

// Generated/lock/log paths recur outside the touch-set prediction constantly
// (a build writes them, a tool regenerates them) and are noise for this
// proposal: they were never something the plan phase should have predicted,
// and leasing/predicting them would just paper over churn. Drop them before
// the batch is built.
const NOISE_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|\.gitignore|RUN_LOG\.md|next-env\.d\.ts)$/;
const NOISE_LOCK_EXT = /\.lock$/i;
const NOISE_SCRATCH = /(^|\/)__verify-[^/]*$/;
const NOISE_DIR = /(^|\/)(dist|build|node_modules|\.next|coverage|\.garrison)\//;
const NOISE_EXT = /\.log$/i;
function isNoisePath(file) {
  return (
    NOISE_FILE.test(file) ||
    NOISE_LOCK_EXT.test(file) ||
    NOISE_SCRATCH.test(file) ||
    NOISE_DIR.test(file) ||
    NOISE_EXT.test(file)
  );
}

// The touch-set-prediction batch is emitted in GENERATIONS. The first one uses
// the bare id; every later one is keyed by the set of paths already reviewed,
// which is stable while that generation is pending and changes exactly when
// the previous generation is resolved.
export const PREDICT_BATCH_ID = "coordination-predict-batch";
function predictBatchId(reviewed) {
  const list = [...reviewed].sort();
  return list.length === 0 ? PREDICT_BATCH_ID : `${PREDICT_BATCH_ID}-${shortHash(list.join(","))}`;
}

// The pre-refit, per-file scheme's id prefix (one proposal per touch-set miss,
// id `coordination-predict-<shortHash(file)>`, evidence `{file}` singular).
// Superseded by the batch scheme above, but records under this prefix still
// live in old review queues and a human already decided them — they must
// count as reviewed too, or their path re-asks once under the new scheme.
const PREDICT_LEGACY_PREFIX = "coordination-predict-";

// Paths already covered by a RESOLVED (non-pending) predict-batch generation
// in the review queue, PLUS any resolved pre-refit per-file record. A pending
// generation is deliberately NOT counted: it is still the record the analyzer
// refreshes, so its members must stay candidates.
export function reviewedPredictPathsFromQueue(queue = []) {
  const out = new Set();
  for (const p of Array.isArray(queue) ? queue : []) {
    if (!p || p.rule !== "coordination") continue;
    if (typeof p.id !== "string" || !p.id.startsWith(PREDICT_LEGACY_PREFIX)) continue;
    if (!p.status || p.status === "pending") continue;
    for (const f of Array.isArray(p?.evidence?.files) ? p.evidence.files : []) out.add(String(f).trim());
    if (typeof p?.evidence?.file === "string" && p.evidence.file.trim()) out.add(p.evidence.file.trim());
  }
  return [...out].sort();
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
  heavyFilesFloor = 2,
  reviewedPredictPaths: reviewedPaths = []
} = {}) {
  const heavyFiles = Number.isFinite(current.heavyFiles) ? current.heavyFiles : 3;
  const leased = new Set((Array.isArray(current.exclusiveLeases) ? current.exclusiveLeases : []).map((p) => String(p).trim()));

  const interferenceHits = new Map(); // file -> collision count
  const heavyOverlapHits = new Map(); // file -> heavy/medium ordering count
  const outOfSetHits = new Map(); // file -> prediction-miss count
  let interferenceEvents = 0;

  // The engine records every collision/ordering on BOTH cards (victim +
  // offender, waiter + blocker) with the same timestamp. Count each real
  // event ONCE by identity, or every proposal double-counts its evidence.
  const seen = new Set();
  for (const card of cards) {
    const events = Array.isArray(card?.events) ? card.events : [];
    for (const ev of events) {
      if (ev?.kind === "interference") {
        const key = `i|${ev.at || ""}|${interferenceFiles(ev).sort().join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        interferenceEvents += 1;
        for (const f of interferenceFiles(ev)) bump(interferenceHits, f);
      } else if (ev?.kind === "coordination") {
        const s = coordinationSignal(ev);
        if (s.grade === "heavy" || s.grade === "medium") {
          const key = `c|${ev.at || ""}|${s.grade}|${[...s.files].sort().join(",")}`;
          if (seen.has(key)) continue;
          seen.add(key);
          for (const f of s.files) bump(heavyOverlapHits, f);
        }
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

  // 3. touch-set-prediction improvements (chronic out-of-touch-set files),
  // batched into ONE pending proposal per generation. Every qualifying file
  // changes the SAME record (the id is keyed on what has already been
  // reviewed, NOT on the qualifying set) so the queue holds one reviewable
  // decision that grows/shrinks with the evidence instead of a fresh record —
  // and a fresh Approve/Reject pair — every time membership shifts by one path.
  //
  // A generation only ever covers paths the human has NOT already decided on.
  // Paths carried by a resolved generation are dropped from the candidate set
  // (that decision stands and must not be re-asked), and the remaining delta
  // is emitted under an id derived from the resolved set — so it is the SAME
  // record for as long as it stays pending (membership may still grow), and a
  // DISTINCT record the moment the previous generation is resolved. Without
  // that, a single literal id meant resolving the first batch suppressed every
  // future path forever: the frozen record was truthful, but newly qualifying
  // paths could never obtain an Approve/Reject decision at all.
  const reviewed = new Set((Array.isArray(reviewedPaths) ? reviewedPaths : []).map((p) => String(p).trim()));
  const predictCandidates = [...outOfSetHits.entries()]
    .filter(([file, misses]) => misses >= minMisses && !leased.has(file) && !isNoisePath(file) && !reviewed.has(file))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (predictCandidates.length > 0) {
    const files = predictCandidates.map(([file]) => file);
    const misses = Object.fromEntries(predictCandidates);
    const preview = files.slice(0, 5);
    const more = files.length - preview.length;
    proposals.push({
      id: predictBatchId(reviewed),
      rule: "coordination",
      targetClass: "orchestrator/policy",
      claim:
        `${files.length} path${files.length === 1 ? "" : "s"} ${files.length === 1 ? "was" : "were"} modified outside the predicted ` +
        `touch-set (≥${minMisses} misses each) — the plan phase keeps under-predicting ${files.length === 1 ? "it" : "them"}, so concurrent ` +
        `runs can't order around ${files.length === 1 ? "it" : "them"}: ${preview.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
      evidence: { files, misses },
      diff:
        `plan-phase touch-set prediction — teach it to predict, or add to coordination.exclusiveLeases so runs serialize regardless, ` +
        `each of:\n` + files.map((f) => `+ ${f} (${misses[f]} misses)`).join("\n") + `\n(composer › Coordination)`,
      decision: `Protect these ${files.length} path${files.length === 1 ? "" : "s"} (predict them, or add them to the exclusive-lease list)?`,
      applyVia: "PUT /routing (baselineSha, Orchestrator fitting)",
      at
    });
  }

  return proposals;
}

// Convenience: collect + analyze in one call (the improver run path).
export function runCoordinationRule({ now, cardsDir, queue = [] } = {}) {
  const cards = collectCards(cardsDir);
  const current = readPolicyCoordination();
  return {
    proposals: analyzeCoordinationProposals({
      cards,
      current,
      at: now,
      reviewedPredictPaths: reviewedPredictPathsFromQueue(queue)
    }),
    inputs: { cards: cards.length }
  };
}

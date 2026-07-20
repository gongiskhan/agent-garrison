// policy.mjs — the run engine's window onto the compiled Orchestrator policy
// (GARRISON-UNIFY-V1 S4, D4/D9/D15).
//
// The compiled policy at ~/.garrison/orchestrator/policy.json is the ONE
// consumption interface: which skill executes a phase, which {taskType, tier}
// classification a phase dispatch carries, and which phases a card's work kind
// actually runs (the rail, with per-card toggles merged over it — D17). No
// HTTP in the hot path — a plain file read, cached briefly.
//
// A list maps to a PHASE NAME and nothing else (D15): `list.phase ?? list.id`.
import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

export function policyPath() {
  if (process.env.GARRISON_POLICY_PATH) return process.env.GARRISON_POLICY_PATH;
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return path.join(home, "orchestrator", "policy.json");
}

// Tiny mtime-keyed cache so a tick over many cards reads the file once.
let _cache = { path: null, mtimeMs: 0, policy: null };

export function loadPolicy() {
  const p = policyPath();
  try {
    const st = statSync(p);
    if (_cache.path === p && _cache.mtimeMs === st.mtimeMs && _cache.policy) return _cache.policy;
    const policy = JSON.parse(readFileSync(p, "utf8"));
    _cache = { path: p, mtimeMs: st.mtimeMs, policy };
    return policy;
  } catch {
    return null;
  }
}

// Distinguish WHY loadPolicy returned null (D9 fail-safe, rev2-s567 S5#1):
//   "ok"      — a policy loaded,
//   "absent"  — no policy file at all (the deliberate "policy-less mode" the
//               pure transition tests run in — D9 simply doesn't apply), and
//   "corrupt" — a policy file EXISTS but couldn't be read/parsed (a bad PUT,
//               disk corruption). A corrupt policy must NOT silently drop D9 and
//               let cards fast-forward ungated; the engine parks instead.
export function policyLoadState() {
  const p = policyPath();
  let exists = false;
  try { statSync(p); exists = true; } catch { exists = false; }
  if (!exists) return "absent";
  try { JSON.parse(readFileSync(p, "utf8")); return "ok"; } catch { return "corrupt"; }
}

export function resetPolicyCache() {
  _cache = { path: null, mtimeMs: 0, policy: null };
}

// A list maps to a phase name and nothing else (D15).
export function phaseForList(list) {
  return list?.phase ?? list?.id ?? null;
}

// The skill bound to a phase: per-work-kind override wins over the global
// binding (D3). Null when the policy has no binding (the dispatch prompt then
// omits the skill line; the phase skill contract still applies downstream).
export function skillForPhase(policy, phase, workKind) {
  if (!policy || !phase) return null;
  const overrides = ((policy.phaseSkills || {}).overrides || {})[workKind] || {};
  const bindings = (policy.phaseSkills || {}).bindings || {};
  return overrides[phase] || bindings[phase] || null;
}

// The explicit classification a phase dispatch carries: the phase IS the task
// type (D1); the tier rides on the card (defaulting T1-standard). Both are
// validated against the policy vocabulary — an out-of-vocab value returns
// null and the caller falls back to classifier routing (never misroutes).
export function classificationForPhase(policy, phase, card) {
  if (!policy || !phase) return null;
  const taskTypes = Array.isArray(policy.taskTypes) ? policy.taskTypes : [];
  const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
  const tier = card?.tier && tiers.includes(card.tier) ? card.tier : "T1-standard";
  if (!taskTypes.includes(phase) || !tiers.includes(tier)) return null;
  return { taskType: phase, tier };
}

// The card's rail: the work kind's phase plan with per-card toggles merged
// over it (D2/D17). A phase plan is an ORDERED SUBSET of the pipeline phases —
// a pipeline phase NOT in the plan is OFF (off_reason "phase-plan"), and it
// STAYS IN THE RAIL rendered off (honesty, never hidden). Rail order: the
// plan's phases in plan order, then the remaining pipeline phases (policy
// order), all off. Falls back to every policy phase (all on) when the policy
// carries no work kinds.
export function railForCard(policy, card) {
  if (!policy) return null;
  const allPhases = Array.isArray(policy.phases) ? policy.phases : null;
  if (!allPhases) return null;
  const kindName = card?.workKind || policy.defaultWorkKind;
  const kind = (policy.workKinds || {})[kindName];
  const plan = kind ? (policy.phasePlans || {})[kind.phasePlan] : null;
  // A work kind may declare `evidence: false` — an evidence-free rail whose
  // transitions owe no evidence files and no durable gate records. Absent or
  // any other value means evidence is required (every dev kind is untouched).
  const evidenceRequired = kind ? kind.evidence !== false : true;
  const toggles = card?.phases && typeof card.phases === "object" ? card.phases : {};
  const bindings = (policy.phaseSkills || {}).bindings || {};
  const overrides = ((policy.phaseSkills || {}).overrides || {})[kindName] || {};
  const entry = (id, planOn, offReason) => {
    const toggledOff = toggles[id] === false;
    return {
      id,
      on: planOn && !toggledOff,
      ...(toggledOff ? { off_reason: "card-toggle" } : planOn ? {} : { off_reason: offReason }),
      skill: overrides[id] || bindings[id] || null
    };
  };
  if (!plan) {
    return {
      workKind: kindName || null,
      evidence: "none",
      evidenceRequired,
      phases: allPhases.map((id) => entry(id, true, null))
    };
  }
  const inPlan = new Map(
    (plan.phases || []).map((ph) => {
      const id = typeof ph === "string" ? ph : ph.id;
      const on = typeof ph === "string" ? true : ph.on !== false;
      return [id, on];
    })
  );
  const phases = [
    ...[...inPlan.entries()].map(([id, on]) => entry(id, on, "phase-plan")),
    ...allPhases.filter((id) => !inPlan.has(id)).map((id) => entry(id, false, "phase-plan"))
  ];
  return { workKind: kindName || null, evidence: plan.evidence || "none", evidenceRequired, phases };
}

// A rail with no ON phases — an empty phase plan (the personal/channel manual
// kinds) or a card whose per-card toggles switched everything off. Nothing for
// the engine to run: the card's whole journey is the manual head/tail
// (backlog/todo/done), so manual affordances (Move/Advance) must never funnel
// it into the dev pipeline. Null rail (no policy) is NOT manual-only — the
// static board behavior stays authoritative there.
export function railIsManualOnly(rail) {
  return !!rail && Array.isArray(rail.phases) && rail.phases.every((p) => !p.on);
}

// Is `phase` ON for this card? A pipeline phase absent from the rail is OFF
// (the plan is the complete set of what runs); a NON-pipeline phase (a custom
// board column outside the policy vocabulary) defaults ON — the rail governs
// only the pipeline.
export function phaseOnForCard(rail, phase) {
  if (!rail) return true;
  const entry = rail.phases.find((p) => p.id === phase);
  return entry ? entry.on : true;
}

// ── Durable gate evidence (D9) ───────────────────────────────────────────────
// A phase's list transition requires the phase's gate-status entry in the
// card's runDir, in addition to the router-reply contract. The phase skill
// writes <runDir>/slices/<slice>/gate-status.json with a gates{} slot keyed by
// the phase's camelCase gate key (or a run-level <runDir>/gate-status.json).
const GATE_KEYS = {
  "adversarial-review": "adversarialReview",
  "adversarial-test": "adversarialTest",
  "design-audit": "designAudit",
  "ux-qa": "uxQa",
  "security-review": "securityReview",
  "codex-checkpoint": "codexCheckpoint"
};

export function gateKeyForPhase(phase) {
  return GATE_KEYS[phase] || phase;
}

function gateStatusFiles(cwd, runDir, phase = null) {
  const out = [];
  try {
    const base = path.resolve(cwd || process.cwd(), runDir);
    const runLevel = path.join(base, "gate-status.json");
    if (existsSync(runLevel)) out.push(runLevel);
    // Per-phase sidecar (gate-status.<phase>.json) — the shape an operative
    // naturally writes when told "write this phase's gate-status entry" and no
    // bound skill dictates the run-level layout. Its existence with parseable
    // JSON is direct evidence the gate ran.
    if (phase) {
      const sidecar = path.join(base, `gate-status.${phase}.json`);
      if (existsSync(sidecar)) out.push(sidecar);
    }
    const slicesDir = path.join(base, "slices");
    if (existsSync(slicesDir)) {
      for (const entry of readdirSync(slicesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const f = path.join(slicesDir, entry.name, "gate-status.json");
        if (existsSync(f)) out.push(f);
        if (phase) {
          const sf = path.join(slicesDir, entry.name, `gate-status.${phase}.json`);
          if (existsSync(sf)) out.push(sf);
        }
      }
    }
  } catch {
    /* best-effort */
  }
  return out;
}

// True when ANY gate-status file under the runDir carries an entry for the
// phase (any status — a FAILED entry is evidence too; the loop-back verdict
// still transitions with proof the gate actually ran). Read-only, best-effort:
// unreadable files count as no evidence.
//
// Key spelling is NOT part of the contract: the garrison-* skills write the
// camelCase gate key (adversarialReview), while an unbound operative writes
// the phase id as-is (adversarial-review) — both name the same gate, so both
// count. Single-word phases (plan/implement/review) are identical either way.

// Inspect the phase's durable gate records once and expose both halves of the
// contract: whether the phase wrote a parseable record at all, and every
// explicit transition it declared. Historical gate writers emitted status-only
// entries, so `declaresNext:false` remains a deliberate compatibility case.
// Once ANY phase record declares next_phase/nextPhase/next, however, the engine
// must bind the actual transition to one of those declarations; a differently
// named edge is not satisfied by the file's mere existence.
//
// Capture enough filesystem identity to distinguish a gate file that this
// attempt rewrote from one it merely inherited. Content alone is insufficient:
// a legitimate retry can produce the exact same status/verdict. mtime alone is
// insufficient too: filesystems may have coarse timestamp resolution and a
// writer can preserve/restore mtime. ctime + inode cover those cases (ctime is
// not user-settable), while the digest catches an in-place semantic change.
function gateFileFingerprint(file, raw, st) {
  return [
    String(st.dev),
    String(st.ino),
    String(st.size),
    String(st.mtimeNs),
    String(st.ctimeNs),
    createHash("sha256").update(raw).digest("hex")
  ].join(":");
}

// Parse every file that actually carries this phase. Keeping collection and
// authority selection separate lets a dispatched attempt filter out its
// pre-run baseline BEFORE choosing the newest record: an untouched historical
// sidecar must not shadow (or authorize) a freshly-written aggregate.
function phaseGateCandidates(cwd, runDir, phase) {
  if (!runDir || !phase) return [];
  const keys = new Set([gateKeyForPhase(phase), phase]);
  const base = path.resolve(cwd || process.cwd(), runDir);
  const phaseSidecar = `gate-status.${phase}.json`;
  const candidates = [];
  for (const file of gateStatusFiles(cwd, runDir, phase)) {
    try {
      const raw = readFileSync(file);
      const doc = JSON.parse(raw.toString("utf8"));
      const isPhaseSidecar = path.basename(file) === phaseSidecar;
      const entries = [];
      if (isPhaseSidecar) {
        // A parseable per-phase sidecar is relevant by filename, including a
        // primitive/status-only historical payload.
        entries.push(doc);
      } else {
        const gates = doc?.gates && typeof doc.gates === "object" ? doc.gates : null;
        if (gates) {
          for (const k of keys) {
            if (Object.prototype.hasOwnProperty.call(gates, k)) entries.push(gates[k]);
          }
        }
        const phases = doc?.phases && typeof doc.phases === "object" ? doc.phases : null;
        if (phases && Object.prototype.hasOwnProperty.call(phases, phase)) entries.push(phases[phase]);
      }
      // Authority is selected only among parseable records that actually carry
      // this phase. A newer aggregate for some other phase must not shadow it.
      if (entries.length === 0) continue;
      const st = statSync(file, { bigint: true });
      const mtimeMs = Number(st.mtimeNs) / 1e6;
      const ctimeMs = Number(st.ctimeNs) / 1e6;
      // Root sidecar > slice sidecar > generic only when timestamps tie.
      const rank = isPhaseSidecar ? (path.dirname(file) === base ? 2 : 1) : 0;
      candidates.push({
        file,
        mtimeMs,
        ctimeMs,
        rank,
        entries,
        fingerprint: gateFileFingerprint(file, raw, st)
      });
    } catch {
      // Unreadable files are not gate evidence and cannot become authoritative.
    }
  }
  return candidates;
}

// A pre-dispatch snapshot is deliberately opaque to callers: it is only a map
// from relevant absolute file path to its robust fingerprint. The engine keeps
// it in memory for the duration of one attempt; no deletion or runDir mutation
// is needed, so historical gate artifacts remain inspectable.
export function snapshotPhaseGateEvidence(cwd, runDir, phase) {
  return {
    phase,
    files: Object.fromEntries(
      phaseGateCandidates(cwd, runDir, phase).map((candidate) => [candidate.file, candidate.fingerprint])
    )
  };
}

function candidateIsFresh(candidate, freshness) {
  if (!freshness || typeof freshness !== "object") return true;
  const baseline = freshness.baseline;
  if (baseline && typeof baseline === "object") {
    const files = baseline.files && typeof baseline.files === "object" ? baseline.files : {};
    if (Object.prototype.hasOwnProperty.call(files, candidate.file) && files[candidate.file] === candidate.fingerprint) {
      return false;
    }
  }
  const notBeforeMs = Number(freshness.notBeforeMs);
  if (Number.isFinite(notBeforeMs) && Math.max(candidate.mtimeMs, candidate.ctimeMs) < notBeforeMs) {
    return false;
  }
  return true;
}

// More than one declaration can survive in a run directory after a retry (for
// example retained slice records). Only the newest eligible gate file is
// authoritative; on an mtime tie, a phase-specific sidecar wins over a generic
// aggregate file. `freshness.baseline` limits eligibility to files created or
// changed by the current dispatched attempt. `freshness.notBeforeMs` supports
// the in-process doorway, which has a phase-entry time but no pre-run snapshot.
export function inspectPhaseGateEvidence(cwd, runDir, phase, freshness = null) {
  const empty = { exists: false, declaresNext: false, nextLists: [] };
  if (!runDir || !phase) return empty;
  let exists = false;
  let declaresNext = false;
  const nextLists = new Set();
  const inspectEntry = (entry) => {
    exists = true;
    if (!entry || typeof entry !== "object") return;
    const nextKey = ["next_phase", "nextPhase", "next"].find((key) =>
      Object.prototype.hasOwnProperty.call(entry, key)
    );
    if (!nextKey) return;
    declaresNext = true;
    const raw = entry[nextKey];
    const next = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (next) nextLists.add(next);
  };
  const candidates = phaseGateCandidates(cwd, runDir, phase).filter((candidate) =>
    candidateIsFresh(candidate, freshness)
  );
  if (candidates.length === 0) return empty;
  const newestMtime = Math.max(...candidates.map((candidate) => candidate.mtimeMs));
  const newest = candidates.filter((candidate) => candidate.mtimeMs === newestMtime);
  const highestRank = Math.max(...newest.map((candidate) => candidate.rank));
  const authoritative = newest.filter((candidate) => candidate.rank === highestRank);
  for (const { entries } of authoritative) {
    for (const entry of entries) inspectEntry(entry);
  }
  return { exists, declaresNext, nextLists: [...nextLists] };
}

// The phase's own DURABLE verdict (D9 backstop, 2026-07-11): when the chat
// reply loses the next-step token (observed: a Workflow completion banner
// swallowing the operative's final line), the gate record the phase skill
// wrote is the stronger signal — it already names next_phase. Returns the
// recorded next list id iff it is one of validNext, else null. A FAILED gate
// naming a loop-back target (review → implement) is honored too: the record
// is proof the gate ran, and validNext constrains the transition.
export function gateEvidenceNextList(cwd, runDir, phase, validNext, freshness = null) {
  if (!Array.isArray(validNext) || validNext.length === 0) return null;
  const evidence = inspectPhaseGateEvidence(cwd, runDir, phase, freshness);
  return evidence.nextLists.find((next) => validNext.includes(next)) ?? null;
}

export function hasPhaseGateEvidence(cwd, runDir, phase, freshness = null) {
  return inspectPhaseGateEvidence(cwd, runDir, phase, freshness).exists;
}

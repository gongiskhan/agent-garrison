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
  return { workKind: kindName || null, evidence: plan.evidence || "none", phases };
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

function gateStatusFiles(cwd, runDir) {
  const out = [];
  try {
    const base = path.resolve(cwd || process.cwd(), runDir);
    const runLevel = path.join(base, "gate-status.json");
    if (existsSync(runLevel)) out.push(runLevel);
    const slicesDir = path.join(base, "slices");
    if (existsSync(slicesDir)) {
      for (const entry of readdirSync(slicesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const f = path.join(slicesDir, entry.name, "gate-status.json");
        if (existsSync(f)) out.push(f);
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
export function hasPhaseGateEvidence(cwd, runDir, phase) {
  if (!runDir || !phase) return false;
  const key = gateKeyForPhase(phase);
  for (const file of gateStatusFiles(cwd, runDir)) {
    try {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      const gates = doc?.gates && typeof doc.gates === "object" ? doc.gates : null;
      if (gates && Object.prototype.hasOwnProperty.call(gates, key)) return true;
      const phases = doc?.phases && typeof doc.phases === "object" ? doc.phases : null;
      if (phases && Object.prototype.hasOwnProperty.call(phases, phase)) return true;
    } catch {
      /* skip unreadable */
    }
  }
  return false;
}

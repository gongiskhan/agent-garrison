// improver-core.mjs — the nightly self-improvement runner core (BRIEF v4 §4).
//
// Reads telemetry (decisions.jsonl), learned memory (MEMORY.md), pool stats, and
// evidence; produces PROPOSAL diffs into a review queue. Applies happen ONLY
// through hosted authoring APIs (the UI triggers them) — this core never writes
// to owned surfaces directly. Per-rule autonomy (manual|auto) with streak-gated
// promotion + instant demotion. Pure functions + a thin runner; inputs injected.

// ── Proposals ────────────────────────────────────────────────────────────────
// The seed end-to-end rule: nightly memory consolidation. Reads MEMORY.md learned
// hints + decisions.jsonl, and proposes consolidating recurring hints into the
// vault as canonical conventions. Returns a reviewable proposal (claim + evidence
// + a diff + one decision), the presentation standard for ALL proposals.
export function proposeMemoryConsolidation({ memoryEntries = [], decisions = [], at = null }) {
  if (!memoryEntries.length) return null;
  // Recurrence is the validation signal: a hint that appears as a learned note is
  // a candidate; we propose promoting the top candidates to canonical conventions.
  const candidates = memoryEntries.slice(0, 5);
  const diff = candidates
    .map((e) => `+ ## ${e.title}\n+ ${e.hook || "(learned hint)"}`)
    .join("\n");
  return {
    id: `memory-consolidation-${candidates.length}`,
    rule: "memory-consolidation",
    targetClass: "memory/vault",
    claim: `${candidates.length} learned note(s) in MEMORY.md are stable enough to promote to canonical vault conventions.`,
    evidence: { memoryNotes: candidates.length, decisionsConsidered: decisions.length },
    diff,
    decision: "Promote these notes into the vault?",
    applyVia: "POST /api/quarters file.update (vault)",
    at
  };
}

// ── Autonomy state machine ───────────────────────────────────────────────────
// A rule's autonomy is `manual` (default) or `auto`. It can be set `auto`
// directly at any time (no streak). The Improver SUGGESTS promotion: per (rule,
// proposalKind) streaks of N consecutive accepts (default 5, zero rejects) emit a
// promotion proposal. Demotion is automatic + instant on any reject/revert of an
// auto-applied change. The Improver never raises its OWN autonomy without a human
// action (the direct toggle or approving a promotion).
export const PROMOTION_THRESHOLD = 5;

export function initRuleState(overrides = {}) {
  return { autonomy: "manual", streak: 0, accepted: 0, rejected: 0, reverted: 0, ...overrides };
}

// Record an outcome; returns { state, event }. event ∈ {none, promotion-suggested, demoted}.
export function recordOutcome(state, outcome, opts = {}) {
  const threshold = opts.threshold ?? PROMOTION_THRESHOLD;
  const next = { ...state };
  if (outcome === "accept") {
    next.accepted++;
    next.streak++;
    if (next.autonomy === "manual" && next.streak >= threshold) {
      return { state: next, event: "promotion-suggested" };
    }
    return { state: next, event: "none" };
  }
  if (outcome === "reject" || outcome === "revert") {
    next.rejected += outcome === "reject" ? 1 : 0;
    next.reverted += outcome === "revert" ? 1 : 0;
    next.streak = 0; // any reject resets the streak
    if (next.autonomy === "auto") {
      next.autonomy = "manual"; // instant demotion
      return { state: next, event: "demoted" };
    }
    return { state: next, event: "none" };
  }
  return { state: next, event: "none" };
}

// Direct toggle (human action) — set auto immediately, no streak required.
export function setAutonomy(state, autonomy) {
  return { ...state, autonomy };
}

// Approving a promotion proposal sets the rule auto (a human action).
export function applyPromotion(state) {
  return { ...state, autonomy: "auto", streak: 0 };
}

// ── Run ──────────────────────────────────────────────────────────────────────
// The nightly run. Inputs are injected (decisions, memoryEntries, vaultLocked,
// serverUp). If the vault is locked or the Next server is down, records a skip
// rather than failing silently. Returns { skipped?, proposals[], report }.
export function runImprover({ decisions = [], memoryEntries = [], vaultLocked = false, serverUp = true, at = null } = {}) {
  if (vaultLocked) return { skipped: "vault locked", proposals: [], report: { at, skipped: "vault locked" } };
  if (!serverUp) return { skipped: "next server down", proposals: [], report: { at, skipped: "next server down" } };
  const proposals = [];
  const mem = proposeMemoryConsolidation({ memoryEntries, decisions, at });
  if (mem) proposals.push(mem);
  return {
    proposals,
    report: { at, proposalCount: proposals.length, decisionsConsidered: decisions.length, memoryNotes: memoryEntries.length }
  };
}

// Upsert a proposal into the review-queue index (idempotent by proposal id).
export function upsertQueue(queue, proposal) {
  const next = (queue || []).filter((p) => p.id !== proposal.id);
  next.push({ id: proposal.id, rule: proposal.rule, targetClass: proposal.targetClass, claim: proposal.claim, status: "pending", at: proposal.at });
  return next;
}

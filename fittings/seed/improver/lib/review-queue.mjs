// review-queue.mjs — Improver review-queue persistence + status transitions +
// per-rule autonomy (BRIEF U3). The queue stores FULL proposals (diff included)
// so apply can rebuild the plan; autonomy is per-rule state driven by the
// improver-core state machine (manual default, 5-accept promotion, instant
// demotion). Pure storage helpers + thin transitions; the server wires them to
// apply-core + reconcile.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { initRuleState, recordOutcome, setAutonomy, applyPromotion, PROMOTION_THRESHOLD } from "./improver-core.mjs";

export async function loadQueue(file) {
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

export async function saveQueue(file, queue) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(queue, null, 2) + "\n", "utf8");
}

// Idempotent by id — a pending/applied proposal is not duplicated or reverted.
export function enqueue(queue, proposal) {
  const existing = (queue || []).find((p) => p.id === proposal.id);
  if (existing) return queue; // keep the existing status (don't reset applied→pending)
  return [
    ...(queue || []),
    {
      id: proposal.id,
      rule: proposal.rule,
      targetClass: proposal.targetClass,
      claim: proposal.claim,
      diff: proposal.diff,
      decision: proposal.decision,
      applyVia: proposal.applyVia,
      status: "pending",
      at: proposal.at,
    },
  ];
}

export function findProposal(queue, id) {
  return (queue || []).find((p) => p.id === id) || null;
}

export function markApplied(queue, id, evidence, at) {
  return queue.map((p) => (p.id === id ? { ...p, status: "applied", appliedAt: at, evidence } : p));
}

export function markRejected(queue, id, at) {
  return queue.map((p) => (p.id === id ? { ...p, status: "rejected", rejectedAt: at } : p));
}

// ── per-rule autonomy persistence ────────────────────────────────────────────
export async function loadAutonomy(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

export async function saveAutonomy(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function ruleState(autonomy, rule) {
  return autonomy[rule] ?? initRuleState();
}

// Record an accept/reject for a rule; returns { autonomy, event }.
export function applyOutcome(autonomy, rule, outcome) {
  const { state, event } = recordOutcome(ruleState(autonomy, rule), outcome);
  return { autonomy: { ...autonomy, [rule]: state }, event };
}

export function setRuleAutonomy(autonomy, rule, mode) {
  return { ...autonomy, [rule]: setAutonomy(ruleState(autonomy, rule), mode) };
}

export function promoteRule(autonomy, rule) {
  return { ...autonomy, [rule]: applyPromotion(ruleState(autonomy, rule)) };
}

export function isAuto(autonomy, rule) {
  return ruleState(autonomy, rule).autonomy === "auto";
}

export { PROMOTION_THRESHOLD };

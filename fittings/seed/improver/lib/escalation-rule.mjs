// escalation-rule.mjs — the Improver rule that closes the level-resolution loop
// (ORCHESTRATOR_COHERENCE.md §2.3).
//
// The level chain is: a duty INHERITS the flow level, a flow definition may PIN
// one duty higher at a given flow level, and the router may ESCALATE one duty on
// one card. Escalation is a runtime patch — it never writes back into the flow
// definition, by design. So an escalation that keeps happening on the same work
// shape is the system telling you the DEFINITION is wrong: every one of those
// cards paid for a decision that should have been made once, in config.
//
// That is the highest-value improver signal there is, and until now nothing read
// it. This rule does: it groups applied escalations out of the composition's
// decisions.jsonl and, for each recurring group, proposes the config edit that
// would stop the recurrence.
//
// TWO VARIANTS, deliberately asymmetric in what they permit:
//   • PROMOTE TO PIN — `flows[flow].levels[L].pins[duty] = to`. Mechanical,
//     reversible, and exactly what the runtime has been doing anyway, so it is
//     APPLIABLE through the shell's PUT /api/orchestrator/policy.
//   • SPLIT INTO ITS OWN LEVEL — the honest alternative when the escalations say
//     the work shape was misjudged rather than the duty under-levelled. There is
//     no mechanical edit for "this is really a different kind of work", so it is
//     MANUAL-ONLY (`appliable: false`): the claim explains what splitting would
//     mean and a human does it. A proposal that cannot be applied correctly must
//     not offer an Approve button that does something else.
//
// The grouping (`summariseEscalations`) is REPLICATED from
// fittings/seed/orchestrator/lib/level-resolution.mjs, which is the source of
// truth for it. Cross-fitting imports are forbidden (each Fitting is a separately
// installed package at runtime) and there is no precedent in this Fitting for
// importing another's code — probe-core.mjs replicates the gateway's promptDigest
// for the same reason. `tests/improver-escalation-rule.test.ts` runs BOTH
// implementations over the same records and asserts they agree, so the copy
// cannot drift silently.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const shortHash = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

// ── Config (the improver owns its own rule sensitivity) ──────────────────────
// How many times the same escalation must recur before it is worth proposing a
// config change. Three is the same default level-resolution.mjs documents; the
// improver carries its own copy because the SENSITIVITY of a rule belongs to the
// thing that fires it, not to the module that computes the grouping.
//
// Resolution order matches the dream rule's: env (config→env injection at setup)
// wins, then the JSON snapshot setup.sh writes into the data dir, then this
// default. The own-port server is spawned with process.env rather than the
// composition config, so the snapshot is the only way it sees a configured value.
export const DEFAULT_ESCALATION_THRESHOLD = 3;

export function loadEscalationThreshold() {
  const fromEnv = Number(process.env.IMPROVER_ESCALATION_THRESHOLD);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.trunc(fromEnv);
  try {
    const dir =
      process.env.IMPROVER_DATA ||
      path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "improver");
    const file = JSON.parse(readFileSync(path.join(dir, "rule-config.json"), "utf8"));
    const v = Number(file?.escalationThreshold);
    if (Number.isFinite(v) && v >= 1) return Math.trunc(v);
  } catch {
    /* no snapshot yet — fall through to the default */
  }
  return DEFAULT_ESCALATION_THRESHOLD;
}

// ── Collectors (I/O) ─────────────────────────────────────────────────────────
export function decisionsPathFor(compositionDir) {
  const override = process.env.IMPROVER_DECISIONS?.trim();
  if (override && override.length) return override;
  return path.join(compositionDir || "", ".garrison", "decisions.jsonl");
}

/** The composition's decision log, tolerantly. Absent → no evidence, not an error:
 *  a composition that has never routed anything has nothing to say here. */
export function collectDecisions(compositionDir, { maxRecords = 20_000 } = {}) {
  const file = decisionsPathFor(compositionDir);
  if (!file || !existsSync(file)) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.trim());
  const out = [];
  // Newest-first cap: an escalation from six months ago says nothing about the
  // flow definition as it stands today, and the live log is already megabytes.
  for (const line of lines.slice(-maxRecords)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* malformed line — skip */
    }
  }
  return out;
}

/** The flow definitions, so a proposal can check whether the pin it wants
 *  already exists and can tell whether splitting is even meaningful. */
export function readFlowDefinitions(compositionDir) {
  const file = path.join(compositionDir || "", ".garrison", "routing.json");
  if (!existsSync(file)) return {};
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return doc && typeof doc.flows === "object" && doc.flows ? doc.flows : {};
  } catch {
    return {};
  }
}

// ── Grouping (replica of level-resolution.mjs summariseEscalations) ──────────
export function summariseEscalations(records, { threshold = DEFAULT_ESCALATION_THRESHOLD } = {}) {
  const groups = new Map();
  for (const r of records || []) {
    if (!r || r.kind !== "escalation" || !r.applied) continue;
    const key = [r.flow ?? "", r.flowLevel ?? "", r.duty ?? "", r.to ?? ""].join("|");
    const g = groups.get(key) ?? {
      flow: r.flow ?? null,
      flowLevel: r.flowLevel ?? null,
      duty: r.duty ?? null,
      to: r.to ?? null,
      count: 0,
      reasons: [],
      cardIds: [],
    };
    g.count += 1;
    if (r.reason && !g.reasons.includes(r.reason)) g.reasons.push(r.reason);
    if (r.cardId) g.cardIds.push(r.cardId);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, recurring: g.count >= threshold }))
    .sort((a, b) => b.count - a.count);
}

// ── Pure analysis ────────────────────────────────────────────────────────────
const MAX_LEVEL = 3;

/** The pin already on the flow definition for this (flow, level, duty), or null. */
function existingPin(flows, group) {
  const level = flows?.[group.flow]?.levels?.[String(group.flowLevel)];
  const pin = level?.pins?.[group.duty];
  return Number.isFinite(Number(pin)) ? Number(pin) : null;
}

/** Levels this flow actually defines, ascending. */
function definedLevels(flows, flowName) {
  const levels = flows?.[flowName]?.levels;
  if (!levels || typeof levels !== "object") return [];
  return Object.keys(levels)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

const quoteReasons = (reasons) => (reasons.length ? ` Reasons given: ${reasons.slice(0, 3).map((r) => `"${r}"`).join(", ")}.` : "");

/**
 * Turn recurring escalation groups into proposals.
 *
 * A group is skipped — with no proposal at all — when the flow definition
 * ALREADY pins the duty at or above the escalated level. That is config that has
 * already converged; proposing it again would be the improver arguing with
 * itself, and would put a permanent no-op in the review queue.
 */
export function analyzeEscalationProposals({ groups = [], flows = {}, at, threshold = DEFAULT_ESCALATION_THRESHOLD } = {}) {
  const proposals = [];
  for (const g of groups) {
    if (!g.recurring) continue;
    if (!g.flow || !g.duty || !Number.isFinite(Number(g.to))) continue; // an unattributable escalation proposes nothing
    const to = Number(g.to);
    const pinned = existingPin(flows, g);
    if (pinned !== null && pinned >= to) continue; // the definition already says this
    const key = `${g.flow}|${g.flowLevel}|${g.duty}|${to}`;
    const where = `flows["${g.flow}"].levels["${g.flowLevel}"].pins["${g.duty}"]`;
    const evidence = {
      flow: g.flow,
      flowLevel: g.flowLevel,
      duty: g.duty,
      to,
      count: g.count,
      reasons: g.reasons.slice(0, 5),
      cardIds: g.cardIds.slice(0, 10),
      existingPin: pinned,
    };
    // Confidence tracks how far past the bar the recurrence is: at the threshold
    // it is a pattern, at double it is a standing fact about this work shape.
    const confidence = g.count >= threshold * 2 ? "high" : "medium";

    proposals.push({
      id: `escalation-pin-${shortHash(key)}`,
      rule: "escalation",
      targetClass: "orchestrator/flow",
      claim:
        `The router escalated ${g.duty} to level ${to} on ${g.count} separate ${g.flow} cards at flow level ${g.flowLevel}` +
        ` — the flow definition says level ${g.flowLevel}, the runtime keeps disagreeing.${quoteReasons(g.reasons)}`,
      evidence,
      confidence,
      // The diff is the literal edit, in the "+" form the review UI renders.
      diff: [
        `  ${where}`,
        `- ${pinned === null ? "(no pin — the duty inherits the flow level)" : pinned}`,
        `+ ${to}`,
      ].join("\n"),
      decision: `Pin ${g.duty} to level ${to} for ${g.flow} at flow level ${g.flowLevel}?`,
      applyVia: "PUT /api/orchestrator/policy (baselineSha-guarded, Garrison shell)",
      // The machine-readable form of the same edit. The apply path uses THIS and
      // never re-parses the claim or the diff text.
      pinEdit: { flow: g.flow, flowLevel: String(g.flowLevel), duty: g.duty, level: to },
      appliable: true,
      at,
    });

    // The split variant only when the flow has somewhere higher to go: if this is
    // already the flow's top level, "run it at a higher level instead" names
    // nothing that exists and the pin is the only honest proposal.
    const levels = definedLevels(flows, g.flow);
    const higher = levels.filter((n) => n > Number(g.flowLevel));
    if (higher.length) {
      proposals.push({
        id: `escalation-split-${shortHash(key)}`,
        rule: "escalation",
        targetClass: "orchestrator/flow",
        claim:
          `Same evidence, other reading: if ${g.duty} needs level ${to} on ${g.count} ${g.flow} cards, those cards may not be` +
          ` flow level ${g.flowLevel} work at all. Flow level ${higher[0]} already exists — routing this shape there (or giving it` +
          ` its own level) fixes the cause rather than patching one duty. MANUAL: there is no mechanical edit for "this is a` +
          ` different kind of work", so nothing here will apply it for you.`,
        evidence: { ...evidence, alternativeFlowLevel: higher[0], definedLevels: levels },
        confidence,
        diff: [
          `  flows["${g.flow}"] — no automatic edit`,
          `  consider: route this shape at flow level ${higher[0]}, or add a level between ${g.flowLevel} and ${higher[0]}`,
          `  compare with: ${where} = ${to} (the other proposal)`,
        ].join("\n"),
        decision: `Review whether these ${g.flow} cards are really flow level ${g.flowLevel} work.`,
        applyVia: "manual — edit the flow definition in Muster › Orchestrator",
        appliable: false,
        at,
      });
    }
  }
  proposals.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return proposals;
}

// Convenience: collect + analyze in one call (the improver run path).
export function runEscalationRule({ now, compositionDir, threshold } = {}) {
  const bar = Number.isFinite(Number(threshold)) ? Number(threshold) : loadEscalationThreshold();
  const records = collectDecisions(compositionDir);
  const flows = readFlowDefinitions(compositionDir);
  const groups = summariseEscalations(records, { threshold: bar });
  return {
    proposals: analyzeEscalationProposals({ groups, flows, at: now, threshold: bar }),
    inputs: { decisions: records.length, groups: groups.length, recurring: groups.filter((g) => g.recurring).length, threshold: bar },
  };
}

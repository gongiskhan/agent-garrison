// orchestrator-policy-rule.mjs — Improver proposals FOR the Orchestrator
// policy (GARRISON-UNIFY-V1 S15, D38).
//
// Inputs (both read-only):
//   • the garrison friction log(s) — docs/autothing/friction-log.md lines
//     (the signal garrison writes and, until this rule, NOTHING read), and
//   • run outcomes — ~/.garrison/runs/<project>/<runId>/evidence-index.json
//     (+ per-slice gate-status.json), the durable spine of every run.
//
// Output: proposals in the Improver's standard reviewable shape
//   { id, rule: "orchestrator-policy", targetClass: "orchestrator/policy",
//     claim, evidence, diff, decision, applyVia, at }
// routed through the existing review queue (NEVER auto-applied) and rendered
// in the composer view as ghost edits. applyVia is the Orchestrator fitting's
// PUT /routing (baselineSha-guarded).
//
// The ANALYSIS is pure (analyzeForPolicyProposals) so it unit-tests without a
// filesystem; the collectors do the I/O.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const shortHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// ── Collectors (I/O) ─────────────────────────────────────────────────────────

export function runsHomeDir() {
  return (
    process.env.GARRISON_RUNS_DIR ||
    path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "runs")
  );
}

// Gather run outcomes: every evidence-index.json under the runs home.
export function collectRunOutcomes(runsRoot = runsHomeDir(), cap = 200) {
  const outcomes = [];
  if (!existsSync(runsRoot)) return outcomes;
  try {
    for (const project of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projDir = path.join(runsRoot, project.name);
      for (const run of readdirSync(projDir, { withFileTypes: true })) {
        if (!run.isDirectory() || outcomes.length >= cap) continue;
        const idx = path.join(projDir, run.name, "evidence-index.json");
        if (!existsSync(idx)) continue;
        try {
          const doc = JSON.parse(readFileSync(idx, "utf8"));
          outcomes.push({ project: project.name, runId: run.name, index: doc });
        } catch {
          /* unreadable index — skip */
        }
      }
    }
  } catch {
    /* best-effort */
  }
  return outcomes;
}

// Gather friction-log lines from repo roots (default: every direct child of
// the projects root carrying docs/autothing/friction-log.md). Lines look like
// `- <UTC> [<skill>] <what happened> → <suggested fix>`.
export function collectFrictionLines(projectsRoot = path.join(os.homedir(), "dev"), cap = 300) {
  const lines = [];
  if (!existsSync(projectsRoot)) return lines;
  try {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || lines.length >= cap) continue;
      const f = path.join(projectsRoot, entry.name, "docs", "autothing", "friction-log.md");
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (line.startsWith("- ") && lines.length < cap) lines.push({ project: entry.name, line });
      }
    }
  } catch {
    /* best-effort */
  }
  return lines;
}

// ── Pure analysis (D38 heuristics) ──────────────────────────────────────────
// Three seeded proposal kinds, each conservative (min-sample thresholds):
//  1. phase-plan edit — a phase that consistently finds nothing for a kind
//     (skipped/clean across >= minRuns runs of that work kind) → propose
//     turning it off in that kind's plan.
//  2. matrix cell effort — a phase whose gate FAILED in >= failRatio of runs
//     → propose one ladder step up; a phase clean across >= calmRuns runs at
//     a high-effort target → propose one step down.
//  3. skill-binding review — friction lines naming a phase skill repeatedly
//     (>= minMentions) → propose reviewing/swapping that binding.
export function analyzeForPolicyProposals({ outcomes = [], frictionLines = [], at, minRuns = 3, failRatio = 0.5, calmRuns = 5, minMentions = 3 } = {}) {
  const proposals = [];

  // Aggregate per (workKind, phase): {runs, clean, failed, skipped}
  const byKindPhase = new Map();
  for (const o of outcomes) {
    const kind = o.index?.workKind || o.index?.gatesConfig?.workKind || "full-feature";
    for (const slice of o.index?.slices || []) {
      const gates = slice.gateStatus?.gates || slice.gates || {};
      for (const [gateKey, entry] of Object.entries(gates)) {
        const key = `${kind}::${gateKey}`;
        const agg = byKindPhase.get(key) || { runs: 0, clean: 0, failed: 0, skipped: 0 };
        agg.runs += 1;
        const status = entry?.status || entry?.verdict || entry?.result;
        if (status === "skipped") agg.skipped += 1;
        else if (["failed", "needs-work", "fail", "issues"].includes(status)) agg.failed += 1;
        else agg.clean += 1;
        byKindPhase.set(key, agg);
      }
    }
  }

  for (const [key, agg] of byKindPhase) {
    const [kind, gateKey] = key.split("::");
    if (agg.runs >= minRuns && agg.skipped === 0 && agg.failed === 0 && agg.runs === agg.clean && agg.runs >= calmRuns) {
      proposals.push({
        id: `orchestrator-policy-calm-${shortHash(key)}`,
        rule: "orchestrator-policy",
        targetClass: "orchestrator/policy",
        claim: `The ${gateKey} gate has been clean across ${agg.runs} ${kind} runs — its effort may be higher than the work needs.`,
        evidence: { kind, gate: gateKey, runs: agg.runs, clean: agg.clean },
        diff: `matrix["${gateKey}"] — consider one computeLadder step DOWN for ${kind} work (edit the cell in the composer)`,
        decision: `Lower the ${gateKey} matrix cell one effort step for ${kind}?`,
        applyVia: "PUT /routing (baselineSha, Orchestrator fitting)",
        at
      });
    }
    if (agg.runs >= minRuns && agg.failed / agg.runs >= failRatio) {
      proposals.push({
        id: `orchestrator-policy-fail-${shortHash(key)}`,
        rule: "orchestrator-policy",
        targetClass: "orchestrator/policy",
        claim: `The ${gateKey} gate failed in ${agg.failed}/${agg.runs} ${kind} runs — the executing target may be under-powered.`,
        evidence: { kind, gate: gateKey, runs: agg.runs, failed: agg.failed },
        diff: `matrix["${gateKey}"] — consider one computeLadder step UP for ${kind} work (edit the cell in the composer)`,
        decision: `Raise the ${gateKey} matrix cell one effort step for ${kind}?`,
        applyVia: "PUT /routing (baselineSha, Orchestrator fitting)",
        at
      });
    }
    if (agg.runs >= minRuns && agg.skipped === agg.runs) {
      proposals.push({
        id: `orchestrator-policy-off-${shortHash(key)}`,
        rule: "orchestrator-policy",
        targetClass: "orchestrator/policy",
        claim: `The ${gateKey} phase was skipped in ALL ${agg.runs} ${kind} runs — it may not belong in that kind's phase plan.`,
        evidence: { kind, gate: gateKey, runs: agg.runs, skipped: agg.skipped },
        diff: `phasePlans[workKinds["${kind}"].phasePlan] — turn ${gateKey} OFF for ${kind} (chip toggle in the composer)`,
        decision: `Turn the ${gateKey} phase off in the ${kind} plan?`,
        applyVia: "PUT /routing (baselineSha, Orchestrator fitting)",
        at
      });
    }
  }

  // Friction → skill-binding review. Count mentions of [garrison-<verb>]
  // (or any [skill-name]) in friction lines.
  const mentionCounts = new Map();
  for (const { line } of frictionLines) {
    const m = line.match(/\[([a-z0-9:-]+)\]/i);
    if (m) mentionCounts.set(m[1], (mentionCounts.get(m[1]) || 0) + 1);
  }
  for (const [skill, count] of mentionCounts) {
    if (count < minMentions) continue;
    proposals.push({
      id: `orchestrator-policy-binding-${shortHash(skill)}`,
      rule: "orchestrator-policy",
      targetClass: "orchestrator/policy",
      claim: `${count} friction-log entries name ${skill} — its phase binding may be worth reviewing or swapping.`,
      evidence: { skill, mentions: count },
      diff: `phaseSkills.bindings — review the binding executing via ${skill} (swap it from the composer's chip inspector)`,
      decision: `Review/swap the phase binding for ${skill}?`,
      applyVia: "PUT /routing (baselineSha, Orchestrator fitting)",
      at
    });
  }

  return proposals;
}

// Convenience: collect + analyze in one call (the improver run path).
export function runOrchestratorPolicyRule({ now, runsRoot, projectsRoot } = {}) {
  const outcomes = collectRunOutcomes(runsRoot);
  const frictionLines = collectFrictionLines(projectsRoot);
  return {
    proposals: analyzeForPolicyProposals({ outcomes, frictionLines, at: now }),
    inputs: { runs: outcomes.length, frictionLines: frictionLines.length }
  };
}

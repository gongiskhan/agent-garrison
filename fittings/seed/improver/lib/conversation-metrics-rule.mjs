// conversation-metrics-rule.mjs — the Improver rule that diets on the
// Conversations instrumentation (Conversations plan, Task 5).
//
// The conversation store's ledger yields four numbers per duty: escalation
// rate, repeated-failure rate, dig frequency, and cost. The rule's job is the
// plan's sentence verbatim: "raising defaults on duties that always escalate
// and lowering those that never do." Thresholds live HERE, in the rule — the
// metrics lib reports, the thing that fires decides its own sensitivity
// (escalation-rule.mjs set that precedent).
//
// Proposals go into the SAME review queue as every other rule — rendered as
// ghost edits against the composition's duty ladder lines, never auto-applied.
import { rollupMetrics } from "@garrison/claude-pty";

// A duty whose stretches escalate above this rate wants a HIGHER default rung.
export const ESCALATION_RATE_HIGH = Number(process.env.IMPROVER_CONV_ESCALATION_HIGH) || 0.25;
// A duty with plenty of stretches and ZERO escalations may afford a LOWER one.
export const NEVER_ESCALATES_MIN_STRETCHES = Number(process.env.IMPROVER_CONV_NEVER_MIN) || 20;
// Dig frequency above this says the summaries are not carrying enough.
export const DIG_RATE_HIGH = Number(process.env.IMPROVER_CONV_DIG_HIGH) || 2.0;

export function runConversationMetricsRule({ now = () => new Date().toISOString(), env = process.env } = {}) {
  const rollup = rollupMetrics({ env, groupBy: "duty" });
  const proposals = [];
  const at = now();

  for (const [duty, g] of Object.entries(rollup.groups)) {
    if (g.stretches >= 4 && g.escalationRate >= ESCALATION_RATE_HIGH) {
      proposals.push({
        id: `conv-metrics-raise-${duty}-${at.replace(/[:.]/g, "-")}`,
        kind: "conversation-metrics",
        area: "routing",
        title: `Raise the ${duty} duty's default rung`,
        detail:
          `${Math.round(g.escalationRate * 100)}% of ${g.stretches} ${duty} stretches escalated off their default rung. ` +
          `Every one paid a wasted floor-rung attempt first. Raise the duty's \`default:\` line one rung in ` +
          `compositions/default/apm.yml (ladders are the two-line duty config).`,
        evidence: { duty, stretches: g.stretches, escalated: g.escalated, escalationRate: g.escalationRate, threshold: ESCALATION_RATE_HIGH },
        at,
      });
    }
    if (g.stretches >= NEVER_ESCALATES_MIN_STRETCHES && g.escalated === 0) {
      proposals.push({
        id: `conv-metrics-lower-${duty}-${at.replace(/[:.]/g, "-")}`,
        kind: "conversation-metrics",
        area: "cost",
        title: `Consider lowering the ${duty} duty's default rung`,
        detail:
          `${g.stretches} ${duty} stretches ran without a single escalation. The default rung may be paying for ` +
          `capability this duty never uses — try one rung lower and watch the tripwires.`,
        evidence: { duty, stretches: g.stretches, escalated: 0, minStretches: NEVER_ESCALATES_MIN_STRETCHES },
        at,
      });
    }
  }

  const digRate = rollup.totals.stretches ? rollup.totals.digs / rollup.totals.stretches : 0;
  if (rollup.totals.stretches >= 10 && digRate >= DIG_RATE_HIGH) {
    proposals.push({
      id: `conv-metrics-summaries-${at.replace(/[:.]/g, "-")}`,
      kind: "conversation-metrics",
      area: "summarization",
      title: "Layer-three digs are high — summaries are not carrying enough",
      detail:
        `${rollup.totals.digs} raw-log/payload digs across ${rollup.totals.stretches} stretches ` +
        `(${digRate.toFixed(1)}/stretch, threshold ${DIG_RATE_HIGH}). Readers keep bypassing summary.md and the ` +
        `handoffs. Look at what the digs opened and widen the handoff summary guidance in the exit contract.`,
      evidence: { digs: rollup.totals.digs, stretches: rollup.totals.stretches, digRate, threshold: DIG_RATE_HIGH },
      at,
    });
  }

  if (rollup.totals.repeatedFailures > 0) {
    proposals.push({
      id: `conv-metrics-repeated-failure-${at.replace(/[:.]/g, "-")}`,
      kind: "conversation-metrics",
      area: "reliability",
      title: `${rollup.totals.repeatedFailures} conversation(s) hit repeated consecutive failures`,
      detail:
        `Consecutive failed stretches mean the brief, the summary, or the tripwire thresholds are letting a stuck ` +
        `duty spin. Read those conversations' logs before tuning anything.`,
      evidence: { repeatedFailures: rollup.totals.repeatedFailures, conversations: rollup.totals.conversations },
      at,
    });
  }

  return {
    proposals,
    inputs: {
      conversations: rollup.totals.conversations,
      stretches: rollup.totals.stretches,
      duties: Object.keys(rollup.groups).length,
      digRate,
      unpricedStretches: rollup.totals.unpricedStretches,
    },
  };
}

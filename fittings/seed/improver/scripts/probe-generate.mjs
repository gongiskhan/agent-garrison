#!/usr/bin/env node
// probe-generate.mjs — the Improver Probe generator, invoked by the Stop hook
// (probe-stop-hook.sh pipes the Stop payload to us on stdin). We are the single
// gate-and-generate step (GARRISON-FLOW-V2 S8, D22-D25):
//
//   1. Sweep a stale pending (>90s ⇒ dismissed records, D26) and pass through.
//   2. If a FRESH pending exists, stay silent (we already asked; awaiting capture).
//   3. Run the gates (all fail-closed, RUN_SPEC A10): stop_hook_active=false, not
//      muted today, POSITIVE attended evidence, NO goal sentinel, a real task just
//      completed. Any miss ⇒ exit 0 silently.
//   4. Resolve the MODEL TARGET from the compiled policy's probe-question cell.
//      Unreachable ⇒ fail LOUDLY to the probe-skip log, exit 0 (never block).
//   5. Retrospective once/day at the first attended boundary (D25); else one probe.
//   6. Write the pending record; print the verbatim relay instruction as a
//      {decision:"block", reason} line on stdout — the model relays it via
//      AskUserQuestion (D24, the model is a relay).
//
// Fail-safe: ANY error prints nothing on stdout and exits 0 (a wrong block would
// nag; staying silent is the safe failure). The bash wrapper also swallows errors.

import { readFileSync } from "node:fs";
import {
  isAttended,
  hasGoalSentinel,
  taskLooksComplete,
  lastUserPrompt,
  promptDigest,
  correlateDecision,
  classificationFrom,
  chooseArea,
  buildProbeQuestion,
  buildRetrospectiveQuestions,
  resolveProbeTarget,
  relayReason,
} from "../lib/probe-core.mjs";
import * as store from "../lib/probe-store.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function findCardForSession(_sessionId, _cards) {
  // Best-effort: cards carry no sessionId (E3/E11), so v1 does not force a match.
  // A future card↔session link (sessions/state.json row → runId → card) can enrich
  // this; today we return null and the classification falls back to the decision's
  // taskType. Kept as a seam so the correlation caveat is explicit, not hidden.
  return null;
}

// `--check-target`: setup-time reachability check (loud, never blocks `up`).
//   exit 0  policy resolves the probe-question cell (prints the target), OR
//           policy.json is absent (fresh install — the composition recompiles it
//           at start; the probe stays dormant until then, which is expected);
//   exit 2  policy is present but has NO resolvable probe-question cell — a real
//           misconfiguration (the seed lost the probe-question row/target). Setup
//           surfaces this loudly but does not abort, so `up` can recompile.
function checkTarget() {
  let policy;
  try {
    policy = store.readPolicy();
  } catch {
    process.stderr.write(
      "probe: policy.json not yet compiled — probe-question target unresolved for now; the composition recompiles the policy at start (expected on a fresh install).\n"
    );
    return 0;
  }
  try {
    const t = resolveProbeTarget(policy);
    process.stdout.write(`probe: probe-question → ${t.targetId} (runtime=${t.runtime}, model=${t.model})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `probe: LOUD WARNING — policy.json is present but the probe-question cell is unreachable: ${err?.message || err}\n` +
        "probe: the Probe will stay dormant and log a probe-skip line at each attended Stop until the policy compiles a probe-question target.\n"
    );
    return 2;
  }
}

function main() {
  if (process.argv.includes("--check-target")) return checkTarget();
  const now = process.env.PROBE_NOW || new Date().toISOString();
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return 0;
  }
  const sessionId = payload.session_id || payload.sessionId || null;
  const stopActive = payload.stop_hook_active === true;
  const transcriptPath = payload.transcript_path || payload.transcriptPath || null;

  // 1) sweep a stale pending → dismissed records, then pass through this Stop.
  const sweep = store.sweepStalePending({ now });
  if (sweep.swept) return 0;
  // 2) a FRESH pending means we already asked this session — stay silent.
  if (sweep.fresh) return 0;

  // 3) gates (fail-closed).
  if (stopActive) return 0; // loop guard: we are inside a block-driven continuation
  if (!sessionId) return 0;
  if (store.isMutedToday(now)) return 0;
  if (hasGoalSentinel(sessionId, store.goalSentinelPaths(sessionId))) return 0; // goal loop owns this stop
  if (!isAttended(sessionId, store.readSessionsState())) return 0; // A10: attended only
  const transcript = store.readTranscriptTail(transcriptPath);
  if (!taskLooksComplete(transcript)) return 0; // no real task boundary

  // 4) resolve the target from policy (fail loud, never silent).
  let target;
  try {
    target = resolveProbeTarget(store.readPolicy());
  } catch (err) {
    store.logSkip(`probe-question target unreachable: ${err?.message || err}`, now);
    return 0;
  }
  // Acceptance #17: the resolved target is PRINTED (from the policy cell), on stderr
  // so it never contaminates the decision line on stdout.
  process.stderr.write(
    `probe: target=${target.targetId} runtime=${target.runtime} model=${target.model} (policy cell probe-question/${target.tier})\n`
  );

  // context: correlate the routing decision + classification.
  const decisions = store.readDecisionsTail({});
  const digest = promptDigest(lastUserPrompt(transcript));
  const decision = correlateDecision(decisions, { digest, at: now });
  const cards = store.collectCards();

  // 5) retrospective once/day at the first attended boundary (D25).
  let mode = "probe";
  let questions;
  if (!store.hasRetroFlagToday(now)) {
    const retro = buildRetrospectiveQuestions(cards, { now });
    if (retro.length) {
      mode = "retrospective";
      questions = retro;
      store.touchRetroFlag(now);
    }
  }
  if (!questions) {
    const card = findCardForSession(sessionId, cards);
    const classification = classificationFrom({ decision, card });
    const area = chooseArea({ card });
    const q = buildProbeQuestion({ area, classification, card });
    questions = [{ area: q.area, question: q.question, options: q.options, classification, card_id: card?.id ?? null }];
  }

  // 6) write pending + emit the verbatim relay block.
  const pending = {
    id: `p-${Date.parse(now)}-${Math.random().toString(16).slice(2, 8)}`,
    session_id: sessionId,
    mode,
    askedAt: now,
    target: target.targetId,
    questions,
  };
  try {
    store.writePending(pending);
  } catch (err) {
    store.logSkip(`failed to write pending: ${err?.message || err}`, now);
    return 0;
  }
  process.stdout.write(JSON.stringify({ decision: "block", reason: relayReason(pending) }));
  return 0;
}

try {
  process.exit(main() ?? 0);
} catch {
  // fail-safe: never block on an unexpected error.
  process.exit(0);
}

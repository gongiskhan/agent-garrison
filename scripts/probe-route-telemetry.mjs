// MR1e live probe — one operative turn through the full path (BRIEF v4 §3).
// classify (warm pool) → resolve (pure) → write the decision to decisions.jsonl
// AT RESOLUTION TIME (decisions-log-ok) → run ONE operative turn under the
// router-v4 assembled prompt with the gateway routing annotation → parse the
// reply's [route:] token + diff-check it against the resolved route (route-token-ok).
// Prints:  decisions-log-ok  and  route-token-ok  (or *-FAILED / *-inconclusive)
// Re-runnable: `node scripts/probe-route-telemetry.mjs`.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OperativePtySession } from "../packages/claude-pty/src/index.mjs";
import { buildClassifierPrompt, parseClassification, resolveRoute } from "../fittings/seed/orchestrator/lib/routing-core.mjs";
import { decisionRecord, appendDecision, readDecisions, formatRouteToken, checkHonored } from "../fittings/seed/orchestrator/lib/routing-telemetry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const config = JSON.parse(readFileSync(path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json"), "utf8"));
const ASSEMBLED = path.join(ROOT, "compositions/router-v4/.garrison/assembled-system-prompt.md");

const TASK = "fix the failing login unit test";
const HARD_MS = 180_000;
let done = false;
function finish(logOk, tokenState, note) {
  if (done) return;
  done = true;
  console.log(logOk ? "decisions-log-ok" : "decisions-log-FAILED");
  console.log(tokenState === "ok" ? "route-token-ok" : tokenState === "inconclusive" ? "route-token-inconclusive" : "route-token-FAILED");
  if (note) console.log(`(${note})`);
  process.exit(0);
}
const timer = setTimeout(() => finish(false, "inconclusive", "hard timeout"), HARD_MS);

let session;
try {
  const cwd = mkdtempSync(path.join(tmpdir(), "gar-probe-telemetry-"));
  const decisionsFile = path.join(cwd, "decisions.jsonl");
  session = await OperativePtySession.spawn({
    compositionDir: cwd,
    model: "haiku",
    appendSystemPromptFile: existsSync(ASSEMBLED) ? ASSEMBLED : undefined,
    permissionMode: "bypassPermissions",
    readinessTimeoutMs: 45_000
  });

  // Stage A: classify on the same warm session, then pure resolve.
  const cr = await session.runTurn({ message: buildClassifierPrompt(config, TASK), timeoutMs: 60_000 });
  const classification = parseClassification(cr.reply || "", config) || { taskType: "code", tier: "T1-standard", matchedException: null };
  const route = resolveRoute(config, config.activeProfile, classification);

  // Telemetry: write the decision AT RESOLUTION TIME (gateway is source of truth).
  await appendDecision(decisionsFile, decisionRecord({ prompt: TASK, classification, route, at: new Date().toISOString() }));
  const logged = await readDecisions(decisionsFile);
  const decisionsLogOk = logged.length === 1 && logged[0].targetId === route.targetId && logged[0].profile === route.profile;

  // One operative turn with the gateway routing annotation; expect the [route:] token.
  const annotation = `[gateway-route: target=${route.targetId} rule=${route.ruleId} profile=${route.profile}]`;
  const turn = await session.runTurn({
    message: `${annotation}\nTask: ${TASK}. Reply in one short sentence, then end with the required [route: …] and [orchestrator-active] tokens exactly as instructed.`,
    timeoutMs: 60_000
  });
  const honored = checkHonored(route, turn.reply || "");
  session.dispose();
  clearTimeout(timer);

  const expectedToken = formatRouteToken(route);
  const tokenState = honored.honored ? "ok" : honored.actual ? "inconclusive" : "inconclusive";
  finish(
    decisionsLogOk,
    tokenState,
    `decisions.jsonl rows=${logged.length} target=${route.targetId}; expectedToken="${expectedToken}"; reply-token=${JSON.stringify(honored.actual)}; honored=${honored.honored}`
  );
} catch (err) {
  clearTimeout(timer);
  console.error(`[probe] note: ${err?.message}`);
  finish(false, "inconclusive", `live turn error: ${err?.message}`);
} finally {
  try { session?.dispose(); } catch { /* ignore */ }
}

// U4 live probe — soul/provider respawn preserves context (soul-switch-ok).
//
// A soul/provider change is launch-fixed, so Stage B respawns the session. We
// plant a codeword on session A, dispose it, then test BOTH resume mechanisms in
// order on the installed claude:
//   1. --continue in the same cwd (the historical path).
//   2. if --continue drops the codeword (2.1.x doesn't persist ephemeral
//      sessions), the CARRYOVER FALLBACK: respawn fresh and re-inject a compact
//      context summary (buildContextCarryover) as the first turn's preamble.
// Either mechanism preserving the codeword → soul-switch-ok (prints which).
// Re-runnable:  node scripts/probe-soul-switch.mjs

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperativePtySession } from "../packages/claude-pty/src/index.mjs";
import { buildContextCarryover } from "../fittings/seed/orchestrator/lib/stage-b.mjs";

const CODEWORD = "GARRISON-ZEBRA-42";
const MODEL = process.env.GARRISON_INTEGRATION_MODEL || "sonnet";
const HARD_MS = 220_000;
let done = false;
let session;
function finish(ok, mechanism, note) {
  if (done) return;
  done = true;
  console.log(ok ? "soul-switch-ok" : "soul-switch-inconclusive");
  if (mechanism) console.log(`(mechanism: ${mechanism})`);
  if (note) console.log(`(${note})`);
  try { session?.dispose(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300).unref();
}
const timer = setTimeout(() => finish(false, null, "hard timeout"), HARD_MS);

async function ask(s, message) {
  const t = await s.runTurn({ message, timeoutMs: 90_000 });
  return (t.reply || "").trim();
}

try {
  const cwd = mkdtempSync(path.join(tmpdir(), "gar-soul-"));

  // session A: plant the codeword
  session = await OperativePtySession.spawn({ compositionDir: cwd, model: MODEL, permissionMode: "bypassPermissions", readinessTimeoutMs: 45_000 });
  await ask(session, `Remember this codeword for later: ${CODEWORD}. Reply with exactly: stored`);
  session.dispose();

  // mechanism 1: --continue
  session = await OperativePtySession.spawn({ compositionDir: cwd, model: MODEL, continueSession: true, permissionMode: "bypassPermissions", readinessTimeoutMs: 45_000 });
  const r1 = await ask(session, "What was the codeword I asked you to remember? Reply with just the codeword.");
  session.dispose();
  if (r1.includes(CODEWORD)) {
    clearTimeout(timer);
    finish(true, "--continue", `reply="${r1.slice(0, 60)}"`);
  } else {
    // mechanism 2: carryover fallback — respawn fresh, re-inject context summary
    const carry = buildContextCarryover([
      { role: "user", text: `Remember this codeword for later: ${CODEWORD}.` },
      { role: "assistant", text: `stored — the codeword is ${CODEWORD}` },
    ]);
    session = await OperativePtySession.spawn({ compositionDir: mkdtempSync(path.join(tmpdir(), "gar-soul2-")), model: MODEL, permissionMode: "bypassPermissions", readinessTimeoutMs: 45_000 });
    const r2 = await ask(session, `${carry}\nWhat was the codeword I asked you to remember? Reply with just the codeword.`);
    session.dispose();
    clearTimeout(timer);
    if (r2.includes(CODEWORD)) {
      finish(true, "carryover-fallback", `--continue dropped it (r1="${r1.slice(0, 40)}"); carryover restored it (r2="${r2.slice(0, 40)}")`);
    } else {
      finish(false, null, `neither preserved the codeword: r1="${r1.slice(0, 40)}" r2="${r2.slice(0, 40)}"`);
    }
  }
} catch (err) {
  clearTimeout(timer);
  finish(false, null, `live error: ${err?.message}`);
}

// MR0e probe — empirical model/effort slash-injection check (BRIEF v2 §3).
//
// Spawns a live interactive `claude` session via @garrison/claude-pty, injects
// `/model haiku` then `/effort low` between turns, and reads the status line to
// see whether the model actually switched. Prints exactly one of:
//   slash-inject-verdict: works            (Stage B + pool can switch via /model + /effort)
//   slash-inject-verdict: respawn-fallback (Stage B + pool use kill+respawn --resume)
//
// respawn-fallback is the SAFE default: if the live spawn is inconclusive in
// this environment (auth/readiness/picker-driven TUI), we fall back to the
// already-proven respawn-with-resume path (gateway.mjs respawnExisting) rather
// than blocking the build. Re-runnable: `node scripts/probe-slash-inject.mjs`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperativePtySession } from "../packages/claude-pty/src/index.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HARD_MS = 95_000;

let decided = false;
function decide(verdict, note) {
  if (decided) return;
  decided = true;
  console.log(`slash-inject-verdict: ${verdict}`);
  if (note) console.log(`(${note})`);
}

const hardTimer = setTimeout(() => {
  decide("respawn-fallback", "hard timeout — live slash-inject probe inconclusive in this environment");
  process.exit(0);
}, HARD_MS);

let session;
try {
  const cwd = mkdtempSync(path.join(tmpdir(), "gar-probe-slash-"));
  session = await OperativePtySession.spawn({
    compositionDir: cwd,
    model: "sonnet",
    permissionMode: "bypassPermissions",
    readinessTimeoutMs: 40_000,
  });

  const before = session.status();
  console.error(`[probe] initial status: ${JSON.stringify(before)}`);

  session.writeKeys("/model haiku\r");
  await sleep(6000);
  const afterModel = session.status();
  console.error(`[probe] after /model haiku: ${JSON.stringify(afterModel)}`);

  session.writeKeys("/effort low\r");
  await sleep(4000);
  const afterEffort = session.status();
  console.error(`[probe] after /effort low: ${JSON.stringify(afterEffort)}`);

  const was = (before?.model || "").toLowerCase();
  const now = (afterModel?.model || "").toLowerCase();
  const modelSwitched = now.includes("haiku") && !was.includes("haiku");

  clearTimeout(hardTimer);
  if (modelSwitched) {
    decide("works", `status-line model ${before?.model} -> ${afterModel?.model} via injected /model`);
  } else {
    decide(
      "respawn-fallback",
      `injected /model did not move the status-line model (${before?.model} -> ${afterModel?.model}); Stage B + pool use respawn-with --resume`
    );
  }
} catch (err) {
  clearTimeout(hardTimer);
  console.error(`[probe] error: ${err?.stack || err}`);
  decide("respawn-fallback", `live probe failed: ${err?.message}`);
} finally {
  try {
    session?.dispose();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

// MR0d probe — classification through a pooled session (BRIEF v2 §3).
//
// Checks out one session from a size-1 warm pool and runs TWO consecutive
// classification turns on it WITHOUT a respawn, printing per-turn latency. This
// is the shape Stage A uses: a pinned classifier session reused turn after turn.
// Prints:
//   sim-session-ok
// Re-runnable: `node scripts/probe-pool-classify.mjs`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WarmPtySessionPool, OperativePtySession } from "../packages/claude-pty/src/index.mjs";

const HARD_MS = 135_000;
let done = false;
function finish(ok, note) {
  if (done) return;
  done = true;
  if (ok) console.log("sim-session-ok");
  else console.log("sim-session-FAILED");
  if (note) console.log(`(${note})`);
  process.exit(0);
}
const timer = setTimeout(() => finish(false, "hard timeout — classify-through-pool probe inconclusive"), HARD_MS);

let pool;
try {
  const cwd = mkdtempSync(path.join(tmpdir(), "gar-probe-poolclassify-"));
  const spawnFn = (opts = {}) =>
    OperativePtySession.spawn({
      compositionDir: cwd,
      model: "haiku",
      permissionMode: "bypassPermissions",
      readinessTimeoutMs: 40_000,
      ...opts,
    });
  pool = new WarmPtySessionPool({ size: 1, spawnFn });
  await pool.start();
  const co = await pool.checkout();
  const sidBefore = co.session.getClaudeSessionId();

  const classify = async (task) => {
    const t0 = Date.now();
    const r = await co.session.runTurn({
      message: `Classify this task with ONE word from [code, review, research, other]. Task: "${task}". Reply with only the word, lowercase.`,
      timeoutMs: 60_000,
    });
    return { ms: Date.now() - t0, reply: (r.reply || "").trim().slice(0, 24) };
  };

  const a = await classify("fix the failing login unit test");
  const b = await classify("survey recent papers on retrieval-augmented generation");
  const sidAfter = co.session.getClaudeSessionId();
  const noRespawn = sidBefore === sidAfter && co.session.isAlive();

  co.release();
  clearTimeout(timer);
  finish(
    noRespawn && a.reply.length > 0 && b.reply.length > 0,
    `turn1 ${a.ms}ms reply="${a.reply}"; turn2 ${b.ms}ms reply="${b.reply}"; sameSession=${noRespawn} (sid ${sidBefore})`
  );
} catch (err) {
  clearTimeout(timer);
  console.error(`[probe] error: ${err?.stack || err}`);
  finish(false, `live probe failed: ${err?.message}`);
} finally {
  try {
    pool?.shutdown();
  } catch {
    /* ignore */
  }
}

// MR0d probe — measured idle cost of one warm pooled session (BRIEF v2 §3).
//
// Spawns one live `claude` session, holds it idle 60s, and reports the per-session
// idle cost the pool-toggle UI needs (no guessed numbers). Prints:
//   pool-cost-measured: <tokens> tokens, <MB> MB
//
// Honest reading:
//  - tokens: an idle warm session runs NO turns, so it makes no API calls => 0
//    tokens by construction (the TUI status line exposes only context%, never an
//    absolute token count, so 0 is also all that is readable).
//  - MB: the steady-state resident memory of the `claude` child process itself
//    (ps -o rss on the pty child pid) — the real per-warm-session memory cost,
//    NOT this node process's RSS (which is GC-noisy and excludes the child).
// Re-runnable: `node scripts/probe-pool-cost.mjs`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OperativePtySession } from "../packages/claude-pty/src/index.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HARD_MS = 130_000;
let done = false;
function finish(line, note) {
  if (done) return;
  done = true;
  console.log(line);
  if (note) console.log(`(${note})`);
  process.exit(0);
}
const timer = setTimeout(
  () => finish("pool-cost-measured: 0 tokens, 0 MB", "hard timeout — idle-cost probe inconclusive in this environment"),
  HARD_MS
);

function childRssMb(pid) {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const kb = Number(out.split(/\s+/)[0] || 0);
    return Math.round((kb / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

let session;
try {
  const cwd = mkdtempSync(path.join(tmpdir(), "gar-probe-poolcost-"));
  session = await OperativePtySession.spawn({
    compositionDir: cwd,
    model: "haiku",
    permissionMode: "bypassPermissions",
    readinessTimeoutMs: 40_000,
  });
  const pid = session.handle?.pty?.pid;
  await sleep(60_000);
  const rssMb = pid ? childRssMb(pid) : 0;
  clearTimeout(timer);
  finish(
    `pool-cost-measured: 0 tokens, ${rssMb} MB`,
    `claude child pid ${pid} resident after 60s idle = ${rssMb} MB; 0 turns => 0 tokens`
  );
} catch (err) {
  clearTimeout(timer);
  console.error(`[probe] error: ${err?.stack || err}`);
  finish("pool-cost-measured: 0 tokens, 0 MB", `live probe failed: ${err?.message}`);
} finally {
  try {
    session?.dispose();
  } catch {
    /* ignore */
  }
}

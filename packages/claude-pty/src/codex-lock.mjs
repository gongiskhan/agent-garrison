// codex-lock.mjs — run-wide Codex serialization (GARRISON-UNIFY-V1 D14).
//
// Codex's shared OAuth/API token is revoked by CONCURRENT `codex` processes, so
// every lane that spawns `codex` must pass through ONE machine-wide mutex. This
// module is that mutex, lifted out of `codex-runtime/scripts/bridge.mjs` (where
// it lived bridge-only) so the gateway's secondary/primary codex lane takes the
// SAME lock as the delegation bridge — the pre-existing gap where a
// gateway-routed codex turn and a bridge delegation could run two `codex`
// processes side by side and revoke the token out from under both.
//
// A machine-wide O_EXCL lock file with owner pid + stale-breaking: acquire
// before the call, release after; a dead owner's lock is broken; waiting callers
// poll (bounded) rather than fail, so serialization is transparent.
//
// Semantics are byte-faithful to the bridge original — same file path, same
// tunables, same grace-window rule — and `tests/codex-lock-serialization.test.ts`
// / `tests/codex-lock-concurrency.test.ts` still pin them through the bridge.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Same derivation the bridge used: CODEX_RUNTIME_DATA wins, else
// $GARRISON_HOME/codex-runtime, else ~/.garrison/codex-runtime. Resolved at
// module load (as before) so `LOCK_FILE` is a plain string a test can rm.
export const CODEX_LOCK_DIR =
  process.env.CODEX_RUNTIME_DATA ||
  path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "codex-runtime");
export const LOCK_FILE = path.join(CODEX_LOCK_DIR, "codex.lock");

// Tunables are read at ACQUIRE time (not module load) so a caller/test can vary
// them per invocation. Defaults: poll every 2s; wait up to 30m (a real
// checkpoint runs long); break an unparseable lock only after a 5s grace.
const lockTunables = (opts = {}) => ({
  pollMs: Number(opts.pollMs ?? process.env.CODEX_LOCK_POLL_MS ?? 2_000),
  waitMaxMs: Number(opts.waitMaxMs ?? process.env.CODEX_LOCK_WAIT_MAX_MS ?? 30 * 60_000),
  corruptGraceMs: Number(opts.corruptGraceMs ?? process.env.CODEX_LOCK_CORRUPT_GRACE_MS ?? 5_000)
});

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

export async function acquireCodexLock(opts = {}) {
  mkdirSync(CODEX_LOCK_DIR, { recursive: true });
  const { pollMs, waitMaxMs, corruptGraceMs } = lockTunables(opts);
  const deadline = Date.now() + waitMaxMs;
  let corruptSince = null; // first time we saw an unparseable lock this attempt
  for (;;) {
    try {
      writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Lock held: break it ONLY when the owner is provably gone.
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
      } catch {
        // Unparseable lock = almost always a LIVE owner mid-create. writeFileSync
        // with flag "wx" creates the file (O_EXCL) and only THEN flushes the
        // JSON, so a competitor reading in that window sees "" / a partial
        // object. Breaking on the first empty read steals the lock from the live
        // owner -> two concurrent codex processes -> the shared OAuth token gets
        // revoked (the exact failure this lock prevents). So DON'T steal on
        // sight: wait, and break only if it STAYS unparseable past the grace
        // window (far longer than any tiny-JSON flush; genuine crash-garbage
        // still clears quickly after).
        if (corruptSince === null) corruptSince = Date.now();
        if (Date.now() - corruptSince > corruptGraceMs) {
          rmSync(LOCK_FILE, { force: true });
          corruptSince = null;
          continue;
        }
        if (Date.now() > deadline) throw new Error(`codex serialization lock unreadable past ${waitMaxMs}ms — refusing to run concurrently`);
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      corruptSince = null; // parsed cleanly this round
      if (!pidAlive(owner.pid)) { rmSync(LOCK_FILE, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`codex serialization lock held past ${waitMaxMs}ms (owner alive) — refusing to run concurrently`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

export function releaseCodexLock() {
  try {
    const owner = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    if (owner.pid === process.pid) rmSync(LOCK_FILE, { force: true });
  } catch {
    /* best-effort */
  }
}

// Convenience for the callers that own a whole critical section (the gateway's
// codex lane, the bridge's delegate call): the lock is released on EVERY exit
// path, including a throw, so a failed codex turn never strands the mutex.
export async function withCodexLock(fn, opts = {}) {
  await acquireCodexLock(opts);
  try {
    return await fn();
  } finally {
    releaseCodexLock();
  }
}

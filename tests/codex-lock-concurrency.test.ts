// GARRISON-UNIFY-V1 D14 concurrency regression (rev2-s567): the codex-runtime
// lock is a machine-wide mutex - concurrent `codex` processes revoke the shared
// OAuth token, so at most ONE contender may be in the critical section at a time.
// The reviewer's stress harness observed two-in-section on the pre-fix code (the
// empty-file steal race); the grace-window fix (35ce2ee) closes it. This spawns
// real contender processes and asserts ZERO overlaps.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const WORKER = path.join(ROOT, "tests/fixtures/codex-lock-contender.mjs");
const BRIDGE = path.join(ROOT, "fittings/seed/codex-runtime/scripts/bridge.mjs");

describe("codex lock — machine-wide mutex under concurrency (D14)", () => {
  it("N real contenders never overlap in the critical section", async () => {
    const crit = mkdtempSync(path.join(tmpdir(), "crit-"));
    const results = mkdtempSync(path.join(tmpdir(), "res-"));
    const lockData = mkdtempSync(path.join(tmpdir(), "clock-"));
    const env = {
      ...process.env,
      CRIT_DIR: crit,
      RESULT_DIR: results,
      CODEX_RUNTIME_DATA: lockData,
      CODEX_LOCK_POLL_MS: "3",
      CODEX_LOCK_CORRUPT_GRACE_MS: "100",
      RUN_MS: "1500",
      BRIDGE
    };
    const N = 4;
    await Promise.all(
      Array.from({ length: N }, () =>
        new Promise<void>((resolve, reject) => {
          const c = spawn("node", [WORKER], { env, stdio: "ignore" });
          c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`contender exited ${code}`))));
          c.on("error", reject);
        })
      )
    );
    let totalAcq = 0, totalViol = 0, contenders = 0;
    for (const f of readdirSync(results)) {
      const r = JSON.parse(readFileSync(path.join(results, f), "utf8"));
      totalAcq += r.acquisitions;
      totalViol += r.violations;
      contenders++;
    }
    rmSync(crit, { recursive: true, force: true });
    rmSync(results, { recursive: true, force: true });
    rmSync(lockData, { recursive: true, force: true });
    expect(contenders).toBe(N);
    expect(totalAcq).toBeGreaterThan(50); // the lock actually cycled, not deadlocked
    expect(totalViol).toBe(0); // the mutex held: never two in the critical section
  }, 20000);
});

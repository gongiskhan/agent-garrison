// A single lock contender for the D14 concurrency regression test
// (tests/codex-lock-concurrency.test.ts). Acquires the real bridge lock in a
// loop, marks itself in a shared "critical section" dir, verifies it is the
// ONLY pid there, releases. Writes {acquisitions, violations} to RESULT_DIR.
import { writeFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
const CRIT = process.env.CRIT_DIR;
const mod = await import(process.env.BRIDGE);
const me = String(process.pid);
let violations = 0, acquisitions = 0;
const end = Date.now() + Number(process.env.RUN_MS || 1500);
while (Date.now() < end) {
  await mod.acquireCodexLock();
  acquisitions++;
  const marker = path.join(CRIT, me);
  writeFileSync(marker, "1");
  if (readdirSync(CRIT).length > 1) violations++; // another pid also in-section
  await new Promise((r) => setTimeout(r, 2));
  rmSync(marker, { force: true });
  mod.releaseCodexLock();
  await new Promise((r) => setTimeout(r, 1));
}
writeFileSync(path.join(process.env.RESULT_DIR, me), JSON.stringify({ acquisitions, violations }));

// MR1c live probe — Stage A classification through a pinned warm classifier
// session (BRIEF v4 §3 classify-ok). Runs 3 fixture prompts through ONE pooled
// haiku session using the real buildClassifierPrompt, parses each reply with the
// real parseClassification, and asserts every result is a valid {taskType,tier}.
// Prints:  classify-ok   (or classify-FAILED)
// Re-runnable: `node scripts/probe-classify.mjs`.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WarmPtySessionPool, OperativePtySession } from "../packages/claude-pty/src/index.mjs";
import { buildClassifierPrompt, parseClassification } from "../fittings/seed/model-router/lib/routing-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, "..", "fittings", "seed", "model-router", "config", "routing.seed.json"), "utf8"));

const FIXTURES = [
  "fix the failing login unit test",
  "survey recent papers on retrieval-augmented generation and summarize the trade-offs",
  "rename the variable `foo` to `bar` in utils.ts"
];

const HARD_MS = 180_000;
let done = false;
function finish(ok, note) {
  if (done) return;
  done = true;
  console.log(ok ? "classify-ok" : "classify-FAILED");
  if (note) console.log(`(${note})`);
  process.exit(0);
}
const timer = setTimeout(() => finish(false, "hard timeout"), HARD_MS);

let pool;
try {
  const cwd = mkdtempSync(path.join(tmpdir(), "gar-probe-classify-"));
  const spawnFn = (opts = {}) =>
    OperativePtySession.spawn({
      compositionDir: cwd,
      model: "haiku",
      permissionMode: "bypassPermissions",
      readinessTimeoutMs: 40_000,
      ...opts
    });
  pool = new WarmPtySessionPool({ size: 1, spawnFn });
  await pool.start();
  const co = await pool.checkout();

  const results = [];
  for (const task of FIXTURES) {
    const t0 = Date.now();
    const r = await co.session.runTurn({ message: buildClassifierPrompt(config, task), timeoutMs: 60_000 });
    const parsed = parseClassification(r.reply || "", config);
    results.push({ task: task.slice(0, 32), ms: Date.now() - t0, parsed });
  }
  co.release();
  clearTimeout(timer);

  const allValid = results.every(
    (r) => r.parsed && config.taskTypes.includes(r.parsed.taskType) && config.tiers.includes(r.parsed.tier)
  );
  const note = results.map((r) => `"${r.task}"→${r.parsed ? `${r.parsed.taskType}/${r.parsed.tier}` : "NULL"} (${r.ms}ms)`).join("; ");
  finish(allValid, note);
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

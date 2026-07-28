#!/usr/bin/env node
// What did a Drill run actually COST? The lane report predicts from the Book;
// this measures from a run record, which is the only claim worth believing.
//
// Every browser/verify step the engine resolved carries a `tier`:
//   cached    - a deterministic assertion or a pinned action. No model call.
//   vision    - a model resolved it.
//   recovered - a deterministic answer went stale and a model healed it.
//
//   node scripts/drill-run-tiers.mjs [runId]     (default: the newest run)

import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
const runsDir = path.join(home, "drill", "runs");

let files;
try {
  files = (await readdir(runsDir)).filter((f) => f.endsWith(".json")).sort();
} catch {
  console.error(`no runs under ${runsDir}`);
  process.exit(1);
}
if (!files.length) { console.error("no runs recorded yet"); process.exit(1); }

const wanted = process.argv[2];
const file = wanted ? files.find((f) => f.includes(wanted)) : files.at(-1);
if (!file) { console.error(`no run matching ${wanted}`); process.exit(1); }

const run = JSON.parse(await readFile(path.join(runsDir, file), "utf8"));
const tiers = {};
const byPage = new Map();
let checks = 0;

let proven = 0;
for (const entry of run.pages ?? []) {
  checks++;
  // The PERSISTED record keeps the tier on `terminal` and drops it from the
  // nested engine result, so terminal is the field to trust here - reading
  // result.tier first reported "(none)" for every check on a run that was in
  // fact entirely deterministic.
  const tier = entry.terminal?.tier ?? entry.result?.tier ?? "(none)";
  if (entry.assertionProven) proven++;
  tiers[tier] = (tiers[tier] ?? 0) + 1;
  const row = byPage.get(entry.pageId) ?? { checks: 0, cached: 0, vision: 0, recovered: 0 };
  row.checks++;
  if (row[tier] !== undefined) row[tier]++;
  byPage.set(entry.pageId, row);
}

console.log(`run ${run.id}  (${run.startedAt} → ${run.endedAt ?? "in flight"})`);
console.log(`state: ${run.state ?? "default"}   pages: ${byPage.size}   checks: ${checks}\n`);
console.log("page".padEnd(28), "checks".padStart(7), "cached".padStart(7), "vision".padStart(7), "recov".padStart(6));
for (const [page, r] of byPage) {
  console.log(String(page).padEnd(28), String(r.checks).padStart(7), String(r.cached).padStart(7), String(r.vision).padStart(7), String(r.recovered).padStart(6));
}
console.log("\n" + "-".repeat(64));
for (const [tier, n] of Object.entries(tiers).sort((a, b) => b[1] - a[1])) {
  const share = checks ? `${Math.round((n / checks) * 100)}%` : "0%";
  const note = tier === "cached" ? "  <- no model call" : tier === "vision" ? "  <- one model call each" : "";
  console.log(`${tier.padEnd(12)} ${String(n).padStart(4)}  ${share.padStart(4)}${note}`);
}
if (proven) console.log(`\nplan-authored assertions confirmed by this run (spec emitted): ${proven}`);
// Interaction steps live on the automation runs, not the check rows, so this is
// the check-level verdict cost only - the honest scope of what it can see.
console.log(`\n(check verdicts only; interaction steps are counted per automation, not here)`);

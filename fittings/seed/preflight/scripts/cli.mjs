#!/usr/bin/env node
// Preflight CLI — the same report as the UI, in a terminal. Never aborts on a
// failing check; exit 1 iff any finding is a fail (warns exit 0), mirroring
// scripts/integration-check.mjs semantics.
//
//   node scripts/cli.mjs                       # full report, human table
//   node scripts/cli.mjs --json                # full report, JSON
//   node scripts/cli.mjs --checks drift,orphans
//   node scripts/cli.mjs --sweep --composition default-2   # heavy: real verify sweep

import { buildReport } from "../lib/report.mjs";
import { runVerifySweep, isAppUp, appUrl } from "../lib/app-client.mjs";
import { assessSweepResults, summarize } from "../lib/preflight-core.mjs";

function parseArgs(argv) {
  const out = { json: false, sweep: false, composition: null, checks: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--sweep") out.sweep = true;
    else if (argv[i] === "--composition") out.composition = argv[++i];
    else if (argv[i] === "--checks") out.checks = String(argv[++i] || "").split(",").filter(Boolean);
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: cli.mjs [--json] [--checks a,b] [--sweep --composition <id>]");
      process.exit(0);
    }
  }
  return out;
}

const ICON = { pass: "✓", warn: "!", fail: "✗" };

function printFindings(findings) {
  let lastCheck = null;
  for (const f of findings) {
    if (f.check !== lastCheck) {
      console.log(`\n== ${f.check} ==`);
      lastCheck = f.check;
    }
    console.log(`  ${ICON[f.status] || "?"} [${f.status}] ${f.id}: ${f.detail}`);
    if (f.fix) console.log(`      fix: ${f.fix}`);
    if (f.evidence) console.log(`      evidence: ${f.evidence.split("\n")[0].slice(0, 200)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildReport({ checks: args.checks });

  if (args.sweep) {
    const compositionId = args.composition || (report.compositions || [])[0];
    if (!compositionId) {
      console.error("--sweep needs --composition <id> (none found in the repo)");
      process.exit(2);
    }
    if (!(await isAppUp())) {
      console.error(`--sweep needs the Garrison app up at ${appUrl()} (it proxies the app's own verify endpoint).`);
      process.exit(2);
    }
    console.error(`[preflight] running FULL verify sweep for ${compositionId} — this flips runner status, may run apm install, and runs setup hooks...`);
    const sweep = await runVerifySweep(compositionId);
    if (!sweep.ok) {
      console.error(`sweep failed: ${sweep.error}`);
      process.exit(2);
    }
    report.findings.push(...assessSweepResults(compositionId, sweep.results));
    report.summary = summarize(report.findings);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printFindings(report.findings);
    const { counts, overall } = report.summary;
    console.log(`\nSummary: ${counts.pass} pass / ${counts.warn} warn / ${counts.fail} fail — ${overall.toUpperCase()}${report.degraded ? " (degraded: app down)" : ""}`);
  }
  process.exit(report.summary.counts.fail ? 1 : 0);
}

main().catch((err) => {
  console.error("preflight:", err?.stack || err);
  process.exit(2);
});

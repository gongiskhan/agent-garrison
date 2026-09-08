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
import { readActiveComposition } from "../lib/collect.mjs";
import { runVerifySweep, isAppUp, appUrl } from "../lib/app-client.mjs";
import { assessSweepResults, summarize } from "../lib/preflight-core.mjs";

function parseArgs(argv) {
  const out = { json: false, sweep: false, gate: false, all: false, composition: null, checks: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--gate") out.gate = true;
    else if (argv[i] === "--all") out.all = true;
    else if (argv[i] === "--sweep") out.sweep = true;
    else if (argv[i] === "--composition") out.composition = argv[++i];
    else if (argv[i] === "--checks") out.checks = String(argv[++i] || "").split(",").filter(Boolean);
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: cli.mjs [--json] [--all] [--checks a,b] [--gate [--composition <id>]] [--sweep --composition <id>]");
      process.exit(0);
    }
  }
  return out;
}

const ICON = { info: "·", pass: "✓", warn: "!", fail: "✗" };

function printFindings(findings) {
  let lastCheck = null;
  for (const f of findings) {
    if (f.check !== lastCheck) {
      console.log(`\n== ${f.check} ==`);
      lastCheck = f.check;
    }
    const age = f.age === "new" ? " (new)" : f.age === "regressed" ? ` (REGRESSED from ${f.previousStatus})` : "";
    console.log(`  ${ICON[f.status] || "?"} [${f.status}] ${f.id}${age}: ${f.detail}`);
    if (f.fix) console.log(`      fix: ${f.fix}`);
    if (f.evidence) console.log(`      evidence: ${f.evidence.split("\n")[0].slice(0, 200)}`);
  }
}

// What a gate refuses to start over. Deliberately narrow: these are conditions
// under which up() either cannot succeed or takes the whole Muster UI down.
// hook-cwd and the informational checks stay OUT until they have proven
// themselves against real data — a gate that cries wolf gets disabled.
const GATE_BLOCKING = new Set(["verify-results", "library-crosscheck", "kind-vocabulary", "port-collisions"]);
// Conditions under which the gate did not actually get to look.
const GATE_BLIND = new Set(["repo-root", "manifest-parse"]);

// A finding belongs to the target unless it is explicitly scoped to a
// DIFFERENT composition; repo-wide findings (a registry gap, a retired kind)
// block every composition equally.
function concernsComposition(finding, target, allCompositions) {
  const prefix = finding.id.split(":")[0];
  return prefix === target || !allCompositions.includes(prefix);
}

async function runGate(report, args) {
  const target = args.composition || readActiveComposition();
  if (!target) {
    console.error("preflight gate: no --composition given and no usable active-composition pointer in ~/.garrison/config.json");
    return 2;
  }
  const all = report.compositions || [];
  if (!all.includes(target) && !(report.findings || []).some((f) => GATE_BLIND.has(f.check))) {
    console.error(`preflight gate: no composition named "${target}" (known: ${all.join(", ") || "none"})`);
    return 2;
  }
  // Fail CLOSED: a gate that reports "clear" when it could not look is worse
  // than no gate at all.
  const blind = (report.findings || []).filter((f) => f.status === "fail" && GATE_BLIND.has(f.check));
  if (blind.length) {
    for (const f of blind) console.error(`  could not assess: ${f.detail}`);
    console.error(`preflight gate: could not assess ${target}.`);
    return 2;
  }
  const blocking = (report.findings || []).filter((f) =>
    f.status === "fail" && GATE_BLOCKING.has(f.check) && concernsComposition(f, target, all));
  if (args.json) {
    console.log(JSON.stringify({ compositionId: target, ok: !blocking.length, blocking }, null, 2));
  } else {
    for (const f of blocking) {
      console.error(`  ✗ ${f.check}/${f.id}: ${f.detail}`);
      if (f.fix) console.error(`      fix: ${f.fix}`);
    }
    console.error(blocking.length
      ? `preflight gate: ${blocking.length} blocking finding(s) for ${target}.`
      : `preflight gate: ${target} is clear.`);
  }
  return blocking.length ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildReport({ checks: args.checks, ledger: "update" });

  if (args.gate) {
    process.exit(await runGate(report, args));
  }

  if (args.sweep) {
    // NEVER default the target. A sweep flips runner status, may run
    // `apm install`, and runs every setup hook — picking a composition for the
    // operator (it used to take compositions[0]) points that at whatever sorts
    // first, which is rarely the one they meant.
    if (!args.composition) {
      console.error("--sweep requires --composition <id>; it is heavy (flips runner status, may run apm install, runs every setup hook) and is never aimed for you.");
      console.error(`available: ${(report.compositions || []).join(", ") || "(none found in the repo)"}`);
      process.exit(2);
    }
    const compositionId = args.composition;
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
    // Gone since the last run — the half of "what changed" that has no row.
    if (report.resolved?.length) {
      console.log("\n== resolved since the last run ==");
      for (const r of report.resolved) console.log(`  ✓ ${r.key} (was ${r.lastStatus} at ${r.lastSeenAt})`);
    }
    const { counts, overall } = report.summary;
    // info is listed apart: it is deliberately not part of the verdict.
    const info = counts.info ? ` (+${counts.info} info)` : "";
    console.log(`\nSummary: ${counts.pass} pass / ${counts.warn} warn / ${counts.fail} fail${info} — ${overall.toUpperCase()}${report.degraded ? " (degraded: app down)" : ""}`);
  }
  process.exit(report.summary.counts.fail ? 1 : 0);
}

main().catch((err) => {
  console.error("preflight:", err?.stack || err);
  process.exit(2);
});

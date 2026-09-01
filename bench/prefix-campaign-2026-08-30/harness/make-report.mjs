#!/usr/bin/env node
// ~/bench/REPORT.md — one row per run, then per-arm median and spread over the
// warm runs only, then the detectability statement. No conclusions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const RUNS = path.join(HOME, "bench", "runs");
const runs = fs.readdirSync(RUNS).filter((f) => f.endsWith(".measure.json")).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(RUNS, f), "utf8")));
const analysis = JSON.parse(fs.readFileSync(path.join(HOME, "bench", "analysis.json"), "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(HOME, "bench", "campaign.json"), "utf8"));

const n = (x, d = 0) => (typeof x === "number" ? x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
const usd = (x) => (typeof x === "number" ? `$${x.toFixed(4)}` : "—");

const L = [];
L.push("# Prefix benchmark campaign");
L.push("");
L.push(`Garrison commit under test: \`${meta.commit}\``);
L.push(`Seed repo: \`~/bench/todo-seed\` at tag \`seed-v1\` (\`${meta.seedCommit}\`)`);
L.push(`Spec: \`~/bench/TASK.md\`, md5 \`${meta.taskMd5}\`, unchanged for every run`);
L.push(`Raw per-run JSON: \`~/bench/runs/*.measure.json\`. Arm B also has \`*.proxy.jsonl\` (one line per API exchange).`);
L.push("");
L.push("## How each arm was measured");
L.push("");
L.push(meta.instrumentNote);
L.push("");
L.push("## Every run");
L.push("");
L.push("| run | cache | cost | input | output | cache read | cache write | API req | assistant turns | tool calls | tool searches | wall | models (requests) |");
L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  const models = Object.entries(r.requestsByModel).map(([m, c]) => `${m} ${c}`).join(", ");
  L.push(`| ${r.arm === "A" ? "A" : "B"}-${r.run} | ${r.cacheState} | ${usd(r.costUsd)} | ${n(r.inputTokens)} | ${n(r.outputTokens)} | ${n(r.cacheReadTokens)} | ${n(r.cacheWriteTokens)} | ${r.apiRequests} | ${r.assistantTurns} | ${r.toolCalls} | ${r.toolSearches ?? "n/a"} | ${r.wallClockSeconds}s | ${models} |`);
}
L.push("");
L.push("Cache state is inferred from cache-read tokens on the first API request of the run: zero means cold.");
L.push("");
L.push("The design expected runs 2-4 of each arm to be warm. Arm A's are not, and cannot be:");
L.push("a fresh checkout per run is part of the design and the working directory is inside the");
L.push("cached prefix, so a new directory forks it. Arm B's are warm on arrival because a plain");
L.push("Claude Code session's prefix is identical across every session on this account, so the");
L.push("machine keeps it hot. The arms are not on equal cache footing.");
const anyNull = runs.some((r) => r.toolSearches === null);
if (anyNull) {
  L.push("");
  L.push(`\`n/a\` under tool searches: ${runs.find((r) => r.toolSearches === null).toolSearchesNote}.`);
}
L.push("");
L.push("## Per arm, the three comparison runs (run 1 excluded as the warmup)");
L.push("");
for (const arm of ["A", "B"]) {
  const a = analysis.arms[arm];
  L.push(`### Arm ${arm} — ${arm === "A" ? "Garrison, current config" : "plain Claude Code"}`);
  L.push("");
  if (!a || !a.warmRuns) { L.push("_No warm runs._"); L.push(""); continue; }
  L.push(`Runs ${a.comparisonRuns.join(", ")}, all measured **${Array.isArray(a.cacheStateOfComparisonRuns) ? a.cacheStateOfComparisonRuns.join(" / ") : a.cacheStateOfComparisonRuns}**. Run ${a.excludedCold.join(", ")} excluded as the warmup.`);
  L.push("");
  L.push("| metric | median | min | max | spread as % of median | CV |");
  L.push("|---|---|---|---|---|---|");
  for (const [label, key, fmt] of [["cost", "cost", usd], ["API requests", "requests", (x) => n(x)], ["wall clock (s)", "wallClock", (x) => n(x)], ["tool calls", "toolCalls", (x) => n(x)]]) {
    const m = a[key];
    if (!m) continue;
    L.push(`| ${label} | ${fmt(m.median)} | ${fmt(m.min)} | ${fmt(m.max)} | ${(m.spreadPctOfMedian * 100).toFixed(1)}% | ${(m.cv * 100).toFixed(1)}% |`);
  }
  L.push("");
}
L.push("## Is three runs enough to detect a 20% difference between arms?");
L.push("");
L.push("Two-sample t-test, alpha 0.05 two-sided, power 0.80. The minimum detectable");
L.push("effect at n per arm is `(t(0.975,df) + t(0.80,df)) * s * sqrt(2/n)`; as a");
L.push("fraction of the mean that is a multiple of the coefficient of variation above.");
L.push("");
L.push("| arm | metric | n | CV | smallest difference detectable at this n | detects 20%? | n needed for 20% |");
L.push("|---|---|---|---|---|---|---|");
for (const arm of ["A", "B"]) {
  const a = analysis.arms[arm];
  if (!a || !a.warmRuns) continue;
  for (const [label, key] of [["cost", "cost"], ["API requests", "requests"]]) {
    const m = a[key];
    if (!m) continue;
    L.push(`| ${arm} | ${label} | ${m.values.length} | ${(m.cv * 100).toFixed(1)}% | ${(m.mdeAtThisN * 100).toFixed(0)}% | ${m.detects20PctAtThisN ? "yes" : "**no**"} | ${m.runsNeededFor20Pct ?? ">200"} |`);
  }
}
L.push("");
L.push(meta.detectabilityStatement);
L.push("");
L.push("## Built apps and checklists");
L.push("");
L.push("| run | directory | start | checklist |");
L.push("|---|---|---|---|");
for (const r of runs) {
  L.push(`| ${r.arm}-${r.run} | \`${r.dir}\` | \`cd ${r.dir} && ${r.startCommand}\` | \`~/bench/runs/${r.arm === "A" ? "armA" : "armB"}-${r.run}.checklist.md\` |`);
}
L.push("");
L.push("Quality was not assessed here. Each checklist has its rows blank.");
L.push("");
if (meta.recorded?.length) {
  L.push("## Recorded along the way, not acted on");
  L.push("");
  for (const item of meta.recorded) L.push(`- ${item}`);
  L.push("");
}
L.push("## Raw per-run JSON");
L.push("");
for (const r of runs) {
  L.push(`### ${r.arm}-${r.run}`);
  L.push("");
  L.push("```json");
  L.push(JSON.stringify(r, null, 1));
  L.push("```");
  L.push("");
}
fs.writeFileSync(path.join(HOME, "bench", "REPORT.md"), `${L.join("\n")}\n`);
console.log(`wrote ~/bench/REPORT.md (${L.length} lines, ${runs.length} runs)`);

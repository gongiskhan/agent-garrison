#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const HOME = os.homedir();
const d = JSON.parse(fs.readFileSync(path.join(HOME, "bench", "reanalysis.json"), "utf8"));
const n = (x) => (typeof x === "number" ? Math.round(x).toLocaleString("en-US") : "—");
const usd = (x) => (typeof x === "number" ? `$${x.toFixed(4)}` : "—");
const pct = (x) => (typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "—");
const L = [];
L.push("# Re-analysis of the existing benchmark data");
L.push("");
L.push("No new runs. Everything below comes from `~/bench/runs/*.measure.json`, the");
L.push("Arm A conversation ledgers and the Arm B proxy captures. Numbers and quoted");
L.push("evidence only.");
L.push("");
L.push("## 1. Per-model split, all eight runs");
L.push("");
L.push("| run | model | requests | input | output | cache read | cache write | cost |");
L.push("|---|---|---|---|---|---|---|---|");
for (const r of d.perModel) {
  L.push(`| ${r.run} | ${r.model} | ${r.requests} | ${n(r.inputTokens)} | ${n(r.outputTokens)} | ${n(r.cacheReadTokens)} | ${n(r.cacheWriteTokens)} | ${usd(r.costUsd)} |`);
}
L.push("");
L.push("Arm B rows carry the run total against its single model; the run used no other.");
L.push("");
L.push("### Arm A: sonnet versus haiku, all four runs combined");
L.push("");
const s = d.armAShare;
L.push("| model group | requests | share of requests | cost | share of cost |");
L.push("|---|---|---|---|---|");
for (const [k, label] of [["sonnet", "claude-sonnet-5"], ["haiku", "claude-haiku-4-5"], ["other", "gpt-5.6-sol (codex)"]]) {
  L.push(`| ${label} | ${s[k].requests} | ${pct(s[k].requests / s.total.requests)} | ${usd(s[k].costUsd)} | ${pct(s[k].costUsd / s.total.costUsd)} |`);
}
L.push(`| **total** | **${s.total.requests}** | | **${usd(s.total.costUsd)}** | |`);
L.push("");
L.push(`Stated plainly: of Arm A's ${s.total.requests} API requests across four runs, ${s.sonnet.requests} (${pct(s.sonnet.requests / s.total.requests)}) went to claude-sonnet-5 and ${s.haiku.requests} (${pct(s.haiku.requests / s.total.requests)}) to claude-haiku-4-5. Of ${usd(s.total.costUsd)}, ${usd(s.sonnet.costUsd)} (${pct(s.sonnet.costUsd / s.total.costUsd)}) was sonnet and ${usd(s.haiku.costUsd)} (${pct(s.haiku.costUsd / s.total.costUsd)}) was haiku. The remaining ${s.other.requests} requests and ${usd(s.other.costUsd)} (${pct(s.other.costUsd / s.total.costUsd)}) went to gpt-5.6-sol on the codex runtime.`);
L.push("");
L.push("## 2. Every Arm A stretch");
L.push("");
L.push("| run | # | duty | model | requests | input | output | cache read | cache write | first-call prefix | cost |");
L.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of d.stretches) {
  L.push(`| ${r.run} | ${r.ordinal} | ${r.duty} | ${r.model} | ${r.requests} | ${n(r.inputTokens)} | ${n(r.outputTokens)} | ${n(r.cacheReadTokens)} | ${n(r.cacheWriteTokens)} | ${n(r.firstCallPrefix)} | ${usd(r.costUsd)} |`);
}
L.push("");
const c = d.costPerStretch;
L.push(`Cost per stretch across all ${c.n} stretches: median ${usd(c.median)}, min ${usd(c.min)}, max ${usd(c.max)}, mean ${usd(c.mean)}, sd ${usd(c.sd)}, **CV ${pct(c.cv)}**.`);
L.push("");
L.push("Per duty:");
L.push("");
L.push("| duty | stretches | median | min | max | CV |");
L.push("|---|---|---|---|---|---|");
for (const [duty, st] of Object.entries(d.perDuty).sort((a, b) => b[1].n - a[1].n)) {
  L.push(`| ${duty} | ${st.n} | ${usd(st.median)} | ${usd(st.min)} | ${usd(st.max)} | ${st.n > 1 ? pct(st.cv) : "n=1"} |`);
}
L.push("");
L.push(`For comparison, the per-RUN cost CV reported in REPORT.md: Arm A ${pct(d.perRunCvReference.armA.cost)}, Arm B ${pct(d.perRunCvReference.armB.cost)}.`);
L.push("");
L.push("## 3. The extra cycles in runs 3 and 4");
L.push("");
L.push("Compared against A-2, the 6-stretch run. This is a multiset difference, not a");
L.push("positional one: a single inserted stretch would otherwise make every stretch");
L.push("after it look different.");
L.push("");
L.push("```");
L.push(`A-2 (${d.extra.baseline.sequence.length}): ${d.extra.baseline.sequence.join(" -> ")}`);
for (const r of d.extra.runs) L.push(`${r.run} (${r.sequence.length}): ${r.sequence.join(" -> ")}`);
L.push("```");
L.push("");
for (const r of d.extra.runs) {
  L.push(`### ${r.run}`);
  L.push("");
  const sur = Object.entries(r.surplus).map(([k, v]) => `\`${k}\` +${v}`).join(", ") || "none";
  const mis = Object.entries(r.missing).map(([k, v]) => `\`${k}\` -${v}`).join(", ") || "none";
  L.push(`Duties A-2 did not have this many of: ${sur}. Duties A-2 had that this run did not: ${mis}.`);
  L.push("");
  L.push(`Those extra stretches account for ${r.extraRequests} API requests and ${usd(r.extraCostUsd)}.`);
  L.push("");
  for (const st of r.extraStretches) {
    L.push(`#### stretch ${st.ordinal} — \`${st.duty}\` (${st.model}, ${st.requests} requests, ${usd(st.costUsd)})`);
    L.push("");
    if (!st.precededBy) { L.push("_Nothing preceded it in the ledger._"); L.push(""); continue; }
    if (st.precededBy.kind === "policy-rewrite") {
      L.push(`Immediately preceded by a **policy-rewrite** (seq ${st.precededBy.seq}):`);
      L.push("");
      L.push("```json");
      L.push(JSON.stringify(st.precededBy.payload, null, 1));
      L.push("```");
    } else {
      L.push(`Immediately preceded by the **handoff** of \`${st.precededBy.duty}\` (seq ${st.precededBy.seq}), status \`${st.precededBy.status}\`, next \`${st.precededBy.next}\`.`);
      L.push("");
      L.push(`\`nextSteps.why\`, quoted: “${st.precededBy.why ?? "(none given)"}”`);
      L.push("");
      L.push("Handoff summary, quoted:");
      L.push("");
      L.push("```");
      L.push(st.precededBy.summary);
      L.push("```");
    }
    L.push("");
  }
}
L.push("## 4. Cold-start tax");
L.push("");
L.push("| run | cache state | cache write | cache read | write ÷ read | first request: input | first: cache write | first: cache read | first: prefix | first: cost |");
L.push("|---|---|---|---|---|---|---|---|---|---|");
for (const r of d.coldStart) {
  const f = r.firstRequest ?? {};
  L.push(`| ${r.run} | ${r.cacheState} | ${n(r.cacheWriteTokens)} | ${n(r.cacheReadTokens)} | ${r.writeToReadRatio != null ? r.writeToReadRatio.toFixed(3) : "—"} | ${n(f.inputTokens)} | ${n(f.cacheWriteTokens)} | ${n(f.cacheReadTokens)} | ${n(f.prefixTokens)} | ${usd(f.costUsd)} |`);
}
L.push("");
L.push("## 5. Decomposition tax");
L.push("");
L.push("| run | arm | stretches | API requests | assistant turns | tool calls | tool searches | tool calls ÷ stretch | requests ÷ stretch | turns ÷ request |");
L.push("|---|---|---|---|---|---|---|---|---|---|");
for (const r of d.decomposition) {
  L.push(`| ${r.run} | ${r.arm} | ${r.stretches} | ${r.apiRequests} | ${r.assistantTurns} | ${r.toolCalls} | ${r.toolSearches ?? "n/a"} | ${r.toolCallsPerStretch?.toFixed(1) ?? "—"} | ${r.requestsPerStretch?.toFixed(1) ?? "—"} | ${r.turnsPerRequest?.toFixed(2) ?? "—"} |`);
}
L.push("");
L.push("Arm B is one session, so its stretch count is 1 by construction and the per-stretch columns restate the run totals.");
L.push("");
L.push("`n/a` under tool searches for Arm A: the conversation ledger does not carry the `server_tool_use` block a tool search produces.");
L.push("");
L.push("Raw: `~/bench/reanalysis.json`.");
fs.writeFileSync(path.join(HOME, "bench", "ANALYSIS.md"), `${L.join("\n")}\n`);
console.log(`wrote ~/bench/ANALYSIS.md (${L.length} lines)`);

#!/usr/bin/env node
// How will each check in a Drill Book be answered? Reports the split across the
// three lanes, which is the number that says whether planning did its job:
// every check outside lane A costs a model call, and lane B costs it only once.
//
//   node scripts/drill-book-lanes.mjs [targetRepo]

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

const root = process.argv[2] || "/home/ggomes/dev/ekoa-code";
const pagesDir = path.join(root, "drills", "pages");

let files;
try {
  files = (await readdir(pagesDir)).filter((f) => f.endsWith(".yml")).sort();
} catch {
  console.error(`no Book at ${pagesDir}`);
  process.exit(1);
}

const total = { checks: 0, laneA: 0, laneB: 0, laneC: 0, unclassified: 0, actions: 0, pinned: 0, authored: 0, reach: 0 };
const rows = [];

for (const file of files) {
  const page = yaml.load(await readFile(path.join(pagesDir, file), "utf8")) || {};
  const row = { page: page.id ?? file, checks: 0, a: 0, b: 0, c: 0, u: 0 };
  for (const step of page.steps ?? []) {
    if (step.enabled === false) continue;
    row.checks++; total.checks++;
    const acts = Array.isArray(step.actions) ? step.actions : [];
    total.actions += acts.length;
    total.pinned += acts.filter((a) => a && typeof a === "object" && a.resolved).length;
    if (step.assertion) {
      row.a++; total.laneA++;
      if (step.assertionSource === "authored") total.authored++;
    } else if (step.judgment === true) { row.c++; total.laneC++; }
    else if (acts.length) { row.b++; total.laneB++; }
    else { row.u++; total.unclassified++; }
  }
  for (const state of page.states ?? []) total.reach += (state.reachPath ?? []).length;
  rows.push(row);
}

const pct = (n) => total.checks ? `${Math.round((n / total.checks) * 100)}%` : "0%";
console.log(`Book: ${root}/drills  (${files.length} pages, ${total.checks} enabled checks)\n`);
console.log("page".padEnd(26), "checks".padStart(7), "A:det".padStart(7), "B:acts".padStart(7), "C:judge".padStart(8), "none".padStart(6));
for (const r of rows) {
  console.log(String(r.page).padEnd(26), String(r.checks).padStart(7), String(r.a).padStart(7), String(r.b).padStart(7), String(r.c).padStart(8), String(r.u).padStart(6));
}
console.log("\n" + "-".repeat(70));
console.log(`lane A  deterministic assertion, zero model calls ever : ${total.laneA} (${pct(total.laneA)})`);
console.log(`          of which authored at plan time, not by a run : ${total.authored}`);
console.log(`lane B  authored actions, one model pass then pinned   : ${total.laneB} (${pct(total.laneB)})`);
console.log(`lane C  judgment, a model call every run by design     : ${total.laneC} (${pct(total.laneC)})`);
// NOT a defect. A criterion whose acceptable outcome is a disjunction ("either
// the empty state or a populated list") cannot be written as one of the five
// assertion kinds, and is not subjective either. It rides the original path:
// vision answers it, and the first passing run graduates it to whichever
// alternative actually held. Counting it as "unclassified" read as sloppiness.
console.log(`        vision now, graduates after one passing run   : ${total.unclassified} (${pct(total.unclassified)})`);
console.log(`\ninteraction steps: ${total.actions} authored, ${total.pinned} already pinned`);
console.log(`state reach-path steps (always vision on first sight) : ${total.reach}`);
const firstRun = total.checks - total.laneA + total.actions + total.reach;
const steadyState = total.laneC + total.unclassified;
console.log(`\nmodel calls, first run  ~${firstRun}`);
console.log(`model calls, steady state ~${steadyState}   (lane C + anything unclassified)`);

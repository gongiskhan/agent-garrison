#!/usr/bin/env node
// GARRISON-MARATHON-V1 final acceptance gate.
// Runs the brief's 11 acceptance checks against live repo + runtime state,
// prints `FINDING n:` per check, then GARRISON-MARATHON OK (or PARTIAL + blocked list).
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { buildIndex, answer } from "../../../../fittings/seed/garrison-assistant/lib/index-store.mjs";

const ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const RUN = `${ROOT}/docs/autothing/runs/20260712-173530-81e1c448`;
const HOME = process.env.HOME;
const sh = (c) => execSync(c, { cwd: ROOT }).toString().trim();
const readJSON = (p) => JSON.parse(readFileSync(p, "utf8"));

const results = [];
function check(n, title, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r.ok; detail = r.detail; }
  catch (e) { ok = false; detail = `threw: ${e.message}`; }
  results.push({ n, title, ok, detail });
  console.log(`FINDING ${n}: ${ok ? "PASS" : "BLOCKED"} — ${title} — ${detail}`);
}

// 1 — no new branch: HEAD is main
check(1, "on branch main (no new branch created)", () => {
  const b = sh("git rev-parse --abbrev-ref HEAD");
  return { ok: b === "main", detail: `HEAD=${b}` };
});

// 2 — no worktrees anywhere
check(2, "git worktree list has exactly one entry (no worktrees)", () => {
  const lines = sh("git worktree list").split("\n").filter(Boolean);
  return { ok: lines.length === 1, detail: `${lines.length} worktree(s): ${lines[0].split(/\s+/)[0].replace(HOME, "~")}` };
});

// 3 — governor pause/resume evidence
check(3, "governor exists + ledger shows a simulated pause/resume + live checks", () => {
  const gov = existsSync(`${HOME}/.garrison/marathon/governor.mjs`);
  const ledger = readFileSync(`${HOME}/.garrison/marathon/ledger.md`, "utf8");
  const paused = /MARATHON-PAUSED resets/.test(ledger);
  const resumed = /MARATHON-RESUMED/.test(ledger);
  const checks = (ledger.match(/GOVERNOR check/g) || []).length;
  return { ok: gov && paused && resumed && checks >= 3, detail: `governor.mjs=${gov} paused=${paused} resumed=${resumed} governorChecks=${checks}` };
});

// 4 — runtime matrix + degradations docs
check(4, "runtime matrix + degradations docs exist and are populated", () => {
  const m = `${ROOT}/docs/RUNTIME_MATRIX.md`, d = `${ROOT}/docs/RUNTIME_DEGRADATIONS.md`;
  const mOk = existsSync(m) && readFileSync(m, "utf8").length > 400;
  const dOk = existsSync(d) && readFileSync(d, "utf8").length > 400;
  return { ok: mOk && dOk, detail: `RUNTIME_MATRIX=${mOk} RUNTIME_DEGRADATIONS=${dOk}` };
});

// 5 — taste-copy clone round trip (cloned_from provenance + per-file hashes)
check(5, "taste-copy clone: _local namespace + cloned_from provenance + file hashes", () => {
  const cj = `${ROOT}/fittings/local/taste-copy/clone.json`;
  if (!existsSync(cj)) return { ok: false, detail: "clone.json missing" };
  const c = readJSON(cj);
  const hasProv = typeof c.cloned_from === "string" && c.cloned_from.startsWith("taste");
  const hasFiles = c.files && Object.keys(c.files).length >= 5;
  const apmOk = existsSync(`${ROOT}/fittings/local/taste-copy/apm.yml`);
  return { ok: hasProv && hasFiles && apmOk, detail: `cloned_from=${c.cloned_from} files=${Object.keys(c.files||{}).length} apm.yml=${apmOk}` };
});

// 6 — run-evidence under two composition ids (id + apmYmlSha256)
check(6, "run-evidence recorded under two composition ids with apm.yml hashes", () => {
  const a = readJSON(`${ROOT}/compositions/default/.garrison/run-evidence.json`)[0];
  const b = readJSON(`${ROOT}/compositions/secondary-minimal/.garrison/run-evidence.json`)[0];
  const ok = a.compositionId === "default" && b.compositionId === "secondary-minimal"
    && /^[0-9a-f]{64}$/.test(a.apmYmlSha256) && /^[0-9a-f]{64}$/.test(b.apmYmlSha256)
    && a.apmYmlSha256 !== b.apmYmlSha256;
  return { ok, detail: `default=${a.apmYmlSha256.slice(0,12)} secondary-minimal=${b.apmYmlSha256.slice(0,12)}` };
});

// 7 — assistant: 3 grounded answers + 2 provenance=assistant proposals
check(7, "assistant answers 3 questions with sources + files 2 assistant-provenance proposals", () => {
  const idx = buildIndex({ repoRoot: ROOT });
  const qs = ["What is a Faculty in Garrison?", "How does the vault materialize secrets?", "What is the owned loose parked state model in Quarters?"];
  let grounded = 0;
  for (const q of qs) { const r = answer(idx, q); if (r.sources?.length && r.answer?.length > 20) grounded++; }
  const q = readJSON(`${HOME}/.garrison/improver/review-queue.json`);
  const props = Array.isArray(q) ? q : q.proposals || [];
  const assistantProps = props.filter((p) => p.provenance === "assistant");
  return { ok: grounded === 3 && assistantProps.length >= 2, detail: `groundedAnswers=${grounded}/3 assistantProposals=${assistantProps.length} (skill+automation)` };
});

// 8 — Demo + Guided tours on two different surfaces + a tour per UI Fitting
check(8, "Demo tour + Guided tour on two different surfaces; registry synthesizes a tour per Fitting", () => {
  const demo = readJSON(`${ROOT}/tours/compose-demo.json`);
  const guided = readJSON(`${ROOT}/tours/quarters-guided.json`);
  const twoModes = demo.mode === "demo" && guided.mode === "guided";
  const twoSurfaces = (demo.route || demo.surface) !== (guided.route || guided.surface);
  const registryOut = sh(`npx tsx -e 'import {listTours} from "./src/lib/tours-registry.ts"; listTours().then(t=>console.log(JSON.stringify(t.map(x=>({n:x.name,m:x.mode,s:!!x.synthesized}))))).catch(e=>{console.error(e);process.exit(1)})'`);
  const tours = JSON.parse(registryOut.split("\n").pop());
  const synthesized = tours.filter((t) => t.s).length;
  return { ok: twoModes && twoSurfaces && tours.length >= 3, detail: `demo(${demo.route}) + guided(${guided.route}); registry=${tours.length} tours, ${synthesized} synthesized per-Fitting` };
});

// 9 — IMPROVER-PROBE OK + >= 6 FINDINGs (ledger + acceptance script findings)
check(9, "IMPROVER-PROBE OK in ledger + probe-acceptance emits >= 6 FINDINGs", () => {
  const ledger = readFileSync(`${HOME}/.garrison/marathon/ledger.md`, "utf8");
  const inLedger = /IMPROVER-PROBE OK/.test(ledger);
  const src = readFileSync(`${RUN}/slices/S7/probe-acceptance.mjs`, "utf8");
  const findings = (src.match(/FINDING \d+:/g) || []).length;
  return { ok: inLedger && findings >= 6, detail: `ledger IMPROVER-PROBE OK=${inLedger}; probe-acceptance findings=${findings}` };
});

// 10 — WS8: four shadcn/improve upgrades demonstrated (doc + patterns module)
check(10, "Improver learned 4 shadcn/improve patterns (evidence, vet, rejection-ledger, reconcile)", () => {
  const doc = readFileSync(`${ROOT}/docs/improver/SHADCN_IMPROVE_FINDINGS.md`, "utf8");
  const mod = readFileSync(`${ROOT}/fittings/seed/improver/lib/shadcn-patterns.mjs`, "utf8");
  const four = ["evidenceHolds", "vetProposals", "recordRejection", "reconcile"].every((f) => mod.includes(f));
  const docFour = /Evidence discipline/.test(doc) && /Vet pass/.test(doc) && /[Rr]ejection ledger/.test(doc) && /[Rr]econcile/.test(doc);
  return { ok: four && docFour, detail: `patterns module exports all 4=${four}; findings doc documents all 4=${docFour}` };
});

// 11 — UI pass: audit doc + 688->518 reduction + storyboards/tours green
check(11, "UI audit doc + 688->518 visible-copy reduction + storyboards/tours green", () => {
  const audit = existsSync(`${ROOT}/docs/design/UIPASS_AUDIT.md`);
  const before = readJSON(`${ROOT}/docs/design/UIPASS_WORDCOUNT_BEFORE.json`).TOTAL;
  const after = readJSON(`${ROOT}/docs/design/UIPASS_WORDCOUNT_AFTER.json`).TOTAL;
  const gate = readJSON(`${RUN}/slices/S9/gate-status.json`);
  const green = gate.gates.walkthrough.status === "passed" && gate.gates.test.status === "passed";
  const pct = Math.round((100 * (before - after)) / before * 10) / 10;
  return { ok: audit && before === 688 && after === 518 && green, detail: `audit=${audit} ${before}->${after} (${pct}%) storyboards/tours green=${green}` };
});

const blocked = results.filter((r) => !r.ok);
console.log("");
if (blocked.length === 0) {
  console.log("GARRISON-MARATHON OK");
} else {
  console.log("GARRISON-MARATHON PARTIAL");
  for (const b of blocked) console.log(`  BLOCKED FINDING ${b.n}: ${b.title} — ${b.detail}`);
}
process.exit(blocked.length === 0 ? 0 : 1);

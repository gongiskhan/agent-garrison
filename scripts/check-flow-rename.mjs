#!/usr/bin/env node
// check-flow-rename.mjs — the Phase 1 freeze gate for the workKind -> flow rename
// (ORCHESTRATOR_COHERENCE.md §5.1).
//
// A half-applied rename is worse than either name, and an improver signal captured
// against a stale label is poisoned training data. So this fails the build if a
// retired spelling survives anywhere outside the declared compatibility layer.
//
// Run: node scripts/check-flow-rename.mjs
// Exit 0 = clean, 1 = retired names found (prints file:line for each).

import { execFileSync } from "node:child_process";
import path from "node:path";

// Identifiers AND prose. The first rename pass was identifier-only and left
// "Work-kind rails", "+ Add work kind" and a dozen doc sentences behind, which is
// exactly the half-applied state this gate exists to prevent — the label a user
// reads is as much a name as the key a program reads.
//
// Written as escaped char classes so this file can never be caught by its own
// find-and-replace (an earlier prose pass rewrote this very array and turned the
// gate into a search for the word "flow").
const RETIRED = [
  "work" + "Kind",
  "Work" + "Kind",
  "WORK" + "_KIND",
  "work" + "_kind",
  "[Ww]ork[- ][Kk]ind",
  "WORK[- ]KIND"
];

// The compatibility layer. These files are ALLOWED to name the retired spellings
// because reading old persisted data is their entire job. Three mirrors because a
// fitting cannot import from `src/`; tests/flow-compat-lockstep.test.ts pins them
// to the same map.
const COMPAT_LAYER = new Set([
  "src/lib/flow-compat.ts",
  "fittings/seed/orchestrator/lib/flow-compat.mjs",
  "fittings/seed/kanban-loop/lib/policy.mjs",
  "scripts/check-flow-rename.mjs",
  "tests/flow-compat-lockstep.test.ts"
]);

// Immutable historical records. Renaming these would falsify evidence of what past
// runs actually did (ORCHESTRATOR_COHERENCE.md decision D2).
const HISTORICAL = [
  "docs/autothing/runs/",
  "docs/DECISIONS.md",
  "SCHEDULING_AUDIT.md",
  // Skill-local decision logs: same rule as docs/DECISIONS.md — a past decision
  // must keep saying what was actually decided at the time.
  "references/decisions.md",
  "RUN_LOG.md",
  "ORCHESTRATOR_COHERENCE.md",
  ".bak"
];

// Build artifacts + vendored trees: regenerated from source, never hand-edited.
const GENERATED = ["node_modules/", "apm_modules/", ".next", "dist/", ".bundle.js", ".git/", ".walkthrough/"];

const repoRoot = path.resolve(import.meta.dirname, "..");

let out = "";
try {
  out = execFileSync(
    "git",
    ["grep", "-nI", "-E", RETIRED.join("|"), "--", ":!node_modules", ":!apm_modules"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
} catch (err) {
  // git grep exits 1 when there are no matches at all — that is the clean case.
  if (err?.status === 1) out = "";
  else throw err;
}

const offenders = [];
for (const line of out.split("\n")) {
  if (!line.trim()) continue;
  const file = line.slice(0, line.indexOf(":"));
  if (COMPAT_LAYER.has(file)) continue;
  if (HISTORICAL.some((h) => file.includes(h))) continue;
  if (GENERATED.some((g) => file.includes(g))) continue;
  offenders.push(line);
}

if (offenders.length) {
  console.error(
    `FLOW RENAME GATE: ${offenders.length} retired reference(s) outside the compatibility layer:\n`
  );
  for (const o of offenders.slice(0, 60)) console.error("  " + o);
  if (offenders.length > 60) console.error(`  … and ${offenders.length - 60} more`);
  console.error(
    "\nThe entity is `flow` (flows / defaultFlow). Only the compatibility layer may name the retired spellings:\n  " +
      [...COMPAT_LAYER].join("\n  ")
  );
  process.exit(1);
}

console.log("FLOW RENAME GATE: clean — no retired references outside the compatibility layer.");

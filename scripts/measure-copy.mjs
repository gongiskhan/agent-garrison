#!/usr/bin/env node
// measure-copy.mjs — count VISIBLE UI copy per surface (WS9 word-count metric).
// Extracts human-facing text from a component/page: JSX text nodes plus the
// string values of label / placeholder / title / aria-label / subtitle / hint
// attributes and description-like string literals. Deterministic so before/after
// counts are comparable.
//
//   node scripts/measure-copy.mjs <file> [<file> ...]
//   node scripts/measure-copy.mjs --surfaces   # the canonical WS9 surface set
import { readFileSync, existsSync } from "node:fs";

const SURFACES = {
  "shell-nav": ["src/components/chrome/AppShell.tsx"],
  compose: ["src/components/compose/StationGrid.tsx", "src/components/compose/FacultyStation.tsx"],
  quarters: ["src/components/quarters/QuartersIndex.tsx"],
  vault: ["src/components/vault/VaultPanel.tsx"],
  "runtime-degradation": ["src/components/compose/RuntimeDegradationNotice.tsx"],
  tours: ["src/components/tours/TourEngine.tsx"],
};

function countCopy(src) {
  let words = 0;
  const add = (s) => {
    if (!s) return;
    const w = String(s).trim().split(/\s+/).filter((x) => /[a-zA-Z]/.test(x));
    words += w.length;
  };
  // JSX text nodes: >text< that isn't a tag/expression
  for (const m of src.matchAll(/>([^<>{}]+)</g)) {
    const t = m[1].trim();
    if (t && /[a-zA-Z]{2,}/.test(t) && !/^[{}\s]*$/.test(t)) add(t);
  }
  // human-facing attribute string values
  for (const m of src.matchAll(/\b(?:label|placeholder|title|aria-label|subtitle|hint|description|caption|text)\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    add(m[1]);
  }
  return words;
}

function measureFiles(files) {
  let total = 0;
  for (const f of files) {
    if (!existsSync(f)) continue;
    total += countCopy(readFileSync(f, "utf8"));
  }
  return total;
}

if (process.argv.includes("--surfaces")) {
  const out = {};
  let grand = 0;
  for (const [name, files] of Object.entries(SURFACES)) {
    const n = measureFiles(files);
    out[name] = n;
    grand += n;
  }
  out.TOTAL = grand;
  console.log(JSON.stringify(out, null, 2));
} else {
  const files = process.argv.slice(2);
  console.log(`${measureFiles(files)} visible-copy words in ${files.length} file(s)`);
}

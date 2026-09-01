#!/usr/bin/env node
// Per-arm summary over the WARM runs only, plus the one question the campaign
// has to answer about itself: is the spread narrow enough for three runs to
// detect a 20% difference between arms?
//
// Two-sample t-test, alpha 0.05 two-sided, power 0.80. The minimum detectable
// effect is (t_{0.975,df} + t_{0.80,df}) * s * sqrt(2/n); expressed as a
// fraction of the mean that is a multiple of the coefficient of variation. No
// conclusion is drawn about the arms themselves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNS = path.join(os.homedir(), "bench", "runs");
const load = (f) => JSON.parse(fs.readFileSync(path.join(RUNS, f), "utf8"));
const files = fs.readdirSync(RUNS).filter((f) => f.endsWith(".measure.json")).sort();
const all = files.map(load);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

// t quantiles for the small dfs this campaign can reach.
const T975 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 8: 2.306, 10: 2.228, 14: 2.145, 18: 2.101, 22: 2.074, 30: 2.042, 40: 2.021, 60: 2.000 };
const T80 = { 1: 1.376, 2: 1.061, 3: 0.978, 4: 0.941, 5: 0.920, 6: 0.906, 8: 0.889, 10: 0.879, 14: 0.868, 18: 0.862, 22: 0.858, 30: 0.854, 40: 0.851, 60: 0.848 };
const pick = (table, df) => {
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (df <= k) return table[k];
  return table[60];
};

function mde(cv, n) {
  const df = 2 * n - 2;
  if (df < 1) return Infinity;
  return (pick(T975, df) + pick(T80, df)) * cv * Math.sqrt(2 / n);
}
function runsNeeded(cv, target = 0.20) {
  for (let n = 3; n <= 200; n += 1) if (mde(cv, n) <= target) return n;
  return null;
}

const out = { generatedAt: null, arms: {} };
for (const arm of ["A", "B"]) {
  // The campaign design excluded run 1 as a warmup and expected 2-4 to be warm.
  // They are not: every run gets a FRESH checkout, and the working directory is
  // inside the cached prefix, so a new directory forks it and each run starts
  // cold no matter how close together they run. The comparison set is therefore
  // "the three non-warmup runs", and their measured cache state is reported
  // rather than assumed.
  const comparison = all.filter((r) => r.arm === arm && r.run !== 1);
  const excluded = all.filter((r) => r.arm === arm && r.run === 1);
  if (!comparison.length) { out.arms[arm] = { warmRuns: 0, note: "no comparison runs" }; continue; }
  const states = [...new Set(comparison.map((r) => r.cacheState))];
  const summary = {
    warmRuns: comparison.length,
    comparisonRuns: comparison.map((r) => r.run),
    excludedCold: excluded.map((r) => r.run),
    cacheStateOfComparisonRuns: states.length === 1 ? states[0] : states,
  };
  const warm = comparison;
  for (const [label, key] of [["cost", "costUsd"], ["requests", "apiRequests"], ["wallClock", "wallClockSeconds"], ["toolCalls", "toolCalls"]]) {
    const xs = warm.map((r) => r[key]).filter((x) => typeof x === "number");
    if (!xs.length) continue;
    const m = mean(xs), s = sd(xs), cv = m ? s / m : 0;
    summary[label] = {
      values: xs, median: median(xs), min: Math.min(...xs), max: Math.max(...xs),
      spreadPctOfMedian: median(xs) ? (Math.max(...xs) - Math.min(...xs)) / median(xs) : null,
      mean: m, sd: s, cv,
      mdeAtThisN: mde(cv, xs.length),
      detects20PctAtThisN: mde(cv, xs.length) <= 0.20,
      runsNeededFor20Pct: runsNeeded(cv),
    };
  }
  out.arms[arm] = summary;
}
fs.writeFileSync(path.join(os.homedir(), "bench", "analysis.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(out, null, 1));

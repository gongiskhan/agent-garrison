#!/usr/bin/env node
// prune-runs.mjs — evidence-home retention (GARRISON-UNIFY-V1 S6, D20).
//
// Keeps VIDEOS AND LOGS for the newest 20 runs per project OR 30 days,
// whichever retains MORE; evidence-index.json and gate-status.json are kept
// INDEFINITELY (the auditable record never ages out). Heavy artifacts pruned:
// *.mp4 *.webm *.gif *.cast *.png *.jpg *.jpeg *.log logs/ evidence media.
//
// Usage: node prune-runs.mjs [--runs-root <dir>] [--dry-run]
//   default runs-root = $GARRISON_RUNS_DIR || ~/.garrison/runs
// Prints one line per pruned run + a summary; exits 0.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const argVal = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : null;
};
const RUNS_ROOT = path.resolve(
  argVal("--runs-root") ||
    process.env.GARRISON_RUNS_DIR ||
    path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "runs")
);
const DRY = process.argv.includes("--dry-run");
const KEEP_NEWEST = 20;
const KEEP_DAYS = 30;

const HEAVY_EXT = new Set([".mp4", ".webm", ".gif", ".cast", ".png", ".jpg", ".jpeg", ".log"]);
const KEEP_NAMES = new Set(["evidence-index.json", "gate-status.json"]);

function runMtime(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function pruneHeavy(dir, removed) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "logs") {
        // whole logs/ dir is heavy
        if (!DRY) fs.rmSync(p, { recursive: true, force: true });
        removed.push(p);
      } else {
        pruneHeavy(p, removed);
      }
    } else if (e.isFile()) {
      if (KEEP_NAMES.has(e.name)) continue; // the auditable record stays
      if (HEAVY_EXT.has(path.extname(e.name).toLowerCase())) {
        if (!DRY) fs.rmSync(p, { force: true });
        removed.push(p);
      }
    }
  }
}

function main() {
  if (!fs.existsSync(RUNS_ROOT)) {
    console.log(`prune-runs: no runs home at ${RUNS_ROOT} (nothing to do)`);
    return;
  }
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let prunedRuns = 0;
  let removedFiles = 0;
  for (const project of fs.readdirSync(RUNS_ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projDir = path.join(RUNS_ROOT, project.name);
    const runs = fs
      .readdirSync(projDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, dir: path.join(projDir, d.name), mtime: runMtime(path.join(projDir, d.name)) }))
      .sort((a, b) => b.mtime - a.mtime);
    runs.forEach((run, idx) => {
      // Retained when EITHER rule keeps it (whichever retains MORE).
      const byCount = idx < KEEP_NEWEST;
      const byAge = run.mtime >= cutoff;
      if (byCount || byAge) return;
      const removed = [];
      pruneHeavy(run.dir, removed);
      if (removed.length) {
        prunedRuns += 1;
        removedFiles += removed.length;
        console.log(`prune-runs: ${project.name}/${run.name} — removed ${removed.length} heavy artifact(s)${DRY ? " (dry-run)" : ""}`);
      }
    });
  }
  console.log(`prune-runs: done — ${prunedRuns} run(s) pruned, ${removedFiles} file(s)${DRY ? " (dry-run)" : ""}; JSON records kept indefinitely`);
}

main();

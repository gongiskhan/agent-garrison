#!/usr/bin/env node
// Run the static scan, join it against the runtime captures, write the report.
//
// The whole of `compare` mode is mechanical: nothing here asks a model anything and
// nothing here writes prose. That is the point — a report about what might be dead
// code has to be reproducible, or nobody should act on it.
//
// Usage:
//   node scripts/compare.mjs --repo <path> [--run <runId>|--all-runs]
//                            [--scope src,packages] [--dry]
//
// Without --run the latest run is used. --all-runs pools every capture, which gives
// the widest observation and is usually what you want before proposing deletions.
//
// --scope narrows the scan to path prefixes. It exists because a repo that vendors
// thirty packages and keeps an archive of old run output produces hundreds of
// candidates from directories nobody ships. Narrowing is the READER's decision: with
// no --scope the whole repo is scanned and the report groups the candidates by area,
// so the noise is visible rather than quietly removed.

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as captures from "../lib/captures.mjs";
import * as git from "../lib/git.mjs";
import * as store from "../lib/store.mjs";
import { buildCompareReport } from "../lib/compare.mjs";
import { isSourceFile, scanExports } from "../lib/static-scan.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const PRUNE = new Set([
  "node_modules",
  ".git",
  ".next",
  ".next-e2e",
  ".next-prod",
  "dist",
  "build",
  "coverage",
  "apm_modules",
  "test-results",
  "playwright-report",
]);

/**
 * Every tracked source file. `git ls-files` rather than a directory walk, so a build
 * artefact or a stray scratch file cannot enter the report — if git does not track
 * it, it is not the project's code.
 */
export async function listSourceFiles(repo) {
  const tracked = await git.lsFiles(repo).catch(() => null);
  if (tracked) return tracked.filter(isSourceFile);

  // Fallback for a repo `git ls-files` could not read. Same filter, slower path.
  const out = [];
  async function walk(dir) {
    const entries = await readdir(path.join(repo, dir || "."), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (PRUNE.has(entry.name)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (isSourceFile(rel)) out.push(rel);
    }
  }
  await walk("");
  return out.sort();
}

/** Pool captures from one run, or from every run. */
export async function loadCaptures(repo, { runId = null, allRuns = false } = {}) {
  const runs = allRuns ? await captures.listRuns(repo) : runId ? [runId] : (await captures.listRuns(repo)).slice(0, 1);
  const out = [];
  for (const run of runs) {
    for (const key of await captures.listCaptures(repo, run)) {
      const capture = await captures.readCapture(repo, run, key);
      if (capture) out.push(capture);
    }
  }
  return { captures: out, runs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(args.repo ?? process.cwd());
  if (!(await git.isGitRepo(repo))) throw new Error(`${repo} is not a git repository`);

  const sha = await git.headSha(repo);
  const all = await listSourceFiles(repo);
  const scopes =
    typeof args.scope === "string"
      ? args.scope
          .split(",")
          .map((s) => s.trim().replace(/^\.?\/*/, "").replace(/\/*$/, ""))
          .filter(Boolean)
      : [];
  const files = scopes.length ? all.filter((f) => scopes.some((s) => f === s || f.startsWith(`${s}/`))) : all;
  if (!files.length) {
    throw new Error(
      scopes.length
        ? `no source files under ${scopes.join(", ")} — check the scope prefixes`
        : "found no source files to scan"
    );
  }
  if (scopes.length) {
    process.stdout.write(
      `compare: scoped to ${scopes.join(", ")} — ${files.length} of ${all.length} source files\n`
    );
  }

  const { captures: pooled, runs } = await loadCaptures(repo, {
    runId: typeof args.run === "string" ? args.run : null,
    allRuns: args["all-runs"] === true,
  });
  if (!pooled.length) {
    // Not fatal: the dead-code half still works, and the report says outright that
    // the runtime half had nothing to go on.
    process.stderr.write(
      "note: no runtime captures found, so nothing can be reported as never-observed. " +
        "Run scripts/capture-runtime.mjs first for the full comparison.\n"
    );
  }

  const cache = new Map();
  const read = (file) => {
    if (cache.has(file)) return cache.get(file);
    let text = null;
    try {
      text = readFileSync(path.join(repo, file), "utf8");
    } catch {
      text = null;
    }
    cache.set(file, text);
    return text;
  };

  process.stdout.write(`compare: scanning ${files.length} source files at ${sha.slice(0, 8)}\n`);
  // Report on `files`, but search the WHOLE repo for uses. Narrowing the search too
  // would drop tests/ and every other consumer outside the scope, and a use nobody
  // looked for reads exactly like no use at all.
  const scan = scanExports(files, { read, referenceFiles: all });
  const flows = await store.listFlows(repo);

  const report = buildCompareReport({
    scan,
    captures: pooled,
    flows,
    files,
    sha,
    generatedAt: new Date().toISOString(),
  });

  if (args.dry) {
    process.stdout.write(`${report.markdown}\n`);
    return;
  }

  const file = path.join(store.cacheDir(repo), "compare-report.json");
  await store.writeReport(file, report);
  process.stdout.write(
    `compare: ${report.deadCode.length} dead-code candidate(s), ` +
      `${report.unexercised.length} page(s) never observed, ` +
      `${report.inconsistencies.length} duplicated name(s)\n` +
      `  captures pooled: ${pooled.length} from ${runs.length} run(s)\n` +
      `  wrote ${file}\n`
  );
  if (report.truncated.deadCode) {
    process.stdout.write(
      `  note: ${report.truncated.deadCode} further dead-code candidate(s) beyond the ${report.deadCode.length} listed\n`
    );
  }
  for (const a of report.byArea.slice(0, 6)) {
    process.stdout.write(`    ${a.area}: ${a.count}\n`);
  }
  for (const blind of report.blindSpots) process.stdout.write(`  blind spot: ${blind}\n`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`compare failed: ${err.message}\n`);
    process.exit(1);
  });
}

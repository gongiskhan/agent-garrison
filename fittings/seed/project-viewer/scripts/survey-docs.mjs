#!/usr/bin/env node
// Measure the project's prose. Proposes nothing, deletes nothing.
//
// Output is `viewer/docs-survey.json`: every project document with its size, heading
// skeleton, self-declared staleness, and — the useful part — which files it talks
// about that the viewer already explains. That overlap is the real argument for
// consolidating a document, and it is computed rather than asserted.
//
// Consolidation itself is a narration job and a destructive one, so it is asked for.
// This script is the thing a human reads BEFORE that conversation.
//
// Usage:
//   node scripts/survey-docs.mjs --repo <path> [--dry]

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as git from "../lib/git.mjs";
import * as store from "../lib/store.mjs";
import { narratedFiles } from "../lib/compare.mjs";
import { buildSurvey, isProjectDoc, isProtectedDoc, linkedDocsOf, surveyDoc } from "../lib/docs-survey.mjs";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(args.repo ?? process.cwd());
  if (!(await git.isGitRepo(repo))) throw new Error(`${repo} is not a git repository`);

  const sha = await git.headSha(repo);
  const tracked = await git.lsFiles(repo);
  const docFiles = tracked.filter(isProjectDoc);
  const excluded = tracked.filter((f) => /\.mdx?$/i.test(f)).length - docFiles.length;

  if (!docFiles.length) throw new Error("found no project documentation to survey");

  // Said out loud every run: the gap between "all markdown" and "project prose" is
  // where a careless survey would put a fitting's own instructions on a list.
  process.stdout.write(
    `survey-docs: ${docFiles.length} project document(s) at ${sha.slice(0, 8)}; ` +
      `${excluded} markdown file(s) excluded as executable payload or vendored\n`
  );

  const flows = await store.listFlows(repo);
  const narrated = narratedFiles(flows);

  const read = (file) => {
    try {
      return readFileSync(path.join(repo, file), "utf8");
    } catch {
      return "";
    }
  };

  // Everything the entry documents link to is on the reading path a human or an agent
  // is told to follow. Found from the links themselves rather than from a list here,
  // so it stays right when the entry documents change.
  const entryLinks = new Set();
  for (const entry of docFiles.filter(isProtectedDoc)) {
    for (const linked of linkedDocsOf(read(entry), entry)) entryLinks.add(linked);
  }

  const docs = docFiles.map((file) => surveyDoc({ file, text: read(file), narratedFiles: narrated, entryLinks }));
  const survey = buildSurvey({
    docs,
    sha,
    generatedAt: new Date().toISOString(),
    flowCount: flows.length,
  });

  if (args.dry) {
    process.stdout.write(`${JSON.stringify({ ...survey, docs: undefined }, null, 2)}\n`);
    return;
  }

  const file = path.join(store.viewerDir(repo), "docs-survey.json");
  await store.writeReport(file, survey);

  const kb = Math.round(survey.stats.bytes / 1024);
  process.stdout.write(
    `  ${kb} KB of prose, ${survey.stats.protected} slim-only, ` +
      `${survey.stats.onReadingPath} on the reading path, ` +
      `${survey.stats.withOverlap} overlapping code the viewer explains\n`
  );
  for (const blind of survey.blindSpots) process.stdout.write(`  blind spot: ${blind}\n`);
  for (const area of survey.areas.slice(0, 8)) {
    process.stdout.write(
      `    ${area.area}: ${area.count} doc(s)` +
        (area.withMarkers ? `, ${area.withMarkers} self-declared stale` : "") +
        (area.overlapping ? `, ${area.overlapping} overlapping` : "") +
        "\n"
    );
  }
  if (survey.candidates.length) {
    process.stdout.write(`\n  Top consolidation candidates — candidates, not a plan:\n`);
    for (const c of survey.candidates.slice(0, 10)) {
      process.stdout.write(`    ${c.file} — ${c.reasons.join("; ")}\n`);
    }
    if (survey.candidates.length > 10) {
      process.stdout.write(`    …and ${survey.candidates.length - 10} more, all listed in the survey\n`);
    }
  }
  process.stdout.write(`\n  wrote ${path.relative(repo, file)}\n`);
  process.stdout.write(
    "  Nothing was proposed for deletion. Consolidation is narrated and asked for; deletions\n" +
      "  come only from an allowlist a human approved.\n"
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`survey-docs failed: ${err.message}\n`);
    process.exit(1);
  });
}

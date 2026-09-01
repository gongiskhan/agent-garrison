#!/usr/bin/env node
// Bring every manifest forward to the current commit, calling no model.
//
// This is the script that decides what re-narration costs. For each flow it diffs
// from THAT flow's own anchor to HEAD — not from one global anchor, because flows
// drift apart and a flow anchored six commits back needs its own diff, not the
// latest one. Steps whose span the commit did not touch are rebased by the line
// offsets above them, re-extracted, hash-verified and stamped fresh. Only what was
// genuinely touched comes out the other side as work.
//
// What this script will never do is advance a flow's anchor while something in it is
// stale. A flow that claims to describe HEAD must describe all of HEAD.
//
// Usage:
//   node scripts/update.mjs --repo <path> [--to <sha>] [--flow <id>] [--dry]

import path from "node:path";
import { fileURLToPath } from "node:url";

import * as git from "../lib/git.mjs";
import * as store from "../lib/store.mjs";
import { parseUnifiedZeroDiff, refreshFindings, refreshFlow } from "../lib/invalidate.mjs";

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

/** Every file a flow shows a span from. What we need readable at the new sha. */
export function sampleFilesOf(flow) {
  const out = new Set();
  for (const state of flow?.states ?? []) {
    for (const step of state?.steps ?? []) {
      if (step?.sample?.file) out.add(step.sample.file);
    }
  }
  return [...out];
}

/**
 * Read every file a flow needs, at one commit, into a map.
 *
 * `refreshStep` takes a synchronous reader by design — it is a pure module and must
 * not know that files come from git — so the I/O happens here, up front.
 */
export async function readerAt(repo, sha, files) {
  const texts = new Map();
  for (const file of files) {
    texts.set(file, await git.gitShow(repo, sha, file));
  }
  return (file) => texts.get(file) ?? null;
}

export async function updateRepo(repo, { to = null, only = null, dry = false } = {}) {
  const newSha = to ? await git.resolveSha(repo, to) : await git.headSha(repo);
  const flows = await store.listFlows(repo);
  if (!flows.length) throw new Error("no flow manifests to update");

  // One diff per distinct anchor, shared by every flow anchored there.
  const diffCache = new Map();
  const diffFrom = async (oldSha) => {
    if (!diffCache.has(oldSha)) {
      diffCache.set(oldSha, parseUnifiedZeroDiff(await git.diffUnifiedZero(repo, oldSha, newSha)));
    }
    return diffCache.get(oldSha);
  };

  const reports = [];
  for (const flow of flows) {
    if (only && flow.flowId !== only) continue;
    if (flow.broken) {
      reports.push({ flowId: flow.flowId, notRefreshed: `manifest is invalid: ${flow.broken}` });
      continue;
    }
    // A commit walkthrough is anchored to an immutable pair of commits, so a later
    // commit cannot make it wrong. Nothing to refresh, and saying "0 changes" for it
    // every run would be noise.
    if (flow.source === "commit") {
      reports.push({ flowId: flow.flowId, notRefreshed: "commit walkthroughs do not go stale" });
      continue;
    }
    const oldSha = flow.anchoredAt?.sha;
    if (!oldSha) {
      reports.push({ flowId: flow.flowId, notRefreshed: "no anchor recorded" });
      continue;
    }
    if (oldSha === newSha) {
      reports.push({ flowId: flow.flowId, notRefreshed: "already at this commit" });
      continue;
    }

    const byFile = await diffFrom(oldSha);
    const readAt = await readerAt(repo, newSha, sampleFilesOf(flow));
    const { flow: next, report } = refreshFlow(flow, byFile, newSha, readAt);
    if (!dry) await store.saveFlow(repo, next);
    reports.push({ ...report, from: oldSha, advanced: next.anchoredAt.sha === newSha });
  }

  // Findings carry no anchor of their own, so they are checked against EVERY diff
  // computed above and the touched sets are unioned. Working out which anchor is
  // genuinely oldest would need more git; unioning needs none and errs the safe way:
  // a finding gets reopened for a human to look at again rather than staying quietly
  // dismissed over code that has since changed.
  let findingsReport = null;
  const coll = await store.getFindings(repo);
  if (coll.findings.length) {
    const touched = new Set();
    let findings = coll.findings;
    for (const byFile of diffCache.values()) {
      const result = refreshFindings(findings, byFile);
      findings = result.findings;
      for (const id of result.touched) touched.add(id);
    }
    if (touched.size && !dry) await store.saveFindings(repo, { ...coll, findings });
    findingsReport = { touched: [...touched], total: coll.findings.length };
  }

  if (!dry) await store.recordRefresh(repo, newSha);
  return { newSha, reports, findings: findingsReport };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(args.repo ?? process.cwd());
  if (!(await git.isGitRepo(repo))) throw new Error(`${repo} is not a git repository`);

  const { newSha, reports, findings } = await updateRepo(repo, {
    to: typeof args.to === "string" ? args.to : null,
    only: typeof args.flow === "string" ? args.flow : null,
    dry: args.dry === true,
  });

  process.stdout.write(`update: bringing manifests to ${newSha.slice(0, 8)}${args.dry ? " (dry run)" : ""}\n`);

  let needsWork = 0;
  let free = 0;
  for (const r of reports) {
    // `notRefreshed`, not `skipped`. An earlier version used one name for both "this
    // flow was not refreshed, here is why" and "this many steps had nothing to
    // check", so a real report with skipped steps was mistaken for a skip reason and
    // the whole thing was swallowed — the anchor advanced and the run said nothing.
    if (r.notRefreshed) {
      process.stdout.write(`  ${r.flowId}: ${r.notRefreshed}\n`);
      continue;
    }
    free += r.unchanged + r.restamped;
    needsWork += r.stale.length + r.invalidated.length;
    const bits = [
      `${r.unchanged} unchanged`,
      `${r.restamped} rebased`,
      ...(r.skipped ? [`${r.skipped} nothing to check`] : []),
      ...(r.stale.length ? [`${r.stale.length} STALE`] : []),
      ...(r.invalidated.length ? [`${r.invalidated.length} INVALIDATED`] : []),
    ];
    process.stdout.write(`  ${r.flowId}: ${bits.join(", ")}${r.advanced ? " — anchor advanced" : ""}\n`);
    if (r.stale.length) process.stdout.write(`      re-narrate: ${r.stale.join(", ")}\n`);
    if (r.invalidated.length) process.stdout.write(`      gone: ${r.invalidated.join(", ")}\n`);
    for (const [id, to] of Object.entries(r.renames ?? {})) {
      process.stdout.write(`      ${id} moved to ${to}\n`);
    }
  }

  if (findings?.touched.length) {
    process.stdout.write(
      `  findings: ${findings.touched.length} of ${findings.total} had their span touched and were reopened\n`
    );
  }

  // The headline number, because it is the one that says whether the tool is paying
  // for itself: steps carried forward for nothing versus steps a model must revisit.
  process.stdout.write(`\n${free} step(s) carried forward with no model call, ${needsWork} need attention.\n`);
  if (needsWork) {
    process.stdout.write("Run the skill in update mode, or press Update in the viewer, to narrate those.\n");
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`update failed: ${err.message}\n`);
    process.exit(1);
  });
}

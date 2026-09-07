#!/usr/bin/env node
// Materialise a flow manifest from a flow SPEC.
//
// This is the tool that makes rule 1 structural rather than aspirational. A spec
// carries coordinates and prose only:
//
//   { flowId, title, source, provenance?, summary?, detailLevel?,
//     states: [ { id, label, description?, steps: [
//       { id, title, description, kind, collapsed?, note?, asciiSample?,
//         next?, file?, startLine?, endLine?, highlights? } ] } ] }
//
// There is no field in which a spec can put code text. The samples are produced
// here by reading `git show <sha>:<path>` and hashing exactly what was read, so
// the only way to get code into a manifest is for the code to be in the repo.
//
// Usage:
//   node scripts/build-flow.mjs --repo <path> --spec <spec.json> [--sha <sha>] [--dry]
//   node scripts/build-flow.mjs --repo <path> --commit <sha> [--title "..."] [--max-hunks 12]
//   node scripts/build-flow.mjs --repo <path> --from-run <runId> [--test <key>] [--dry]
//
// The --commit form needs no spec at all: a commit walkthrough's spine IS the
// diff, so it is generated whole and only the narration is left to add.
//
// The --from-run form is the other half of the runtime-first rule: it reads the
// captures of a real test run and writes one un-narrated spec per test into
// `viewer/specs/`, with the order of what actually executed frozen into the spec.
// Narrate that file, then feed it back through --spec, and the build refuses the
// result if it does not still match the run.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as captures from "../lib/captures.mjs";
import * as git from "../lib/git.mjs";
import * as store from "../lib/store.mjs";
import { commitDiffSamples, spanSample } from "../lib/samples.mjs";
import { validateFlow } from "../lib/manifest.mjs";
import { checkSpine, specFromCapture } from "../lib/spine.mjs";
import { inferLang } from "../lib/extract.mjs";

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

/** Build a manifest from a spec, extracting every sample mechanically. */
export async function buildFromSpec(repo, spec, { sha } = {}) {
  const anchor = sha ?? (await git.headSha(repo));
  const meta = await git.commitMeta(repo, anchor);

  const states = [];
  for (const specState of spec.states ?? []) {
    const steps = [];
    for (const specStep of specState.steps ?? []) {
      if (typeof specStep.code === "string" || typeof specStep.sampleText === "string") {
        // The one hard failure of this tool: a spec trying to supply code.
        throw new Error(
          `step "${specStep.id}" carries literal code. Specs carry coordinates and prose only — ` +
            "samples are extracted from the repository, never typed."
        );
      }

      const step = {
        id: specStep.id,
        title: specStep.title,
        kind: specStep.kind ?? "code",
        description: specStep.description ?? "",
      };
      if (specStep.collapsed !== undefined) step.collapsed = specStep.collapsed;
      if (specStep.note) step.note = specStep.note;
      if (specStep.asciiSample) step.asciiSample = specStep.asciiSample;
      if (specStep.next) step.next = specStep.next;

      if (specStep.file) {
        step.sample = await spanSample(repo, {
          sha: anchor,
          file: specStep.file,
          startLine: Number(specStep.startLine),
          endLine: Number(specStep.endLine),
          highlights: specStep.highlights ?? [],
          lang: specStep.lang ?? inferLang(specStep.file),
        });
      }
      step.staleness = { status: "fresh", checkedAtSha: anchor, checkedAt: new Date().toISOString() };
      steps.push(step);
    }
    states.push({
      id: specState.id,
      label: specState.label,
      ...(specState.description ? { description: specState.description } : {}),
      steps,
    });
  }

  const flow = {
    schemaVersion: 1,
    flowId: spec.flowId,
    title: spec.title,
    ...(spec.summary ? { summary: spec.summary } : {}),
    source: spec.source,
    ...(spec.provenance ? { provenance: spec.provenance } : {}),
    // No `dirty` flag here, deliberately. `dirty` means "these samples were read
    // from the working tree instead of a commit", and every sample this tool
    // produces comes from `git show <sha>:<path>`. Setting it from the repo's
    // overall `git status` — as an earlier version did — put an "uncommitted"
    // badge on flows whose samples were provably from a commit, which is exactly
    // the kind of small lie that costs a trust-based tool its credibility.
    anchoredAt: { sha: anchor, shortSha: meta.shortSha, committedAt: meta.committedAt },
    ...(spec.tags ? { tags: spec.tags } : {}),
    ...(spec.detailLevel ? { detailLevel: spec.detailLevel } : {}),
    states,
    generatedAt: new Date().toISOString(),
  };

  // A spec taken from a real run carries the frozen spine, and the manifest is
  // checked against it. This is what stops narration from quietly editing history:
  // folding a trivial step into a one-liner is encouraged, losing one is not.
  if (Array.isArray(spec.spine) && spec.spine.length) {
    const { ok, errors } = checkSpine(flow, spec.spine);
    if (!ok) {
      throw new Error(
        `this manifest does not match the run it claims to describe:\n  ${errors.join("\n  ")}`
      );
    }
  }

  const { ok, errors } = validateFlow(flow);
  if (!ok) throw new Error(`built an invalid manifest:\n  ${errors.join("\n  ")}`);
  return flow;
}

/**
 * Turn the captures of one run into un-narrated specs.
 *
 * Mechanical end to end: no prose is written and no span is chosen, so nothing here
 * can be wrong about the code. What it produces is a skeleton with the order locked.
 */
export async function specsFromRun(repo, runId, { only = null } = {}) {
  const keys = await captures.listCaptures(repo, runId);
  if (!keys.length) throw new Error(`run ${runId} holds no captures`);

  const out = [];
  for (const key of keys) {
    if (only && key !== only) continue;
    const capture = await captures.readCapture(repo, runId, key);
    if (!capture) continue;
    const spec = specFromCapture(capture, { captureRef: captures.captureRef(repo, runId, key) });
    out.push({ key, spec });
  }
  if (!out.length) throw new Error(`no capture in run ${runId} matched${only ? ` "${only}"` : ""}`);
  return out;
}

/**
 * Generate a commit walkthrough whole. Entirely mechanical: one step per hunk in
 * the order git emits them, grouped into one state per file. The narration is
 * left empty on purpose — a later `walkthrough` run fills it in, and an empty
 * description is visibly incomplete rather than quietly fabricated.
 */
export async function buildFromCommit(repo, sha, { title, maxHunks = 40 } = {}) {
  const full = await git.resolveSha(repo, sha);
  const meta = await git.commitMeta(repo, full);
  const samples = await commitDiffSamples(repo, full);
  if (!samples.length) throw new Error(`commit ${meta.shortSha} has no textual hunks to walk through`);

  const byFile = new Map();
  for (const s of samples.slice(0, maxHunks)) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }

  // Hunks beyond the first few in a file ship folded. Five hunks of a real commit
  // is already more scrolling than anyone reads, and folding is not omitting —
  // the content stays in the document, one click away. The first hunks carry the
  // gist; the tail is there for whoever needs it.
  const OPEN_PER_FILE = 3;

  let n = 0;
  const states = [];
  for (const [file, hunks] of byFile) {
    n += 1;
    states.push({
      id: `f${n}`,
      label: path.basename(file),
      description: `Changes this commit made to \`${file}\`.`,
      steps: hunks.map((h, i) => ({
        id: `f${n}h${i + 1}`,
        title: h.hunkHeader
          ? `${path.basename(file)} ${h.hunkHeader.replace(/^@@ | @@.*$/g, "")}`
          : `${path.basename(file)} (${h.status})`,
        kind: "code",
        description: "",
        ...(i >= OPEN_PER_FILE ? { collapsed: true } : {}),
        diffSample: h,
        staleness: { status: "fresh", checkedAtSha: full, checkedAt: new Date().toISOString() },
      })),
    });
  }

  const flow = {
    schemaVersion: 1,
    flowId: `commit-${meta.shortSha}`,
    title: title ?? `Commit: ${meta.subject}`,
    summary: meta.body ? meta.body.split("\n")[0] : `What ${meta.shortSha} changed, hunk by hunk.`,
    source: "commit",
    provenance: { commitSha: full },
    anchoredAt: { sha: full, shortSha: meta.shortSha, committedAt: meta.committedAt },
    states,
    generatedAt: new Date().toISOString(),
  };

  const { ok, errors } = validateFlow(flow);
  if (!ok) throw new Error(`built an invalid commit manifest:\n  ${errors.join("\n  ")}`);
  return { flow, totalHunks: samples.length, included: Math.min(samples.length, maxHunks) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(args.repo ?? process.cwd());

  if (!(await git.isGitRepo(repo))) {
    throw new Error(`${repo} is not a git repository`);
  }

  if (args.commit) {
    const { flow, totalHunks, included } = await buildFromCommit(repo, args.commit, {
      title: typeof args.title === "string" ? args.title : undefined,
      maxHunks: args["max-hunks"] ? Number(args["max-hunks"]) : 40,
    });
    if (included < totalHunks) {
      // Never truncate silently: a walkthrough that dropped hunks without saying
      // so reads as complete when it is not.
      process.stderr.write(
        `note: ${totalHunks} hunks in this commit, ${included} included by --max-hunks. ` +
          "Raise it or split the walkthrough.\n"
      );
    }
    if (args.dry) {
      process.stdout.write(`${JSON.stringify(flow, null, 2)}\n`);
      return;
    }
    const file = await store.saveFlow(repo, flow);
    process.stdout.write(`wrote ${path.relative(repo, file)} (${included} hunks across ${flow.states.length} states)\n`);
    return;
  }

  if (args["from-run"]) {
    const built = await specsFromRun(repo, String(args["from-run"]), {
      only: typeof args.test === "string" ? args.test : null,
    });
    for (const { key, spec } of built) {
      const steps = spec.states.reduce((n, s) => n + s.steps.length, 0);
      const unresolved = spec.states.reduce(
        (n, s) => n + s.steps.filter((t) => t.kind === "glue").length,
        0
      );
      if (args.dry) {
        process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
        continue;
      }
      const file = await store.saveSpec(repo, spec);
      process.stdout.write(
        `wrote ${path.relative(repo, file)} — ${spec.states.length} pages, ${steps} steps` +
          (unresolved ? `, ${unresolved} with no file resolved` : "") +
          ` (run ${spec.runStatus}, from ${key})\n`
      );
    }
    if (!args.dry) {
      process.stdout.write(
        "\nThese are skeletons: every description is empty and no code has been chosen yet.\n" +
          "Narrate them, add file/startLine/endLine per step, then build with --spec.\n"
      );
    }
    return;
  }

  if (!args.spec) {
    throw new Error("pass --spec <file.json>, --commit <sha>, or --from-run <runId>");
  }
  const spec = JSON.parse(await readFile(path.resolve(args.spec), "utf8"));
  const flow = await buildFromSpec(repo, spec, { sha: typeof args.sha === "string" ? args.sha : undefined });
  if (args.dry) {
    process.stdout.write(`${JSON.stringify(flow, null, 2)}\n`);
    return;
  }
  const file = await store.saveFlow(repo, flow);
  const steps = flow.states.reduce((n, s) => n + s.steps.length, 0);
  process.stdout.write(
    `wrote ${path.relative(repo, file)} (${flow.states.length} states, ${steps} steps, anchored at ${flow.anchoredAt.shortSha})\n`
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`build-flow failed: ${err.message}\n`);
    process.exit(1);
  });
}

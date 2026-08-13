#!/usr/bin/env node
// Run a test and record what it actually did.
//
// The pipeline, all mechanical:
//   1. run the target spec under our Playwright reporter, which writes raw
//      ordered actions per test
//   2. stitch each action to the URL it happened on (a `goto` sets the URL; the
//      actions after it inherit it)
//   3. resolve each URL to the file that served it, deterministically
//   4. walk that file's imports two levels deep for the candidate set
//   5. write one capture JSON per test, outside the repo
//
// Nothing here asks a model anything. The model's job starts after this, choosing
// which candidate explains each step and writing the prose.
//
// Usage:
//   node scripts/capture-runtime.mjs --repo <path> [--spec tests/e2e/x.spec.ts]
//                                    [--grep "test title"] [--project desktop-chromium]
//                                    [--workers 1] [--run-id <id>] [--dry]
//
// Pass --project when the target repo defines several viewport projects, or the same
// flow is captured once per viewport for no gain.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as git from "../lib/git.mjs";
import { importCandidates, rankCandidates } from "../lib/import-graph.mjs";
import { resolveThroughRedirects } from "../lib/route-resolve.mjs";
import { isNavigationAction } from "../lib/spine.mjs";
import {
  actionEvent,
  buildCapture,
  candidatesEvent,
  rawDir,
  routeEvent,
  runDir,
  writeCapture,
} from "../lib/captures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTER = path.resolve(HERE, "..", "runtime", "pv-reporter.mjs");

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

/** Every file under the app dir, repo-relative, forward-slashed. */
export async function listAppFiles(repo, appDir = "src/app") {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(path.join(repo, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else out.push(rel);
    }
  }
  await walk(appDir);
  return out;
}

/**
 * Give every action the URL it happened on.
 *
 * A `goto` establishes the URL; the actions after it inherit it until the next
 * navigation. This is the one piece of stitching the reporter cannot do, because it
 * sees steps one at a time.
 */
export function stitchUrls(actions) {
  let current = null;
  return (actions ?? []).map((a) => {
    if (a.url) current = stripOrigin(a.url);
    return { ...a, url: current };
  });
}

export function stripOrigin(url) {
  const s = String(url ?? "").replace(/^["']|["']$/g, "");
  const m = /^https?:\/\/[^/]+(\/.*)?$/.exec(s);
  if (m) return m[1] ?? "/";
  return s.startsWith("/") ? s : `/${s}`;
}

/** Turn one raw reporter record into an enriched capture. */
export async function enrich(repo, raw, { appFiles, sha, dirty, runId }) {
  const actions = stitchUrls(raw.actions);
  const events = [];
  let seq = 0;
  const readCache = new Map();

  const read = (file) => {
    if (readCache.has(file)) return readCache.get(file);
    let text = null;
    try {
      // Synchronous on purpose: the import walk is a tight inner loop over a few
      // dozen small files, and threading async reads through it would buy nothing
      // but make the pure module take a promise-returning reader.
      text = readFileSync(path.join(repo, file), "utf8");
    } catch {
      text = null;
    }
    readCache.set(file, text);
    return text;
  };

  // Resolve every distinct URL up front. Two reasons: the same page visited by ten
  // actions does not need ten identical lookups, and following redirects here means
  // the actions can be labelled with the URL the reader ACTUALLY ended up on rather
  // than the one the test asked for.
  const resolvedForUrl = new Map();
  for (const url of new Set(actions.map((a) => a.url).filter(Boolean))) {
    resolvedForUrl.set(url, resolveThroughRedirects(url, appFiles, { read }));
  }

  /** Where a requested URL really landed, when a redirect moved it. */
  const effectiveUrl = (url) => {
    const route = resolvedForUrl.get(url);
    const hops = route?.via ?? [];
    return hops.length ? hops[hops.length - 1].to : url;
  };

  for (const action of actions) {
    seq += 1;
    const actionSeq = seq;
    const effective = action.url ? effectiveUrl(action.url) : null;
    // `requestedUrl` belongs only to the action that actually navigated. The actions
    // after it INHERIT the page they are on, and stamping them with the requested URL
    // too made every click on a redirected page look like it had been redirected.
    const requested = isNavigationAction(action.action) ? action.url : null;
    events.push(actionEvent(actionSeq, { ...action, url: effective, requestedUrl: requested }));

    if (!action.url) continue;

    const route = resolvedForUrl.get(action.url);
    if (!route) continue;

    // Only emit the route + candidates the first time we reach a URL, so the
    // capture reads as a narrative rather than repeating itself.
    const alreadyEmitted = events.some((e) => e.type === "route" && e.file === route.file);
    if (alreadyEmitted) continue;

    seq += 1;
    events.push(routeEvent(seq, { forSeq: actionSeq, ...route }));

    const candidates = rankCandidates(importCandidates(route.file, { read, maxDepth: 2 }), {
      hintPath: action.url,
    });
    if (candidates.length) {
      seq += 1;
      events.push(
        candidatesEvent(seq, {
          forSeq: seq - 1,
          files: candidates.slice(0, 12).map((c) => ({
            file: c.file,
            via: `import:${c.depth}`,
            rank: c.score,
          })),
        })
      );
    }
  }

  return buildCapture({
    source: "e2e",
    runId,
    status: raw.status ?? "unknown",
    test: { file: raw.file, title: raw.title, project: raw.project },
    anchoredAt: { sha, dirty },
    events,
  });
}

async function runPlaywright(repo, { spec, grep, project, workers, rawOut }) {
  const args = ["playwright", "test"];
  if (spec) args.push(spec);
  if (grep) args.push("-g", grep);
  // Passed through, because a repo with three viewport projects otherwise captures
  // the same flow three times — and an earlier version accepted --project and then
  // silently dropped it, which is worse than not offering the flag at all.
  if (project) args.push(`--project=${project}`);
  if (workers) args.push(`--workers=${workers}`);
  args.push(`--reporter=${REPORTER.split(path.sep).join("/")}`);

  return new Promise((resolve) => {
    const child = execFile(
      "npx",
      args,
      {
        cwd: repo,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PV_CAPTURE_RAW_DIR: rawOut },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        // A failing test still produces a usable capture — what it did is what it
        // did. Report the exit state and carry on rather than aborting.
        resolve({ ok: !err, stdout, stderr: String(stderr ?? "") });
      }
    );
    child.stdout?.on("data", (d) => process.stdout.write(d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(args.repo ?? process.cwd());

  if (!(await git.isGitRepo(repo))) throw new Error(`${repo} is not a git repository`);
  const sha = await git.headSha(repo);
  const dirty = await git.isDirty(repo);
  const runId =
    typeof args["run-id"] === "string"
      ? args["run-id"]
      : new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");

  const appFiles = await listAppFiles(repo);
  if (!appFiles.length) {
    process.stderr.write(
      "capture-runtime: no files under src/app — route resolution will find nothing. " +
        "This tool assumes a Next app-router project.\n"
    );
  }

  const rawOut = rawDir(repo, runId);
  await mkdir(rawOut, { recursive: true });

  process.stdout.write(`capture-runtime: run ${runId}, anchored at ${sha.slice(0, 8)}\n`);
  const result = await runPlaywright(repo, {
    spec: typeof args.spec === "string" ? args.spec : null,
    grep: typeof args.grep === "string" ? args.grep : null,
    project: typeof args.project === "string" ? args.project : null,
    workers: typeof args.workers === "string" ? args.workers : null,
    rawOut,
  });
  if (!result.ok) {
    process.stdout.write("capture-runtime: the run reported failures; capturing what happened anyway\n");
  }

  let names;
  try {
    names = (await readdir(rawOut)).filter((n) => n.endsWith(".json"));
  } catch {
    names = [];
  }
  if (!names.length) {
    throw new Error(
      "no raw records were written. Either no test matched, or the reporter did not load — " +
        "check that Playwright accepted --reporter with an absolute path."
    );
  }

  const raws = [];
  for (const name of names) {
    raws.push({ key: name.slice(0, -5), raw: JSON.parse(await readFile(path.join(rawOut, name), "utf8")) });
  }

  // A capture with no actions is a bug, not a result. Writing it would poison every
  // flow narrated from it, so the run stops here and says what it suspects. The two
  // real causes are a browser that never launched and a step-title format the
  // reporter no longer recognises, and the evidence for both is to hand.
  const totalActions = raws.reduce((n, r) => n + (r.raw.actions?.length ?? 0), 0);
  if (totalActions === 0) {
    const unmatched = [...new Set(raws.flatMap((r) => r.raw.unmatched ?? []))];
    const errors = [...new Set(raws.flatMap((r) => r.raw.errors ?? []))].slice(0, 2);
    const lines = [
      `captured ${raws.length} test(s) but recorded ZERO actions, so there is no spine to narrate.`,
      "",
      "Likely causes, most common first:",
      "  1. Playwright browsers are not installed — run `npx playwright install chromium`.",
      "     A test that cannot launch a browser performs no actions.",
      "  2. The step-title format changed and runtime/pv-reporter.mjs no longer matches it.",
    ];
    if (errors.length) {
      lines.push("", "First test error(s):");
      for (const e of errors) lines.push(`  ${e.split("\n")[0].slice(0, 160)}`);
    }
    if (unmatched.length) {
      lines.push("", "Unrecognised pw:api step titles (evidence for cause 2):");
      for (const u of unmatched.slice(0, 8)) lines.push(`  ${u}`);
    } else {
      lines.push("", "No unrecognised step titles were seen, which points at cause 1.");
    }
    lines.push("", `Raw records kept for inspection: ${rawOut}`);
    throw new Error(lines.join("\n"));
  }

  const written = [];
  for (const { key, raw } of raws) {
    const capture = await enrich(repo, raw, { appFiles, sha, dirty, runId });
    if (args.dry) {
      process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
      continue;
    }
    written.push(await writeCapture(repo, runId, key, capture));
    const actions = capture.events.filter((e) => e.type === "action").length;
    const routes = capture.events.filter((e) => e.type === "route").length;
    const unmapped = (raw.actions ?? []).filter((a) => a.url).length && routes === 0;
    process.stdout.write(
      `  ${key}: ${actions} actions, ${routes} routes resolved` +
        (unmapped ? "  (no route resolved — check the app dir)" : "") +
        "\n"
    );
  }

  if (!args.dry) {
    await rm(rawOut, { recursive: true, force: true });
    process.stdout.write(`capture-runtime: wrote ${written.length} capture(s) to ${runDir(repo, runId)}\n`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`capture-runtime failed: ${err.message}\n`);
    process.exit(1);
  });
}

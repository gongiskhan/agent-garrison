#!/usr/bin/env node
// Turn a drillbook into captures, so hand-authored pages get a spine too.
//
// The drillbook is the one source where a human already wrote down what matters. This
// script does not execute anything: it reads the book, resolves each declared page
// path to the file that serves it, and records the author's own words as the intent
// for that page. The result is the same capture shape an e2e run produces, so
// `build-flow.mjs --from-run` and everything after it are indifferent to which source
// the spine came from.
//
// Thinner than an e2e capture, and honestly so: a drillbook step is a judgement about
// a page, not a sequence of clicks. One navigation per page state is all it can claim.
//
// Usage:
//   node scripts/capture-drillbook.mjs --repo <path> [--page <id>] [--run-id <id>] [--dry]

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as captures from "../lib/captures.mjs";
import * as git from "../lib/git.mjs";
import { navigationsFor, readDrillbook } from "../lib/drillbook.mjs";
import { importCandidates, rankCandidates } from "../lib/import-graph.mjs";
import { resolveThroughRedirects } from "../lib/route-resolve.mjs";
import { listAppFiles } from "./capture-runtime.mjs";

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

/** Strip an absolute app URL down to a path, since the book stores full URLs. */
export function pathOf(url) {
  const s = String(url ?? "").trim();
  const m = /^https?:\/\/[^/]+(\/.*)?$/.exec(s);
  if (m) return m[1] ?? "/";
  return s.startsWith("/") ? s : `/${s}`;
}

/** One capture per drillbook page. Pure apart from the injected `read`. */
export function captureForPage(page, { appFiles, read, sha, dirty, runId }) {
  const events = [];
  let seq = 0;

  for (const nav of navigationsFor(page)) {
    const url = pathOf(nav.url);
    seq += 1;
    const actionSeq = seq;
    events.push(
      captures.actionEvent(actionSeq, {
        action: "goto",
        url,
        intent: nav.intent || null,
        state: { key: `${page.id}:${nav.stateId}`, label: nav.label },
      })
    );

    const route = resolveThroughRedirects(url, appFiles, { read });
    if (!route) continue;

    seq += 1;
    events.push(captures.routeEvent(seq, { forSeq: actionSeq, ...route }));

    const ranked = rankCandidates(importCandidates(route.file, { read, maxDepth: 2 }), { hintPath: url });
    if (ranked.length) {
      seq += 1;
      events.push(
        captures.candidatesEvent(seq, {
          forSeq: seq - 1,
          files: ranked.slice(0, 12).map((c) => ({ file: c.file, via: `import:${c.depth}`, rank: c.score })),
        })
      );
    }
  }

  return {
    ...captures.buildCapture({
      source: "drillbook",
      runId,
      // Nothing ran, so there is no pass or fail to report. Saying "passed" would be
      // a small lie about a script that never opened a browser.
      status: "not-executed",
      test: { file: page.sourceFile, title: page.title, project: null },
      anchoredAt: { sha, dirty },
      events,
    }),
    drillbook: {
      pageId: page.id,
      stepIds: page.steps.map((s) => s.id),
      ...(page.pathDisagreement ? { pathDisagreement: page.pathDisagreement } : {}),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(args.repo ?? process.cwd());
  if (!(await git.isGitRepo(repo))) throw new Error(`${repo} is not a git repository`);

  const read = async (file) => {
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  };

  const book = await readDrillbook(repo, { readFile: read });
  if (!book) throw new Error(`no drillbook at ${path.join(repo, "drills/drillbook.yml")}`);
  if (book.missingPages.length) {
    // The book naming a page file that is gone is a real discrepancy, so it is said
    // out loud rather than quietly skipped.
    process.stderr.write(
      `note: the drillbook names ${book.missingPages.length} page file(s) that do not exist: ` +
        `${book.missingPages.join(", ")}\n`
    );
  }

  const sha = await git.headSha(repo);
  const dirty = await git.isDirty(repo);
  const runId = typeof args["run-id"] === "string" ? args["run-id"] : `drillbook-${sha.slice(0, 8)}`;
  const appFiles = await listAppFiles(repo);

  // Synchronous, because the import walk and the redirect resolver are pure modules
  // that take a plain reader; making them promise-aware would buy nothing.
  const syncRead = (() => {
    const cache = new Map();
    return (file) => {
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
  })();

  const pages = args.page ? book.pages.filter((p) => p.id === args.page) : book.pages;
  if (!pages.length) throw new Error(args.page ? `no selected page "${args.page}"` : "the drillbook selects no pages");

  let written = 0;
  let unresolved = 0;
  for (const page of pages) {
    const capture = captureForPage(page, { appFiles, read: syncRead, sha, dirty, runId });
    const routes = capture.events.filter((e) => e.type === "route").length;
    const navs = capture.events.filter((e) => e.type === "action").length;
    unresolved += navs - routes;

    if (args.dry) {
      process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
      continue;
    }
    await captures.writeCapture(repo, runId, captures.testKey(capture.test), capture);
    written += 1;
    process.stdout.write(
      `  ${page.id}: ${navs} page state(s), ${routes} resolved` +
        (page.pathDisagreement ? `  (page file says ${page.pathDisagreement}, book says ${page.path})` : "") +
        "\n"
    );
  }

  if (!args.dry) {
    process.stdout.write(`capture-drillbook: wrote ${written} capture(s) to run ${runId}\n`);
    if (unresolved) {
      process.stdout.write(
        `  ${unresolved} page state(s) resolved to no file — those steps arrive as glue, not as invented code\n`
      );
    }
    if (book.globalRules) {
      process.stdout.write(`\nThe book's standing rules, which belong in front of the narrator:\n  ${book.globalRules.replace(/\s+/g, " ")}\n`);
    }
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`capture-drillbook failed: ${err.message}\n`);
    process.exit(1);
  });
}

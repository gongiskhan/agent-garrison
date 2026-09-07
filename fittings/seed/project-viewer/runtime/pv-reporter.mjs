// A Playwright reporter that records what each test actually did, in order.
//
// WHY A REPORTER, and not the trace file. The obvious route is to run with
// `--trace on` and parse the resulting zip. That zip's internals are an
// implementation detail of Playwright with no compatibility promise, so a parser
// for it fails on a version bump — and the failure mode is the bad one: it still
// produces *a* spine, just a wrong one. The reporter API is public and versioned.
// If it changes, we get a load error, which is a failure you can see.
//
// WHY NOT A FIXTURE. A fixture could also record network requests, which would
// sharpen route resolution. But a fixture has to be imported by every test file,
// which means editing the target repo's tests to analyse them. Not worth it: the
// reporter already gives ordered actions with their selectors and the URL each one
// happened on, and that is enough to resolve routes. Network-level precision is a
// later refinement, and it is recorded as such rather than pretended away.
//
// This file runs inside Playwright's process, so it stays dumb on purpose: it
// writes raw records and does no resolving. Enrichment happens in
// scripts/capture-runtime.mjs, where it can be tested.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Parsing step TITLES, and why that is the weak joint.
//
// The reporter API is public and versioned, but the human-readable WORDING of a
// step title is not a contract. Playwright ≤1.4x titled steps `page.goto(url)`;
// 1.6x titles them `Navigate to "url"` and `Click`. The step object carries no
// structured params in 1.60 — checked, not assumed — so the title is all there is.
//
// A rewording would therefore match nothing and produce an empty spine, silently:
// exactly the failure mode this whole design exists to avoid. It cannot be made
// stable, so it is made LOUD. Unmatched `pw:api` titles are recorded in
// `unmatched`, and the driver refuses to write a capture with zero actions, naming
// parser drift as a likely cause and showing what it saw. A wrong spine is
// unacceptable; a run that stops and says the parser has drifted is fine.
//
// `location` is recorded alongside and it IS structural: it points at the line of
// the spec that caused the action, anchoring the step to real source whatever the
// title says.

/** Actions worth recording. Assertions and internal plumbing are noise. */
const INTERESTING = new Set([
  "goto",
  "click",
  "dblclick",
  "fill",
  "press",
  "check",
  "uncheck",
  "selectOption",
  "setInputFiles",
  "hover",
  "tap",
  "waitForURL",
]);

/** Modern (1.6x) human-readable titles → the action name we store. */
const MODERN = [
  [/^Navigate to\b/i, "goto"],
  [/^Double click\b/i, "dblclick"],
  [/^Click\b/i, "click"],
  [/^Fill\b/i, "fill"],
  [/^Type\b/i, "fill"],
  [/^Press\b/i, "press"],
  [/^Uncheck\b/i, "uncheck"],
  [/^Check\b/i, "check"],
  [/^Select option/i, "selectOption"],
  [/^Set input files/i, "setInputFiles"],
  [/^Hover\b/i, "hover"],
  [/^Tap\b/i, "tap"],
  [/^Wait for (?:url|navigation)/i, "waitForURL"],
];

export function actionOf(title) {
  const s = String(title ?? "").trim();

  // Legacy form: `page.goto(...)`, `locator.click(...)`.
  const legacy = /^(?:page|locator|frame|frameLocator)\.([A-Za-z]+)/.exec(s);
  if (legacy && INTERESTING.has(legacy[1])) return legacy[1];

  for (const [re, action] of MODERN) {
    if (re.test(s)) return action;
  }
  return null;
}

/**
 * Whatever argument a title carries — a URL, a selector — when it carries one.
 * Modern titles for locator actions often carry nothing, which is precisely why
 * `location` matters more than this does.
 */
export function argOf(title) {
  const s = String(title ?? "").trim();
  const quoted = /"([^"]+)"|'([^']+)'/.exec(s);
  if (quoted) return quoted[1] ?? quoted[2];
  const parens = /\(([^)]*)\)\s*$/.exec(s);
  if (parens && parens[1].trim()) return parens[1].trim();
  const tail = /^(?:[A-Z][a-z]+(?:\s+[a-z]+)*)\s+(\S.*)$/.exec(s);
  return tail ? tail[1].trim() : null;
}

/**
 * Duplicated in lib/spine.mjs on purpose. This file runs inside Playwright's own
 * process and must not import the fitting's libs — a broken import here takes the
 * whole test run down. One predicate copied is cheaper than that failure mode.
 */
export function isNavigation(action) {
  return action === "goto" || action === "waitForURL";
}

export default class ProjectViewerReporter {
  constructor(options = {}) {
    // Where to write. The driver passes this; the default keeps the reporter
    // usable by hand without guessing an env var.
    this.outputDir = options.outputDir ?? process.env.PV_CAPTURE_RAW_DIR ?? ".pv-capture";
    this.records = new Map();
  }

  onBegin() {
    mkdirSync(this.outputDir, { recursive: true });
  }

  onTestBegin(test) {
    this.records.set(test.id, {
      file: this.#relFile(test),
      title: test.title,
      titlePath: test.titlePath().slice(1),
      project: this.#projectOf(test),
      actions: [],
      // Every pw:api title this parser did not recognise. The driver reports these
      // when a capture came out empty, so parser drift is diagnosable rather than
      // mysterious.
      unmatched: [],
      startedAt: Date.now(),
    });
  }

  onStepEnd(test, _result, step) {
    const record = this.records.get(test.id);
    if (!record) return;
    if (step.category !== "pw:api") return;

    const action = actionOf(step.title);
    if (!action) {
      const title = String(step.title ?? "").slice(0, 120);
      // "Launch browser" and friends are infrastructure, not user actions; keeping
      // them out of `unmatched` stops the diagnostic from being all noise.
      if (!/^(?:Launch browser|Create context|Create page|Close context)/i.test(title)) {
        if (!record.unmatched.includes(title)) record.unmatched.push(title);
      }
      return;
    }

    const arg = argOf(step.title);
    record.actions.push({
      action,
      selector: isNavigation(action) ? null : arg,
      title: step.title,
      // Relative to test start, so a reader sees the shape of the run without
      // caring what wall clock it happened at.
      atMs: Math.max(0, step.startTime.getTime() - record.startedAt),
      durationMs: step.duration,
      ok: !step.error,
      // A navigation carries its URL in the title; other actions inherit whatever
      // the last navigation established, which the driver stitches together.
      url: isNavigation(action) ? arg : null,
      // Structural, unlike the title: the spec line that caused this action.
      at: step.location
        ? { file: this.#rel(step.location.file), line: step.location.line, column: step.location.column }
        : null,
    });
  }

  onTestEnd(test, result) {
    const record = this.records.get(test.id);
    if (!record) return;
    record.status = result.status;
    record.durationMs = result.duration;
    record.errors = (result.errors ?? []).map((e) => String(e.message ?? e).slice(0, 400));

    const key = [record.file, record.title, record.project]
      .map((s) =>
        String(s ?? "")
          .replace(/[^A-Za-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 70)
      )
      .filter(Boolean)
      .join("--");

    try {
      writeFileSync(
        path.join(this.outputDir, `${key}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8"
      );
    } catch (err) {
      // A reporter that throws takes the whole run down with it, which would be a
      // worse outcome than a missing capture. Say so and carry on.
      process.stderr.write(`project-viewer reporter: could not write ${key}: ${err.message}\n`);
    }
  }

  onEnd(result) {
    process.stdout.write(
      `project-viewer: captured ${this.records.size} test(s) into ${this.outputDir} (run ${result.status})\n`
    );
  }

  /** Reporters get absolute paths; manifests only ever carry repo-relative ones. */
  #relFile(test) {
    return this.#rel(test.location?.file ?? "");
  }

  #rel(abs) {
    const root = process.cwd();
    const rel = String(abs ?? "").startsWith(root) ? String(abs).slice(root.length + 1) : String(abs ?? "");
    return rel.split(path.sep).join("/");
  }

  #projectOf(test) {
    let node = test.parent;
    while (node) {
      if (node.project?.()) return node.project().name;
      node = node.parent;
    }
    return null;
  }
}

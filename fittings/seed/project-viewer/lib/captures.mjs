// Where runtime captures live, and what shape they have.
//
// A capture is the ordered record of what one test actually did: the actions it
// performed, the URL it was on, and the files those actions plausibly ran through.
// It is the spine a flow is narrated from — the answer to "what executed", as
// opposed to "what the model thinks executes".
//
// Captures are run-scoped, so they live OUTSIDE the repo, per the rule that nothing
// run-scoped belongs in a project's tree. A manifest keeps only an opaque
// `captureRef` pointing back here, so the audit trail survives without the repo
// carrying megabytes of run output.
//
// One shape serves both sources. A capture from an e2e test and a capture from
// driving the live UI by vision are structurally identical, differing only in
// `source`. That is deliberate: everything downstream — route resolution, candidate
// ranking, narration — must not care how the spine was obtained, or the vision
// fallback would need a second pipeline nobody maintains.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { capturesDir, projectKey } from "./store.mjs";

export const CAPTURE_SCHEMA_VERSION = 1;

/**
 * A stable, filesystem-safe key for one test.
 * Same construction as the drill fitting's evidence keys, so the two stores read
 * the same way when someone is comparing them.
 */
export function testKey({ file, title, project }) {
  const clean = (s) =>
    String(s ?? "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70);
  return [clean(file), clean(title), clean(project)].filter(Boolean).join("--");
}

export function runDir(repo, runId, env = process.env) {
  return path.join(capturesDir(repo, env), runId);
}

export function capturePath(repo, runId, key, env = process.env) {
  return path.join(runDir(repo, runId, env), `${key}.json`);
}

/** The raw directory the Playwright reporter writes into, before enrichment. */
export function rawDir(repo, runId, env = process.env) {
  return path.join(runDir(repo, runId, env), "raw");
}

/**
 * Build a capture from a reporter record plus resolved routes and candidates.
 * Pure — the caller has already done the resolving, so this is just the shape.
 */
export function buildCapture({
  source = "e2e",
  test = {},
  anchoredAt = {},
  runId = null,
  events = [],
  status = "unknown",
}) {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    source,
    runId,
    status,
    test: { file: test.file ?? null, title: test.title ?? null, project: test.project ?? null },
    anchoredAt: { sha: anchoredAt.sha ?? null, dirty: anchoredAt.dirty === true },
    events,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * One ordered event. `type` is `action` (something the test did) or `route`
 * (a file the action resolved to) or `candidates` (files that route imports).
 * Keeping them as one ordered list rather than three parallel arrays is what makes
 * "in order" checkable at a glance.
 */
/**
 * `arg` rather than `selector`, because that is honestly what it is: for a click it
 * is the locator, but for a fill it is the VALUE that was typed. Calling it a
 * selector would have been a small lie that a reader only discovers by being
 * confused. `at` is the spec line that caused the action, when Playwright reports
 * one — it does not always.
 */
/**
 * `intent` and `state` are for hand-authored sources. A drillbook step comes with a
 * human's statement of what the page is for, which beats anything this tool derives,
 * and a page may declare several states that live at the SAME path — so grouping by
 * URL alone would collapse them into one. Both stay optional: an e2e capture has
 * neither and must not be made to carry empty fields.
 */
export function actionEvent(
  seq,
  {
    action,
    arg = null,
    selector = null,
    url = null,
    requestedUrl = null,
    atMs = null,
    ok = true,
    at = null,
    intent = null,
    state = null,
  }
) {
  return {
    seq,
    type: "action",
    action,
    arg: arg ?? selector,
    // `url` is where the reader actually WAS. When a server-side redirect moved
    // them, `requestedUrl` keeps what the test asked for — the earlier version
    // reported only the requested URL, which read as though the interaction had
    // happened on a page it never touched.
    url,
    ...(requestedUrl && requestedUrl !== url ? { requestedUrl } : {}),
    atMs,
    ok,
    at,
    ...(intent ? { intent } : {}),
    ...(state ? { state } : {}),
  };
}

/**
 * `via` records any redirect stubs passed through on the way here, and `redirects`
 * marks a redirect whose target could not be derived. Both are kept because hiding
 * a hop would make the spine read as if the reader arrived directly.
 */
export function routeEvent(seq, { forSeq, file, kind, params = null, layouts = [], via = [], redirects = null }) {
  return {
    seq,
    type: "route",
    forSeq,
    file,
    kind,
    params,
    layouts,
    ...(via.length ? { via } : {}),
    ...(redirects ? { redirects } : {}),
  };
}

export function candidatesEvent(seq, { forSeq, files }) {
  return { seq, type: "candidates", forSeq, files };
}

export async function writeCapture(repo, runId, key, capture, env = process.env) {
  const file = capturePath(repo, runId, key, env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  return file;
}

export async function readCapture(repo, runId, key, env = process.env) {
  try {
    return JSON.parse(await readFile(capturePath(repo, runId, key, env), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function listRuns(repo, env = process.env) {
  try {
    const names = await readdir(capturesDir(repo, env));
    return names.sort().reverse();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function listCaptures(repo, runId, env = process.env) {
  try {
    const names = await readdir(runDir(repo, runId, env));
    return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** `captureRef` as stored in a manifest: enough to find the file, nothing more. */
export function captureRef(repo, runId, key) {
  return `${projectKey(repo)}/${runId}/${key}`;
}

/**
 * A flow with no capture is a finding, not an omission. This is the shape the
 * analysis files when it had to fall back to reading code.
 */
export function noCoverageFinding(flowId, { file = null } = {}) {
  return {
    id: `no-coverage-${flowId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
    flowId,
    severity: "info",
    category: "missing-test",
    text: "This flow has no end-to-end test, so its spine was not taken from execution.",
    suggestion:
      "Run the skill in generate-tests mode for this flow, or add a drillbook step, so the next analysis can anchor it to a real run.",
    status: "open",
    evidence: "static",
    ...(file ? { span: { file } } : {}),
  };
}

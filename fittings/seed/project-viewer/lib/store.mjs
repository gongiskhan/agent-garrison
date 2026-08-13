// The only module that knows where viewer data lives. Schema churn and layout
// changes land here.
//
// WHERE THINGS LIVE, and why:
//
//   <targetRepo>/viewer/            durable, diffable, PR-reviewable work products
//     viewer.json                     nav order + last refresh anchor
//     flows/<flowId>.json             one manifest per flow
//     specs/<flowId>.json             un-narrated skeleton from a runtime capture
//     findings.json                   ONE findings collection (status survives re-analysis)
//     intake.json                     intake answers (never credentials — only a reference)
//     docs-manifest.json              consolidated docs index
//     cleanup-allowlist.json          explicit deletion list, never a glob
//
//   ~/.garrison/project-viewer/     run-scoped, per GARRISON-UNIFY-V1 D19
//     captures/<projectKey>/<runId>/  playwright traces + ordered event JSON
//     cache/<projectKey>/             rendered HTML cache (derived, disposable)
//
// Manifests go in the repo for the same reason the drillbook does: a manifest and
// the commit it narrates must travel together through clone, branch and revert.
// Captures stay out because they are run-scoped and binary-ish. Rendered HTML is
// never committed — it is a pure function of manifest plus repo.
//
// Writes are atomic (temp + rename) and read back before being declared done,
// cloning the drill store discipline: a half-written manifest is worse than none.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SCHEMA_VERSION, validateFindings, validateFlow, validateViewerIndex } from "./manifest.mjs";

export const VIEWER_DIRNAME = "viewer";

export function viewerDir(root) {
  return path.join(root, VIEWER_DIRNAME);
}
export function flowsDir(root) {
  return path.join(viewerDir(root), "flows");
}
export function flowPath(root, flowId) {
  return path.join(flowsDir(root), `${flowId}.json`);
}
/**
 * Specs live in the repo, next to the manifests they become.
 *
 * A spec is a skeleton taken from a real run with the prose and the code spans
 * still missing. Narrating it costs real tokens and can span several sessions or
 * kanban cards, so it has to survive a session — and it is the artefact a human can
 * review BEFORE that money is spent. Once the manifest exists the spec is dead
 * weight, and the build says so rather than leaving it to rot.
 */
export function specsDir(root) {
  return path.join(viewerDir(root), "specs");
}
export function specPath(root, flowId) {
  return path.join(specsDir(root), `${flowId}.json`);
}
export function findingsPath(root) {
  return path.join(viewerDir(root), "findings.json");
}
export function indexPath(root) {
  return path.join(viewerDir(root), "viewer.json");
}
export function intakePath(root) {
  return path.join(viewerDir(root), "intake.json");
}
export function docsManifestPath(root) {
  return path.join(viewerDir(root), "docs-manifest.json");
}
export function cleanupAllowlistPath(root) {
  return path.join(viewerDir(root), "cleanup-allowlist.json");
}
/** Consolidated doc copies live in the repo, so they travel with it like manifests. */
export function docsCopyDir(root) {
  return path.join(viewerDir(root), "docs");
}

/** Machine-local store root. Honours GARRISON_PROJECTVIEWER_STORE, then GARRISON_HOME. */
export function storeRoot(env = process.env) {
  if (env.GARRISON_PROJECTVIEWER_STORE) return expandHome(env.GARRISON_PROJECTVIEWER_STORE);
  const home = env.GARRISON_HOME ? expandHome(env.GARRISON_HOME) : path.join(os.homedir(), ".garrison");
  return path.join(home, "project-viewer");
}

/**
 * Stable per-project key, so two checkouts of the same repo do not collide in
 * the machine-local store. Same construction as drill's evidence project key.
 */
export function projectKey(root) {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
}

export function capturesDir(root, env = process.env) {
  return path.join(storeRoot(env), "captures", projectKey(root));
}
export function cacheDir(root, env = process.env) {
  return path.join(storeRoot(env), "cache", projectKey(root));
}

function expandHome(p) {
  const s = String(p);
  return s.startsWith("~") ? path.join(os.homedir(), s.slice(1)) : s;
}

// ---------------------------------------------------------------- reads

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`${file}: ${err.message}`);
  }
}

export async function listFlowIds(root) {
  try {
    const names = await readdir(flowsDir(root));
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -5))
      .sort();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** Read one manifest, validated. Throws on invalid: a bad manifest must not render. */
export async function getFlow(root, flowId) {
  const file = flowPath(root, flowId);
  const obj = await readJson(file);
  if (obj === null) return null;
  const { ok, errors } = validateFlow(obj);
  if (!ok) throw new Error(`${file} is not a valid flow manifest:\n  ${errors.join("\n  ")}`);
  return obj;
}

/** Every manifest, in the order viewer.json declares (unknown ids appended). */
export async function listFlows(root) {
  const ids = await listFlowIds(root);
  const index = await getIndex(root);
  const ordered = [...index.flowOrder.filter((id) => ids.includes(id))];
  for (const id of ids) if (!ordered.includes(id)) ordered.push(id);

  const flows = [];
  for (const id of ordered) {
    try {
      const flow = await getFlow(root, id);
      if (flow) flows.push(flow);
    } catch (err) {
      // Surface the broken one rather than hiding the whole index behind it.
      flows.push({ flowId: id, title: id, broken: String(err.message), states: [] });
    }
  }
  return flows;
}

export async function getIndex(root) {
  const obj = await readJson(indexPath(root));
  if (obj === null) return { schemaVersion: SCHEMA_VERSION, project: null, flowOrder: [], lastRefresh: null };
  const { ok, errors } = validateViewerIndex(obj);
  if (!ok) throw new Error(`${indexPath(root)} is invalid:\n  ${errors.join("\n  ")}`);
  return { flowOrder: [], ...obj };
}

export async function getFindings(root) {
  const obj = await readJson(findingsPath(root));
  if (obj === null) return { schemaVersion: SCHEMA_VERSION, findings: [] };
  const { ok, errors } = validateFindings(obj);
  if (!ok) throw new Error(`${findingsPath(root)} is invalid:\n  ${errors.join("\n  ")}`);
  return obj;
}

export async function getIntake(root) {
  return readJson(intakePath(root));
}
export async function getDocsManifest(root) {
  return (await readJson(docsManifestPath(root))) ?? { schemaVersion: SCHEMA_VERSION, docs: [] };
}

// ---------------------------------------------------------------- writes

/**
 * Atomic JSON write: validate, write a temp file, rename over the target, read
 * it back and re-parse. The read-back is not paranoia theatre — a manifest that
 * fails to parse after a crashed write would poison every later run.
 */
async function writeJsonAtomic(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  const back = await readFile(file, "utf8");
  JSON.parse(back);
  return file;
}

export async function saveFlow(root, flow) {
  const { ok, errors } = validateFlow(flow);
  if (!ok) {
    throw new Error(`refusing to write an invalid flow manifest:\n  ${errors.join("\n  ")}`);
  }
  const file = await writeJsonAtomic(flowPath(root, flow.flowId), flow);
  await registerFlow(root, flow.flowId);
  return file;
}

/**
 * A derived report in the machine-local cache. Same atomic write as a manifest,
 * because a half-written report read by the server would render as a report.
 */
export async function writeReport(file, obj) {
  return writeJsonAtomic(file, obj);
}

/** A spec is not a manifest, so it is not flow-validated — only well-formed. */
export async function saveSpec(root, spec) {
  if (!spec?.flowId) throw new Error("a spec needs a flowId");
  return writeJsonAtomic(specPath(root, spec.flowId), spec);
}

export async function getSpec(root, flowId) {
  return readJson(specPath(root, flowId));
}

export async function listSpecIds(root) {
  try {
    const names = await readdir(specsDir(root));
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -5))
      .sort();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function saveFindings(root, obj) {
  const payload = { schemaVersion: SCHEMA_VERSION, ...obj };
  const { ok, errors } = validateFindings(payload);
  if (!ok) throw new Error(`refusing to write invalid findings:\n  ${errors.join("\n  ")}`);
  return writeJsonAtomic(findingsPath(root), payload);
}

export async function saveIndex(root, obj) {
  return writeJsonAtomic(indexPath(root), { schemaVersion: SCHEMA_VERSION, ...obj });
}

export async function saveIntake(root, obj) {
  return writeJsonAtomic(intakePath(root), { schemaVersion: SCHEMA_VERSION, ...obj });
}

export async function saveDocsManifest(root, obj) {
  return writeJsonAtomic(docsManifestPath(root), { schemaVersion: SCHEMA_VERSION, ...obj });
}

/** Append a flow id to viewer.json's order if it is not already there. */
export async function registerFlow(root, flowId) {
  const index = await getIndex(root);
  if (!index.flowOrder.includes(flowId)) {
    index.flowOrder.push(flowId);
    await saveIndex(root, index);
  }
  return index;
}

export async function recordRefresh(root, sha) {
  const index = await getIndex(root);
  index.lastRefresh = { sha, at: new Date().toISOString() };
  return saveIndex(root, index);
}

/**
 * Update one finding's triage status in place. Triage lives in the same
 * collection as the finding so there is no second file to drift: a dismissed
 * finding must not come back on the next analysis.
 */
export async function setFindingStatus(root, findingId, status) {
  const coll = await getFindings(root);
  const finding = coll.findings.find((f) => f.id === findingId);
  if (!finding) return null;
  finding.status = status;
  await saveFindings(root, coll);
  return finding;
}

export async function ensureViewerDir(root) {
  await mkdir(flowsDir(root), { recursive: true });
  return viewerDir(root);
}

/**
 * The only sanctioned way to consolidate a doc before cleanup can touch it.
 *
 * Copies the source file into viewer/docs/ and registers it in the docs
 * manifest with the sha256 of the exact bytes that were copied. That hash is
 * what scripts/cleanup.mjs later verifies against the file it is asked to
 * delete — so "this doc was already used to create something else" is a fact
 * the machine can check, not a claim in a prompt. A doc edited after
 * consolidation no longer matches its recorded hash and becomes undeletable
 * until it is consolidated again.
 *
 * `sourceRel` is repo-relative; the entry's `storedAt` is stored repo-relative
 * too, so the copy travels with the repo through clone, branch and revert.
 */
export async function consolidateDoc(root, sourceRel, { docId, title }) {
  if (!docId || !/^[a-z0-9][a-z0-9-]*$/.test(docId)) {
    throw new Error(`consolidateDoc: docId must be a lowercase slug, got ${JSON.stringify(docId)}`);
  }
  if (!title) throw new Error("consolidateDoc: a title is required");
  const rel = path.normalize(String(sourceRel));
  if (path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
    throw new Error(`consolidateDoc: source must be a repo-relative path inside the repo, got ${sourceRel}`);
  }
  const abs = path.join(root, rel);
  const bytes = await readFile(abs);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");

  const storedRel = path.join(VIEWER_DIRNAME, "docs", `${docId}${path.extname(rel) || ".md"}`);
  const storedAbs = path.join(root, storedRel);
  await mkdir(path.dirname(storedAbs), { recursive: true });
  const tmp = `${storedAbs}.tmp-${process.pid}`;
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, storedAbs);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  const back = await readFile(storedAbs);
  if (createHash("sha256").update(back).digest("hex") !== sourceSha256) {
    throw new Error(`consolidateDoc: read-back of ${storedRel} does not match what was written`);
  }

  const manifest = await getDocsManifest(root);
  const entry = {
    docId,
    title,
    source: rel.split(path.sep).join("/"),
    originalPath: rel.split(path.sep).join("/"),
    sourceSha256,
    storedAt: storedRel.split(path.sep).join("/"),
    consolidatedAt: new Date().toISOString(),
  };
  const docs = (manifest.docs ?? []).filter((d) => d.docId !== docId);
  docs.push(entry);
  await saveDocsManifest(root, { ...manifest, docs });
  return entry;
}

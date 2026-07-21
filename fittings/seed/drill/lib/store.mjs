// Drill Book store (A1/A2). Plans live in the TARGET APP repo, not
// ~/.garrison — diffable and PR-reviewable: drills/drillbook.yml (book-level:
// app config, page selection, global rules, autonomy, viewport matrix) plus
// drills/pages/<pageId>.yml (per-page plan: areas, steps, states). Same store
// conventions as automations/lib/store.mjs (A2: strict id sanitizing, YAML
// per entity) — atomic here (temp-write + rename + read-back verification),
// which automations' store is not (a gap this fitting does not inherit).

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { activeProjectRoot, canonicalRoot } from "./projects.mjs";

// The live UI selection (projects.mjs) wins over the boot-time env pin - the
// env is the default target, not a lock. Both arms are canonicalised so runs
// stamped from either source compare equal to a picker selection of the same
// repo.
export function drillTargetRoot() {
  return activeProjectRoot() || canonicalRoot(process.env.GARRISON_DRILL_TARGET_REPO || process.cwd());
}

// Every store function takes an optional trailing `root` so a long-lived
// request (a run, an app start) can pin the target it started against -
// drillTargetRoot() re-reads the live selection on every call, and a mid-
// request project switch must not swing later reads/writes into the other
// repo. Callers without a root keep the live-resolution behavior.
function drillsDir(root = drillTargetRoot()) {
  return path.join(root, "drills");
}

function pagesDir(root = drillTargetRoot()) {
  return path.join(drillsDir(root), "pages");
}

// Ids are used as filenames — confine to a single slug-ish segment so a
// crafted id can't traverse out of drills/pages/.
export function safeId(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe || safe !== String(id)) throw new Error(`invalid id: ${id}`);
  return safe;
}

// Atomic write: temp file in the SAME directory (so rename is same-filesystem
// and therefore atomic) + rename. Caller re-reads to verify.
async function atomicWriteFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

async function readYaml(file) {
  try {
    return yaml.load(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// ── Drill Book (S11 S12 S13: ledger, page selection, global rules) ──────────

function drillBookPath(root = drillTargetRoot()) {
  return path.join(drillsDir(root), "drillbook.yml");
}

export function defaultDrillBook() {
  return {
    app: { name: "", url: "" },
    fullDrill: false, // A3, S15
    autonomy: "gated", // A5, S22: "gated" | "auto"
    viewports: ["desktop"], // S19 viewport matrix selection
    globalRules: "", // A9, S1 S12
    dispatch: "manual", // D10/S29: "manual" | "heartbeat" | "immediate"
    pages: [] // [{id, title, path, mode: "steps"|"whole", selected}]
  };
}

export async function getDrillBook(root = drillTargetRoot()) {
  const book = await readYaml(drillBookPath(root));
  return book ? { ...defaultDrillBook(), ...book } : defaultDrillBook();
}

// Read-immediately-before-write + subtree-only mutation: merge onto the
// current on-disk book (never trust a caller's stale full snapshot), write
// atomically, then read back to verify.
export async function saveDrillBook(patch, root = drillTargetRoot()) {
  const current = await getDrillBook(root);
  const merged = { ...current, ...patch };
  const file = drillBookPath(root);
  await atomicWriteFile(file, yaml.dump(merged));
  const readBack = await readYaml(file);
  if (!readBack) throw new Error("drillbook.yml write verification failed (read-back empty)");
  return readBack;
}

// ── Pages (B3/B11/C1: areas, steps, states) ─────────────────────────────────

function pagePath(pageId, root = drillTargetRoot()) {
  return path.join(pagesDir(root), `${safeId(pageId)}.yml`);
}

export async function listPages(root = drillTargetRoot()) {
  let entries;
  try {
    entries = await fs.readdir(pagesDir(root));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const file of entries.filter((f) => f.endsWith(".yml"))) {
    try {
      const parsed = await readYaml(path.join(pagesDir(root), file));
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // skip an unparseable file rather than failing the whole list
    }
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export async function getPage(pageId, root = drillTargetRoot()) {
  return readYaml(pagePath(pageId, root));
}

export function defaultPage(pageId) {
  return {
    id: pageId,
    title: pageId,
    path: "/",
    mode: "steps", // "steps" | "whole" (A3/Q4 whole-page-vision override)
    areas: [], // [{n, id: "<page>#<n>", label, anchors:[{kind,value}], rect:{leftPct,topPct,rightPct,bottomPct}}]
    steps: [], // page-level (area:0) + per-area steps
    states: [] // [{id, label, matcher, reachPath:[stepRef], screenshotPath}]
  };
}

export async function savePage(pageId, patch, root = drillTargetRoot()) {
  const id = safeId(pageId);
  const current = (await getPage(id, root)) ?? defaultPage(id);
  const merged = { ...current, ...patch, id };
  const file = pagePath(id, root);
  await atomicWriteFile(file, yaml.dump(merged));
  const readBack = await readYaml(file);
  if (!readBack) throw new Error(`page ${id} write verification failed (read-back empty)`);
  return readBack;
}

export async function deletePage(pageId, root = drillTargetRoot()) {
  try {
    await fs.unlink(pagePath(safeId(pageId), root));
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// Resolve a cross-page area reference like "kb#entry-detail" (B10, S16) to
// {pageId, areaId}. Returns null if malformed (no bare "#" split assumed).
export function parseAreaRef(ref) {
  const idx = String(ref ?? "").indexOf("#");
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { pageId: ref.slice(0, idx), areaId: ref.slice(idx + 1) };
}

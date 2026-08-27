#!/usr/bin/env node
// roadmap.mjs - the agent-facing half of the Roadmaps fitting.
//
// The Garrison view edits roadmap.json through its own API; this CLI is what an
// agent working inside a project reaches for. Both write the SAME file with the
// SAME invariants, and tests/roadmaps.test.ts runs them against each other so
// the two halves cannot drift:
//
//   1. Ids are stable. Nothing renumbers. A new item takes the next id past the
//      highest currently used in its category, so deleting one never makes a
//      later insert collide with a reference to the deleted item.
//   2. `done: true` strikes an item through; it is never removed.
//   3. Unknown keys survive a write - the file belongs to whoever wrote it, and
//      this tool only touches what it was asked to touch.
//   4. Writes are atomic (temp file + rename), so a concurrent reader - the
//      Garrison view, another agent - never sees a torn file.

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const USAGE = `roadmap.mjs - read and edit a project's roadmap.json

  roadmap.mjs --probe
  roadmap.mjs validate    [file]
  roadmap.mjs show        [file]
  roadmap.mjs check       [file] <itemId>
  roadmap.mjs uncheck     [file] <itemId>
  roadmap.mjs add-category [file] <title>
  roadmap.mjs add-item    [file] <categoryId> <text>

\`file\` defaults to ./roadmap.json. Ids are never renumbered; done items are
never removed.`;

// ── io ──────────────────────────────────────────────────────────────────────

function readDoc(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") fail(`no roadmap at ${file}`);
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`${file} is not valid JSON: ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${file} must contain a JSON object at the top level`);
  }
  return parsed;
}

// Temp file in the SAME directory then rename, so the swap is atomic and cannot
// cross a filesystem boundary.
function writeDoc(file, doc) {
  doc.updatedAt = new Date().toISOString();
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.roadmap-tmp-${process.pid}`
  );
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function fail(message) {
  process.stderr.write(`roadmap: ${message}\n`);
  process.exit(1);
}

// ── shape ───────────────────────────────────────────────────────────────────

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);

function categories(doc) {
  return asArray(doc.categories).filter(isObject);
}

function collectIds(doc) {
  const ids = new Set();
  for (const category of categories(doc)) {
    if (typeof category.id === "string") ids.add(category.id);
    for (const item of asArray(category.items).filter(isObject)) {
      if (typeof item.id === "string") ids.add(item.id);
    }
  }
  for (const note of asArray(doc.notes).filter(isObject)) {
    if (typeof note.id === "string") ids.add(note.id);
  }
  return ids;
}

function findCategory(doc, categoryId) {
  return categories(doc).find((category) => category.id === categoryId) ?? null;
}

function findItem(doc, itemId) {
  for (const category of categories(doc)) {
    const item = asArray(category.items)
      .filter(isObject)
      .find((candidate) => candidate.id === itemId);
    if (item) return { category, item };
  }
  return null;
}

function nextCategoryId(doc) {
  const used = collectIds(doc);
  for (let n = 1; ; n += 1) {
    if (!used.has(`c${n}`)) return `c${n}`;
  }
}

// One past the HIGHEST suffix in this category, never the first gap: a deleted
// item's id still exists on a Kanban card somewhere, and reissuing it would
// silently re-point that reference at unrelated work.
function nextItemId(doc, categoryId) {
  const used = collectIds(doc);
  let highest = 0;
  for (const id of used) {
    if (!id.startsWith(`${categoryId}.`)) continue;
    const suffix = Number(id.slice(categoryId.length + 1));
    if (Number.isInteger(suffix) && suffix > highest) highest = suffix;
  }
  for (let n = highest + 1; ; n += 1) {
    if (!used.has(`${categoryId}.${n}`)) return `${categoryId}.${n}`;
  }
}

// Every structural problem, so one run reports the whole list instead of the
// first failure. Duplicate ids come first: they are the invariant that breaks
// every cross-reference.
export function validateDoc(doc) {
  const problems = [];
  const seen = new Set();
  const noteIds = new Set(
    asArray(doc.notes).filter(isObject).map((note) => note.id).filter((id) => typeof id === "string")
  );
  if (typeof doc.title !== "string" || !doc.title.trim()) problems.push("title is missing");
  if (!Array.isArray(doc.categories)) problems.push("categories must be an array");
  if (doc.notes !== undefined && !Array.isArray(doc.notes)) problems.push("notes must be an array");

  const check = (id, what) => {
    if (typeof id !== "string" || !id.trim()) {
      problems.push(`${what} has no id`);
      return;
    }
    if (seen.has(id)) problems.push(`duplicate id "${id}" (${what})`);
    seen.add(id);
  };
  const checkNoteRef = (node, what) => {
    if (node.noteRef == null) return;
    if (typeof node.noteRef !== "string" || !noteIds.has(node.noteRef)) {
      problems.push(`${what} points at note "${node.noteRef}" which does not exist`);
    }
  };

  for (const category of categories(doc)) {
    check(category.id, `category "${category.title ?? "?"}"`);
    checkNoteRef(category, `category "${category.id}"`);
    for (const item of asArray(category.items).filter(isObject)) {
      check(item.id, `item "${item.text ?? "?"}"`);
      checkNoteRef(item, `item "${item.id}"`);
      if (item.done !== undefined && typeof item.done !== "boolean") {
        problems.push(`item "${item.id}" has a non-boolean done`);
      }
      if (
        item.sentToKanban != null &&
        item.sentToKanban !== "backlog" &&
        item.sentToKanban !== "todo"
      ) {
        problems.push(`item "${item.id}" has an unknown sentToKanban "${item.sentToKanban}"`);
      }
    }
  }
  for (const note of asArray(doc.notes).filter(isObject)) check(note.id, "note");
  return problems;
}

// ── commands ────────────────────────────────────────────────────────────────

function show(doc) {
  const lines = [doc.title ?? "(untitled roadmap)"];
  if (doc.intro) lines.push("", doc.intro);
  for (const category of categories(doc)) {
    const items = asArray(category.items).filter(isObject);
    const done = items.filter((item) => item.done === true).length;
    lines.push("", `${category.id}  ${category.title ?? ""}  [${done}/${items.length}]`);
    for (const item of items) {
      const mark = item.done === true ? "x" : " ";
      const sent = item.sentToKanban ? `  (sent to ${item.sentToKanban})` : "";
      lines.push(`  [${mark}] ${item.id}  ${item.text ?? ""}${sent}`);
    }
  }
  const notes = asArray(doc.notes).filter(isObject);
  if (notes.length) {
    lines.push("", "notes:");
    for (const note of notes) lines.push(`  ${note.id}  ${note.title ?? ""}`);
  }
  return lines.join("\n");
}

// The verify hook. Proves the module loads AND that its invariants hold, by
// running them over a fixture rather than just printing ok.
function probe() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "roadmaps-probe-"));
  const file = path.join(dir, "roadmap.json");
  try {
    const doc = { title: "probe", categories: [{ id: "p", title: "P", items: [] }], notes: [] };
    writeDoc(file, doc);
    const read = readDoc(file);
    const problems = validateDoc(read);
    if (problems.length) fail(`self-check failed: ${problems.join("; ")}`);
    const items = read.categories[0].items;
    for (const text of ["one", "two", "three"]) {
      items.push({ id: nextItemId(read, "p"), text, done: false });
    }
    const ids = items.map((item) => item.id);
    if (ids.join(",") !== "p.1,p.2,p.3") fail(`self-check failed: minted ${ids.join(",")}`);
    // Deleting from the middle must not free that id for the next insert.
    items.splice(1, 1);
    const afterDelete = nextItemId(read, "p");
    if (afterDelete !== "p.4") fail(`self-check failed: reissued ${afterDelete} after a delete`);
    return "ROADMAPS-OK";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "--probe") {
    process.stdout.write(`${probe()}\n`);
    return;
  }

  // `file` is optional and positional: treat a first argument that looks like a
  // path (or exists) as the file, otherwise default to ./roadmap.json.
  let file = "roadmap.json";
  let args = rest;
  if (rest[0] && (rest[0].endsWith(".json") || rest[0].includes("/"))) {
    file = rest[0];
    args = rest.slice(1);
  }
  file = path.resolve(file);

  switch (command) {
    case "validate": {
      const problems = validateDoc(readDoc(file));
      if (problems.length) {
        process.stderr.write(problems.map((p) => `  - ${p}`).join("\n") + "\n");
        process.exit(1);
      }
      process.stdout.write("ok\n");
      return;
    }
    case "show": {
      process.stdout.write(`${show(readDoc(file))}\n`);
      return;
    }
    case "check":
    case "uncheck": {
      const itemId = args[0];
      if (!itemId) fail(`${command} needs an item id`);
      const doc = readDoc(file);
      const found = findItem(doc, itemId);
      if (!found) fail(`no item "${itemId}" in ${file}`);
      found.item.done = command === "check";
      writeDoc(file, doc);
      process.stdout.write(`${itemId} ${command === "check" ? "done" : "reopened"}\n`);
      return;
    }
    case "add-category": {
      const title = args.join(" ").trim();
      if (!title) fail("add-category needs a title");
      const doc = readDoc(file);
      if (!Array.isArray(doc.categories)) doc.categories = [];
      const id = nextCategoryId(doc);
      doc.categories.push({ id, title, noteRef: null, items: [] });
      writeDoc(file, doc);
      process.stdout.write(`${id}\n`);
      return;
    }
    case "add-item": {
      const categoryId = args[0];
      const text = args.slice(1).join(" ").trim();
      if (!categoryId || !text) fail("add-item needs a category id and text");
      const doc = readDoc(file);
      const category = findCategory(doc, categoryId);
      if (!category) fail(`no category "${categoryId}" in ${file}`);
      if (!Array.isArray(category.items)) category.items = [];
      const id = nextItemId(doc, categoryId);
      category.items.push({ id, text, done: false, sentToKanban: null, noteRef: null });
      writeDoc(file, doc);
      process.stdout.write(`${id}\n`);
      return;
    }
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

export { collectIds, nextCategoryId, nextItemId, show };

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

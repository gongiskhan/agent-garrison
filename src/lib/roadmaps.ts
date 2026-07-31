// Roadmaps - one `roadmap.json` per project, read and mutated in place.
//
// The file is the single source of truth. Neither the view nor this module
// keeps a shadow copy: every mutation is a read-modify-write against the file
// on disk, so an edit made by an agent in another session (the expected common
// case - agents are the main authors) merges naturally at operation grain
// instead of being clobbered by a stale whole-document PUT.
//
// Two invariants carry the whole design and are enforced here, not by
// convention:
//   1. IDS ARE STABLE. Ids are referenced from other conversations and from
//      Kanban cards, so nothing ever renumbers - not on insert, not on delete.
//      A new task's id continues past the HIGHEST suffix in its category rather
//      than filling the first gap, so deleting an item never makes a later
//      insert collide with a reference to the deleted one (see nextItemId for
//      the one case that rule cannot cover).
//   2. UNKNOWN KEYS SURVIVE. Reads parse into a plain object and writes go back
//      out from that same object, so a field an agent added (or a future
//      version of this fitting adds) is not silently dropped by a checkbox
//      click. The typed projection below is for the API response only.

import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { resolveProjectName, listProjectNames, readDevRoot } from "./dev-root";

export const ROADMAP_FILENAME = "roadmap.json";

export type KanbanTarget = "backlog" | "todo";

export interface RoadmapItem {
  id: string;
  text: string;
  done: boolean;
  /** Which Kanban list this item was last sent to; null = never sent. */
  sentToKanban: KanbanTarget | null;
  sentToKanbanAt: string | null;
  kanbanCardId: string | null;
  /** Id of a note in `notes[]` holding the decisions behind this item. */
  noteRef: string | null;
}

export interface RoadmapCategory {
  id: string;
  title: string;
  noteRef: string | null;
  items: RoadmapItem[];
}

export interface RoadmapNote {
  id: string;
  title: string;
  body: string;
}

export interface Roadmap {
  title: string;
  /** The rule fixed at the top of the roadmap; rendered above the categories. */
  intro: string | null;
  updatedAt: string | null;
  categories: RoadmapCategory[];
  notes: RoadmapNote[];
}

export interface RoadmapProject {
  name: string;
  hasRoadmap: boolean;
}

/** The raw parsed document - a plain object whose extra keys we preserve. */
type RawDoc = Record<string, unknown>;

export class RoadmapNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadmapNotFoundError";
  }
}

// A caller-facing validation failure (blank title, unknown operation) as
// opposed to an internal one. Classified explicitly so the API maps it to 400
// instead of pattern-matching on message text.
export class RoadmapRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadmapRequestError";
  }
}

// The file exists but does not parse. Never repaired automatically: the fix is
// a human editing their own file, and a silent rewrite would lose its contents.
export class RoadmapMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadmapMalformedError";
  }
}

// ── location ────────────────────────────────────────────────────────────────

// Resolve a project label to its `roadmap.json` path. The label is checked by
// the dev-root resolver, so a value off the wire can only ever name a git repo
// directly under the dev-root - never a traversal, never an arbitrary path.
export function roadmapPathForProject(project: string): string {
  const repo = resolveProjectName(project);
  if (!repo) {
    throw new RoadmapNotFoundError(
      `unknown project "${project}" (expected a git repo directly under ${readDevRoot()})`
    );
  }
  return path.join(repo, ROADMAP_FILENAME);
}

// Every project the picker may offer, flagged with whether it already has a
// roadmap. Best-effort per project: an unreadable entry reports no roadmap
// rather than failing the whole list.
export async function listRoadmapProjects(): Promise<RoadmapProject[]> {
  const names = listProjectNames();
  return Promise.all(
    names.map(async (name) => {
      let hasRoadmap = false;
      try {
        const repo = resolveProjectName(name);
        if (repo) {
          const stat = await fs.stat(path.join(repo, ROADMAP_FILENAME));
          hasRoadmap = stat.isFile();
        }
      } catch {
        hasRoadmap = false;
      }
      return { name, hasRoadmap };
    })
  );
}

// ── read / write ────────────────────────────────────────────────────────────

// Parse the file. Returns null when there is no roadmap yet (the offer-to-create
// state). A file that exists but does not parse THROWS rather than reading as
// empty: silently treating a broken file as "no roadmap" would let the next
// write overwrite whatever was in it.
export async function readRoadmapDoc(file: string): Promise<RawDoc | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RoadmapMalformedError(
      `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}) - fix it by hand; refusing to overwrite it`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RoadmapMalformedError(`${file} must contain a JSON object at the top level`);
  }
  return parsed as RawDoc;
}

// Serialize with a stamped updatedAt. Atomic (temp file + rename) so a reader -
// the CLI, an agent, another tab - never catches a torn file.
export async function writeRoadmapDoc(
  file: string,
  doc: RawDoc,
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  doc.updatedAt = now();
  await writeFileAtomic(file, JSON.stringify(doc, null, 2) + "\n");
}

export function emptyRoadmapDoc(title: string): RawDoc {
  return { title, intro: null, updatedAt: null, categories: [], notes: [] };
}

// ── typed projection (API response shape) ───────────────────────────────────

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function kanbanTarget(value: unknown): KanbanTarget | null {
  return value === "backlog" || value === "todo" ? value : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function obj(value: unknown): RawDoc | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : null;
}

// Project the raw document into the typed shape the view renders. Entries with
// no usable id are dropped from the projection (they are unaddressable), but
// they stay in the file - this never writes.
export function projectRoadmap(doc: RawDoc): Roadmap {
  const categories: RoadmapCategory[] = [];
  for (const rawCategory of arr(doc.categories)) {
    const category = obj(rawCategory);
    const id = category ? strOrNull(category.id) : null;
    if (!category || !id) continue;
    const items: RoadmapItem[] = [];
    for (const rawItem of arr(category.items)) {
      const item = obj(rawItem);
      const itemId = item ? strOrNull(item.id) : null;
      if (!item || !itemId) continue;
      items.push({
        id: itemId,
        text: str(item.text),
        done: item.done === true,
        sentToKanban: kanbanTarget(item.sentToKanban),
        sentToKanbanAt: strOrNull(item.sentToKanbanAt),
        kanbanCardId: strOrNull(item.kanbanCardId),
        noteRef: strOrNull(item.noteRef)
      });
    }
    categories.push({
      id,
      title: str(category.title),
      noteRef: strOrNull(category.noteRef),
      items
    });
  }

  const notes: RoadmapNote[] = [];
  for (const rawNote of arr(doc.notes)) {
    const note = obj(rawNote);
    const id = note ? strOrNull(note.id) : null;
    if (!note || !id) continue;
    notes.push({ id, title: str(note.title), body: str(note.body) });
  }

  return {
    title: str(doc.title, "Roadmap"),
    intro: strOrNull(doc.intro),
    updatedAt: strOrNull(doc.updatedAt),
    categories,
    notes
  };
}

// ── id minting ──────────────────────────────────────────────────────────────

// Every id in the document - categories, items and notes share one namespace so
// an anchor (`#f0`) can never be ambiguous.
export function collectIds(doc: RawDoc): Set<string> {
  const ids = new Set<string>();
  for (const rawCategory of arr(doc.categories)) {
    const category = obj(rawCategory);
    if (!category) continue;
    const id = strOrNull(category.id);
    if (id) ids.add(id);
    for (const rawItem of arr(category.items)) {
      const item = obj(rawItem);
      const itemId = item ? strOrNull(item.id) : null;
      if (itemId) ids.add(itemId);
    }
  }
  for (const rawNote of arr(doc.notes)) {
    const note = obj(rawNote);
    const id = note ? strOrNull(note.id) : null;
    if (id) ids.add(id);
  }
  return ids;
}

function firstFree(used: Set<string>, candidate: (n: number) => string): string {
  for (let n = 1; ; n += 1) {
    const id = candidate(n);
    if (!used.has(id)) return id;
  }
}

export function nextCategoryId(doc: RawDoc): string {
  return firstFree(collectIds(doc), (n) => `c${n}`);
}

// `<categoryId>.<n>`, one past the highest numeric suffix currently used in that
// category rather than the first gap. A deleted item's id must not come back:
// the reference to it (a Kanban card, another conversation) still exists, and
// re-minting it would silently re-point that reference at new work.
//
// The one case this cannot cover is deleting the LAST item of a category and
// then adding another - with the id gone from the file there is nothing left to
// count past. Closing it would need a retired-ids ledger, and a ledger only
// maintained by this code is worse than no ledger: agents edit roadmap.json by
// hand as a matter of course, so the rule has to hold from the file's contents
// alone.
export function nextItemId(doc: RawDoc, categoryId: string): string {
  const used = collectIds(doc);
  let highest = 0;
  for (const id of used) {
    if (!id.startsWith(`${categoryId}.`)) continue;
    const suffix = Number(id.slice(categoryId.length + 1));
    if (Number.isInteger(suffix) && suffix > highest) highest = suffix;
  }
  for (let n = highest + 1; ; n += 1) {
    const candidate = `${categoryId}.${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function nextNoteId(doc: RawDoc, ownerId: string): string {
  const used = collectIds(doc);
  const base = `n-${ownerId}`;
  if (!used.has(base)) return base;
  return firstFree(used, (n) => `${base}-${n + 1}`);
}

// ── navigation ──────────────────────────────────────────────────────────────

function categoryNode(doc: RawDoc, categoryId: string): RawDoc | null {
  for (const rawCategory of arr(doc.categories)) {
    const category = obj(rawCategory);
    if (category && category.id === categoryId) return category;
  }
  return null;
}

function itemNode(doc: RawDoc, itemId: string): { category: RawDoc; item: RawDoc } | null {
  for (const rawCategory of arr(doc.categories)) {
    const category = obj(rawCategory);
    if (!category) continue;
    for (const rawItem of arr(category.items)) {
      const item = obj(rawItem);
      if (item && item.id === itemId) return { category, item };
    }
  }
  return null;
}

function noteNode(doc: RawDoc, noteId: string): RawDoc | null {
  for (const rawNote of arr(doc.notes)) {
    const note = obj(rawNote);
    if (note && note.id === noteId) return note;
  }
  return null;
}

export function findItemContext(
  doc: RawDoc,
  itemId: string
): { categoryTitle: string; item: RoadmapItem; note: RoadmapNote | null } | null {
  const roadmap = projectRoadmap(doc);
  for (const category of roadmap.categories) {
    const item = category.items.find((candidate) => candidate.id === itemId);
    if (!item) continue;
    const noteId = item.noteRef ?? category.noteRef;
    const note = noteId ? (roadmap.notes.find((n) => n.id === noteId) ?? null) : null;
    return { categoryTitle: category.title, item, note };
  }
  return null;
}

// ── operations ──────────────────────────────────────────────────────────────

export type RoadmapOp =
  | { op: "set-done"; itemId: string; done: boolean }
  | { op: "add-category"; title: string }
  | { op: "add-item"; categoryId: string; text: string }
  | { op: "edit-category"; categoryId: string; title: string }
  | { op: "edit-item"; itemId: string; text: string }
  | { op: "delete-category"; categoryId: string }
  | { op: "delete-item"; itemId: string }
  | { op: "set-title"; title: string }
  | { op: "set-intro"; intro: string }
  | { op: "upsert-note"; ownerId: string; title: string; body: string }
  | { op: "delete-note"; noteId: string };

// Apply one operation to the raw document IN PLACE. Throws with a caller-facing
// message when the target does not exist, so the API can answer 404 instead of
// silently succeeding.
export function applyOp(doc: RawDoc, operation: RoadmapOp): void {
  if (!Array.isArray(doc.categories)) doc.categories = [];
  if (!Array.isArray(doc.notes)) doc.notes = [];
  const categories = doc.categories as unknown[];
  const notes = doc.notes as unknown[];

  switch (operation.op) {
    case "set-done": {
      const found = itemNode(doc, operation.itemId);
      if (!found) throw new RoadmapNotFoundError(`no item "${operation.itemId}"`);
      // Done is a strike-through, never a removal: the history stays visible.
      found.item.done = operation.done === true;
      return;
    }
    case "add-category": {
      const title = operation.title.trim();
      if (!title) throw new RoadmapRequestError("a category needs a title");
      categories.push({ id: nextCategoryId(doc), title, noteRef: null, items: [] });
      return;
    }
    case "add-item": {
      const category = categoryNode(doc, operation.categoryId);
      if (!category) throw new RoadmapNotFoundError(`no category "${operation.categoryId}"`);
      const text = operation.text.trim();
      if (!text) throw new RoadmapRequestError("a task needs text");
      if (!Array.isArray(category.items)) category.items = [];
      (category.items as unknown[]).push({
        id: nextItemId(doc, operation.categoryId),
        text,
        done: false,
        sentToKanban: null,
        noteRef: null
      });
      return;
    }
    case "edit-category": {
      const category = categoryNode(doc, operation.categoryId);
      if (!category) throw new RoadmapNotFoundError(`no category "${operation.categoryId}"`);
      const title = operation.title.trim();
      if (!title) throw new RoadmapRequestError("a category needs a title");
      category.title = title;
      return;
    }
    case "edit-item": {
      const found = itemNode(doc, operation.itemId);
      if (!found) throw new RoadmapNotFoundError(`no item "${operation.itemId}"`);
      const text = operation.text.trim();
      if (!text) throw new RoadmapRequestError("a task needs text");
      found.item.text = text;
      return;
    }
    case "delete-category": {
      const index = categories.findIndex(
        (candidate) => obj(candidate)?.id === operation.categoryId
      );
      if (index < 0) throw new RoadmapNotFoundError(`no category "${operation.categoryId}"`);
      categories.splice(index, 1);
      return;
    }
    case "delete-item": {
      for (const rawCategory of categories) {
        const category = obj(rawCategory);
        if (!category || !Array.isArray(category.items)) continue;
        const items = category.items as unknown[];
        const index = items.findIndex((candidate) => obj(candidate)?.id === operation.itemId);
        if (index >= 0) {
          items.splice(index, 1);
          return;
        }
      }
      throw new RoadmapNotFoundError(`no item "${operation.itemId}"`);
    }
    case "set-title": {
      const title = operation.title.trim();
      if (!title) throw new RoadmapRequestError("the roadmap needs a title");
      doc.title = title;
      return;
    }
    case "set-intro": {
      doc.intro = operation.intro.trim() || null;
      return;
    }
    case "upsert-note": {
      const owner =
        categoryNode(doc, operation.ownerId) ?? itemNode(doc, operation.ownerId)?.item ?? null;
      if (!owner) throw new RoadmapNotFoundError(`no category or item "${operation.ownerId}"`);
      const existingId = strOrNull(owner.noteRef);
      const existing = existingId ? noteNode(doc, existingId) : null;
      if (existing) {
        existing.title = operation.title.trim() || str(existing.title);
        existing.body = operation.body;
        return;
      }
      const id = existingId ?? nextNoteId(doc, operation.ownerId);
      notes.push({ id, title: operation.title.trim() || "Notes", body: operation.body });
      owner.noteRef = id;
      return;
    }
    case "delete-note": {
      const index = notes.findIndex((candidate) => obj(candidate)?.id === operation.noteId);
      if (index < 0) throw new RoadmapNotFoundError(`no note "${operation.noteId}"`);
      notes.splice(index, 1);
      // Clear every dangling reference, or the anchor link points at nothing.
      for (const rawCategory of categories) {
        const category = obj(rawCategory);
        if (!category) continue;
        if (category.noteRef === operation.noteId) category.noteRef = null;
        for (const rawItem of arr(category.items)) {
          const item = obj(rawItem);
          if (item && item.noteRef === operation.noteId) item.noteRef = null;
        }
      }
      return;
    }
    default: {
      // The union is exhaustive at compile time; this catches an `op` string
      // that only exists at runtime (a stale client, a hand-rolled request).
      const unknown = operation as { op?: unknown };
      throw new RoadmapRequestError(`unknown roadmap operation "${String(unknown.op)}"`);
    }
  }
}

// Record a Kanban hand-off on the item. Separate from applyOp because it is
// written by the bridge after the board confirms the card, never by the UI.
export function markSentToKanban(
  doc: RawDoc,
  itemId: string,
  target: KanbanTarget,
  cardId: string,
  now: () => string = () => new Date().toISOString()
): void {
  const found = itemNode(doc, itemId);
  if (!found) throw new RoadmapNotFoundError(`no item "${itemId}"`);
  found.item.sentToKanban = target;
  found.item.kanbanCardId = cardId;
  found.item.sentToKanbanAt = now();
}

// ── serialized mutation ─────────────────────────────────────────────────────

// One in-flight write per file. Two clicks in the same second are two
// read-modify-write cycles; without this they interleave and the second read
// misses the first write.
const writeChain = new Map<string, Promise<unknown>>();

export async function mutateRoadmap<T>(
  file: string,
  mutate: (doc: RawDoc) => T | Promise<T>
): Promise<{ doc: RawDoc; result: T }> {
  const previous = writeChain.get(file) ?? Promise.resolve();
  const run = previous.then(
    async (): Promise<{ doc: RawDoc; result: T }> => {
      const doc = await readRoadmapDoc(file);
      if (!doc) throw new RoadmapNotFoundError(`no ${ROADMAP_FILENAME} at ${file}`);
      const result = await mutate(doc);
      await writeRoadmapDoc(file, doc);
      return { doc, result };
    }
  );
  // Keep the chain alive on failure so one rejected op does not poison the next.
  writeChain.set(
    file,
    run.catch(() => undefined)
  );
  return run;
}

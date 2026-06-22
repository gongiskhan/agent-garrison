// Kanban Loop storage (V1a): file-per-card under ~/.garrison/kanban-loop.
//   board.json            — list defs + order + per-list config (NEVER membership)
//   cards/<ulid>/card.json — title, project, list, status, iterations, goalMode, ts
//   cards/<ulid>/log-N.md  — per-session logs (written by the engine)
// List membership is DERIVED by scanning cards (brief §3) — never stored on disk.
// Every mutation is read-immediately-before-write + atomic (temp file then rename).
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ulid } from "./ulid.mjs";

export function kanbanRoot() {
  return process.env.GARRISON_KANBAN_DIR || path.join(os.homedir(), ".garrison", "kanban-loop");
}

// Atomic JSON write: write a unique temp file, then rename over the target so a
// reader never sees a partial file and two writers don't interleave.
export async function atomicWriteJSON(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${ulid()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function loadBoard(root = kanbanRoot()) {
  return readJSON(path.join(root, "board.json"));
}

export async function saveBoard(board, root = kanbanRoot()) {
  await atomicWriteJSON(path.join(root, "board.json"), board);
}

const cardFile = (root, id) => path.join(root, "cards", id, "card.json");

export async function createCard(root, { title, description = "", project = null, list, goalMode = false, acceptance = null, at = new Date().toISOString() }) {
  const id = ulid();
  const card = {
    id,
    title: title ?? "(untitled)",
    description,
    project,
    list,
    status: "ok",
    iterations: 0,
    cost: null,
    goalMode: Boolean(goalMode),
    acceptance,
    created: at,
    updated: at
  };
  await atomicWriteJSON(cardFile(root, id), card);
  return card;
}

export async function loadCard(root, id) {
  return readJSON(cardFile(root, id));
}

// Read-immediately-before-write then atomic-write the mutated card.
export async function saveCard(root, card, at = new Date().toISOString()) {
  await atomicWriteJSON(cardFile(root, card.id), { ...card, updated: at });
}

export async function listCardIds(root = kanbanRoot()) {
  try {
    const entries = await fs.readdir(path.join(root, "cards"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function loadAllCards(root = kanbanRoot()) {
  const ids = await listCardIds(root);
  const cards = [];
  for (const id of ids) {
    try {
      cards.push(await loadCard(root, id));
    } catch {
      // skip an unreadable/partial card dir
    }
  }
  return cards;
}

// Derive list membership from the cards (pure) — never stored.
export function deriveMembership(cards) {
  const byList = {};
  for (const c of cards) {
    (byList[c.list] ??= []).push(c.id);
  }
  return byList;
}

// Append a per-session log line for a card (cards/<id>/log-N.md).
export async function appendCardLog(root, id, n, text) {
  const file = path.join(root, "cards", id, `log-${n}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text.endsWith("\n") ? text : text + "\n", "utf8");
  return file;
}

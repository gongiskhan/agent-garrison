// The standing Zeca conversation (D60).
//
// Every spoken "Zeca" - from the pendant, from the phone's Listen button, from
// Omi - lands as a turn in ONE long-running conversation instead of a fresh
// thread per command or a classifier lane that never showed the person what
// it did. This module owns that conversation's identity: a pointer file names
// the current thread, the thread is created on first ask, and a nightly job
// rotates it so the context never grows without bound. Rotation keeps the old
// thread file untouched (it is the record the review reads) and points the
// name at a fresh one; the previous ids stay in the pointer for the review.
//
// capture-service resolves the id through GET /api/zeca and caches it, so the
// voice layer never needs to know how threads are stored.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureThread, renameThread, threadExistsSync } from "./threads.mjs";

export const ZECA_TITLE = "Zeca";
export const ZECA_SOURCE = "zeca";
// How many rotated-out ids the pointer remembers. The review reads the newest
// one; the rest are a breadcrumb trail, not a database.
export const ZECA_HISTORY_CAP = 60;

function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

export function zecaPointerPath() {
  return path.join(garrisonDir(), "web-channel", "zeca.json");
}

// A fresh id: readable in the rail's URL and in the review card, unique by the
// second plus a short random tail so two rotations in one second cannot meet.
export function newZecaThreadId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase();
  const tail = Math.random().toString(36).slice(2, 6);
  return `zeca-${stamp}-${tail}`;
}

function readPointer() {
  const file = zecaPointerPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed.conversationId !== "string") return null;
    return {
      conversationId: parsed.conversationId,
      since: typeof parsed.since === "string" ? parsed.since : null,
      previous: Array.isArray(parsed.previous) ? parsed.previous.filter((p) => p && typeof p.conversationId === "string") : []
    };
  } catch {
    return null;
  }
}

async function writePointer(pointer) {
  const file = zecaPointerPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(pointer, null, 2));
  await rename(tmp, file);
  return pointer;
}

// Pointer writes are rare (first ask, nightly rotate) but two concurrent first
// asks - the page and capture-service booting together - must agree on one id.
let chain = Promise.resolve();
function serialize(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function createCurrent(previous, nowIso) {
  const id = newZecaThreadId(new Date(nowIso));
  await ensureThread({ id, title: ZECA_TITLE, source: ZECA_SOURCE, nowIso });
  return writePointer({ conversationId: id, since: nowIso, previous: previous.slice(0, ZECA_HISTORY_CAP) });
}

/**
 * The current Zeca conversation, created when there is none yet or when the
 * thread the pointer names has been deleted from disk (a pointer to nothing
 * would send every wake turn into a 404).
 */
export async function zecaConversation({ nowIso = new Date().toISOString() } = {}) {
  return serialize(async () => {
    const pointer = readPointer();
    if (pointer && threadExistsSync(pointer.conversationId)) return pointer;
    return createCurrent(pointer?.previous ?? [], nowIso);
  });
}

/**
 * Rotate: the current thread keeps its file and gets a dated title so the rail
 * still tells it apart from the live one; a fresh thread takes the name.
 * Returns the new pointer plus the id that was rotated out (null when there
 * was nothing to rotate, so a caller can tell "fresh start" from "rotated").
 */
export async function rotateZecaConversation({ nowIso = new Date().toISOString(), reason = "rotate" } = {}) {
  return serialize(async () => {
    const pointer = readPointer();
    const rotated = pointer && threadExistsSync(pointer.conversationId) ? pointer.conversationId : null;
    const previous = [...(pointer?.previous ?? [])];
    if (rotated) {
      const day = nowIso.slice(0, 10);
      // Rename first: a crash between the two writes leaves an honest state
      // (the old thread already reads as closed, the pointer still names it,
      // and the next rotate simply renames it again).
      await renameThread(rotated, `${ZECA_TITLE} until ${day}`).catch(() => {});
      previous.unshift({ conversationId: rotated, since: pointer.since ?? null, until: nowIso, reason });
    }
    const next = await createCurrent(previous, nowIso);
    return { ...next, rotated };
  });
}

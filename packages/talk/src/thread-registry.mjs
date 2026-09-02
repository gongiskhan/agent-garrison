// thread-registry.mjs — cross-node visibility of this node's web-channel threads.
//
// A thread's MESSAGES stay where they are written: one file per thread under
// $GARRISON_HOME/web-channel/threads/<id>.json, on the node that owns the
// conversation. Message bodies carry tool output and inline images, they are only
// useful next to the live generation the home node owns, and moving them would
// cost a network write per token to buy a read that the peer proxy already
// provides.
//
// What travels is a compact INDEX — enough for another node to list "the
// conversations happening on the mini" and deep-link into them:
//
//   config doc "web-channel.threads" / "node:<name>"
//     { threads: [ { id, title, lastMessageAt, messageCount, cardId } ], updatedAt }
//
// Two properties keep this cheap enough to hang off every thread write:
//
//   - DEBOUNCED. A burst of writes (a turn writes the transcript, the session id
//     and the settled input back to back) coalesces into ONE doc update, never
//     less than DEBOUNCE_MS apart. The index is metadata; two seconds of lag is
//     invisible and a write per message would not be.
//   - CAPPED. The most recent MAX_THREADS entries by last message. An index that
//     grows without bound stops being an index.
//
// The write is rev-CAS with a single retry: only this node writes its own scope,
// so a conflict means another process on this node raced us and re-reading is
// the whole fix. Best-effort throughout — an unenrolled node, or one whose state
// service is down, keeps writing threads to disk exactly as before.

import { readFileSync } from "node:fs";
import { createStateClient } from "@garrison/state-client";

const NAMESPACE = "web-channel.threads";
const DEBOUNCE_MS = 2000;
const MAX_THREADS = 200;
const TIMEOUT_MS = 3000;

let cachedClient = null;
let disabled = false;
let warnedKind = null;

// The node's own view of its index. Seeded from the stored doc on the first
// flush, authoritative afterwards (this node is the only writer of its scope).
const index = new Map();
// Ids deleted here that the stored doc may still carry: the seed merge must not
// resurrect them.
const forgotten = new Set();
let seeded = false;
let timer = null;
let lastWriteAt = 0;
let pending = null; // { promise, resolve } — the one flush callers can await

function warnOnce(kind, err) {
  if (warnedKind === kind) return;
  warnedKind = kind;
  console.warn(`[thread-registry] ${kind}: ${err?.message ?? err}`);
}

function client() {
  if (disabled) return null;
  if (cachedClient) return cachedClient;
  try {
    cachedClient = createStateClient({ readFileSync, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    disabled = true;
    warnOnce("not-enrolled", err);
    return null;
  }
  return cachedClient;
}

function nodeScope(c) {
  const name = String(c?.node || process.env.GARRISON_NODE_NAME || "").trim();
  if (!name) {
    disabled = true;
    warnOnce(
      "no-node-name",
      new Error("this node has no name — set GARRISON_NODE_NAME (or `node` in $GARRISON_HOME/state.json)")
    );
    return null;
  }
  return `node:${name}`;
}

function lastMessageAt(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const ts = messages[i]?.ts;
    if (typeof ts === "string" && ts) return ts;
  }
  return thread?.updatedAt ?? thread?.createdAt ?? null;
}

/** The compact row for one thread. `meta` is threads.mjs's own toMeta() output,
 *  so the title is the one the UI already shows rather than a second derivation. */
export function threadEntry(thread, meta = {}) {
  const id = meta.id ?? thread?.id;
  if (!id) return null;
  const cardId = thread?.context?.cardId;
  return {
    id: String(id),
    title: typeof meta.title === "string" ? meta.title : (thread?.title ?? null),
    lastMessageAt: lastMessageAt(thread),
    messageCount: Number.isFinite(meta.messageCount)
      ? meta.messageCount
      : (Array.isArray(thread?.messages) ? thread.messages.length : 0),
    cardId: typeof cardId === "string" && cardId ? cardId : null
  };
}

function capped() {
  return [...index.values()]
    .sort((a, b) => String(b.lastMessageAt ?? "").localeCompare(String(a.lastMessageAt ?? "")))
    .slice(0, MAX_THREADS);
}

async function writeDoc() {
  const c = client();
  if (!c) return;
  const scope = nodeScope(c);
  if (!scope) return;

  let doc = await c.getConfig(NAMESPACE, scope);
  if (!seeded) {
    for (const entry of doc?.body?.threads ?? []) {
      if (entry?.id && !index.has(entry.id) && !forgotten.has(entry.id)) index.set(entry.id, entry);
    }
    seeded = true;
  }

  const body = { threads: capped(), updatedAt: new Date().toISOString() };
  try {
    await c.putConfig(NAMESPACE, scope, body, { ifMatchRev: doc?.rev ?? 0 });
  } catch (err) {
    // A 409 means another process on this node wrote between the read and the
    // put. Re-read and retry ONCE; a ladder here would only queue metadata.
    if (err?.status !== 409) throw err;
    doc = await c.getConfig(NAMESPACE, scope);
    await c.putConfig(NAMESPACE, scope, body, { ifMatchRev: doc?.rev ?? 0 });
  }
  forgotten.clear();
}

function schedule() {
  if (timer) return pending.promise;
  if (!pending) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    pending = { promise, resolve };
  }
  const wait = Math.max(0, DEBOUNCE_MS - (Date.now() - lastWriteAt));
  timer = setTimeout(() => { void flushThreadRegistry(); }, wait);
  timer.unref?.();
  return pending.promise;
}

/** Write the pending index now (tests, shutdown). Never rejects. */
export async function flushThreadRegistry() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const waiting = pending;
  pending = null;
  if (!waiting) return;
  try {
    await writeDoc();
  } catch (err) {
    warnOnce("write-failed", err);
  }
  // The floor holds whether the write landed or not: a failing service must not
  // turn the debounce into a hot retry loop.
  lastWriteAt = Date.now();
  waiting.resolve();
}

/** Record one thread's metadata. Debounced; returns the pending flush so a
 *  caller that cares (a test) can await it, while the live path does not. */
export function noteThread(thread, meta = {}) {
  if (disabled) return Promise.resolve();
  const entry = threadEntry(thread, meta);
  if (!entry) return Promise.resolve();
  forgotten.delete(entry.id);
  index.set(entry.id, entry);
  return schedule();
}

/** A thread was deleted here; drop it from the index on the next flush. */
export function forgetThread(id) {
  if (disabled || !id) return Promise.resolve();
  const key = String(id);
  index.delete(key);
  forgotten.add(key);
  return schedule();
}

export function _resetForTests() {
  cachedClient = null;
  disabled = false;
  warnedKind = null;
  index.clear();
  forgotten.clear();
  seeded = false;
  if (timer) clearTimeout(timer);
  timer = null;
  lastWriteAt = 0;
  pending = null;
}

export const _internals = { NAMESPACE, DEBOUNCE_MS, MAX_THREADS };

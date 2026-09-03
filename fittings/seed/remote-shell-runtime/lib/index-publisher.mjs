// Publishes this node's session index to the state service, so any other
// node's Conversations list can show what is running here. Mirrors
// packages/talk/src/thread-registry.mjs's shape (debounced, best-effort,
// never blocks the caller on a slow or absent state service) with one
// difference: the index IS the full snapshot every time (buildIndex already
// caps and sorts it), so there is no seed-merge to do.

import { readFileSync } from "node:fs";
import { createStateClient } from "./state-client.mjs";
import { nodeName } from "./node-identity.mjs";

const NAMESPACE = "shells.sessions";
const DEBOUNCE_MS = 2000;
const TIMEOUT_MS = 3000;

let cachedClient = null;
let disabled = false;
let warnedKind = null;
let timer = null;
let lastWriteAt = 0;
let pendingBody = null;
let pending = null; // { promise, resolve }

function warnOnce(kind, err) {
  if (warnedKind === kind) return;
  warnedKind = kind;
  console.warn(`[shells-index-publisher] ${kind}: ${err?.message ?? err}`);
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

async function writeDoc(body) {
  const c = client();
  if (!c) return;
  const scope = `node:${c.node || nodeName()}`;
  let doc = null;
  try {
    doc = await c.getConfig(NAMESPACE, scope);
  } catch (err) {
    warnOnce("read-failed", err);
  }
  try {
    await c.putConfig(NAMESPACE, scope, body, { ifMatchRev: doc?.rev ?? 0 });
  } catch (err) {
    // A 409 means something else on this node wrote between the read and the
    // put (there should only ever be one publisher process, but a restart
    // racing the old one's last flush is possible) - re-read and retry once.
    if (err?.status !== 409) throw err;
    doc = await c.getConfig(NAMESPACE, scope);
    await c.putConfig(NAMESPACE, scope, body, { ifMatchRev: doc?.rev ?? 0 });
  }
}

function schedule() {
  if (timer) return pending.promise;
  if (!pending) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    pending = { promise, resolve };
  }
  const wait = Math.max(0, DEBOUNCE_MS - (Date.now() - lastWriteAt));
  timer = setTimeout(() => { void flush(); }, wait);
  timer.unref?.();
  return pending.promise;
}

/** Schedule `body` ({node, shellOrigin, updatedAt, rows}) for publication.
 *  Debounced; the last call before a flush wins (an index build supersedes
 *  the previous one entirely, there is nothing to merge). */
export function schedulePublish(body) {
  if (disabled) return Promise.resolve();
  pendingBody = body;
  return schedule();
}

/** Write the pending body now (tests, shutdown). Never rejects. */
export async function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const waiting = pending;
  const body = pendingBody;
  pending = null;
  pendingBody = null;
  if (!waiting) return;
  try {
    if (body) await writeDoc(body);
  } catch (err) {
    warnOnce("write-failed", err);
  }
  lastWriteAt = Date.now();
  waiting.resolve();
}

export function _resetForTests() {
  cachedClient = null;
  disabled = false;
  warnedKind = null;
  if (timer) clearTimeout(timer);
  timer = null;
  lastWriteAt = 0;
  pending = null;
  pendingBody = null;
}

export const _internals = { NAMESPACE, DEBOUNCE_MS };

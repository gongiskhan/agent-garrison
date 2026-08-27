// session-registry.mjs — the gateway's half of the mesh session registry.
//
// The state service holds one row per Operative RUN, and it holds METADATA ONLY:
// which node is running what, in which composition, on which runtime, in which
// cwd, and whether it is busy right now. That is exactly enough for a peer's UI
// to list "sessions running anywhere" and for the nightly convergence card to
// refuse to restart a node that has a live session in the repo it is about to
// merge.
//
// What deliberately does NOT come here:
//   - transcripts, the single-writer session-log JSONL, the runner's ring buffer.
//     They are high-volume, they are only useful next to the live generation the
//     home node owns, and a proxy to `control_url` already reads them.
//   - permission decisions. Permission resolver closures are process-local by
//     design: a decision is forwarded synchronously to the home node while the
//     generation is open, or it is an honest 409. Storing one here would let a
//     stale decision be replayed against a generation that no longer exists.
//
// Every call is best-effort and bounded. A registry hiccup must never fail a
// turn, delay a turn, or crash the gateway — an unenrolled box must run exactly
// as it did before the mesh existed, which is why a failed discovery latches
// this module into a no-op after ONE warning instead of complaining per turn.

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createStateClient } from "./state-client.mjs";

// Short on purpose: this is metadata riding alongside a turn, never in front of
// one. The client's own single retry sits inside this budget.
const TIMEOUT_MS = 3000;

let cachedClient = null;
let disabled = false;
let warnedKind = null;
// Turns on the same run overlap (the lanes are concurrent), so "idle" is only
// true once the LAST open generation closes. A plain per-turn flip would report
// idle while another turn is still writing files — the one lie the convergence
// check cannot afford.
let openGenerations = 0;
let cachedControlUrl;

function warnOnce(kind, err) {
  if (warnedKind === kind) return;
  warnedKind = kind;
  console.warn(`[session-registry] ${kind}: ${err?.message ?? err}`);
}

/** The state client for this gateway process, or null when this node is not
 *  enrolled in a mesh. Latches: an unenrolled process stays a no-op. */
export function lazyClient() {
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

function garrisonHome() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

/** The web-channel fitting's own-port URL — the surface a peer proxies to for
 *  this node's threads, live SSE, inputs and interrupt.
 *
 *  NOTE it is a LOOPBACK url: own-port fittings bind 127.0.0.1, so a peer cannot
 *  dial it directly. The peer-facing proxy (phase 3) resolves the node's tailnet
 *  address from the node registry and rehosts this port there — which is why the
 *  port also rides in the session body. Recording a fabricated tailnet URL here
 *  would be worse: it would look reachable and silently 502. */
export function controlSurface() {
  if (cachedControlUrl !== undefined) return cachedControlUrl;
  try {
    const raw = readFileSync(path.join(garrisonHome(), "ui-fittings", "web-channel-default.json"), "utf8");
    const parsed = JSON.parse(raw);
    const url = typeof parsed?.url === "string" && parsed.url.trim() ? parsed.url.trim() : null;
    const port = Number.isFinite(Number(parsed?.port)) ? Number(parsed.port) : null;
    if (!url) return undefined; // web-channel not up yet — retry on the next call
    cachedControlUrl = { url, port };
    return cachedControlUrl;
  } catch {
    return undefined; // not up yet, or no such fitting: omit rather than guess
  }
}

// The service COALESCEs the promoted session columns but replaces `body` wholesale
// on every upsert — a status touch carrying no body would erase what announce put
// there. Keep the announced body here and resend it, so `body` behaves like the
// columns beside it instead of surviving only until the first touch.
const bodies = new Map();

function put(id, input) {
  const client = lazyClient();
  if (!client || !id) return Promise.resolve(null);
  const body = { ...(bodies.get(id) ?? {}), ...(input.body ?? {}) };
  bodies.set(id, body);
  return client.upsertSession(id, { ...input, body }).catch((err) => {
    warnOnce("write-failed", err);
    return null;
  });
}

/** Announce a run at spawn time. `id` is the gateway's run id. Returns a promise
 *  that NEVER rejects — call sites deliberately do not await it. */
export function announceSession({
  id,
  cardId = null,
  threadId = null,
  compositionId = null,
  runtime = null,
  model = null,
  account = null,
  cwd = null,
  status = "starting",
  controlUrl = undefined
} = {}) {
  const surface = controlUrl === undefined ? controlSurface() : { url: controlUrl, port: null };
  return put(id, {
    cardId,
    threadId,
    compositionId,
    runtime,
    model,
    account,
    cwd,
    status,
    startedAt: new Date().toISOString(),
    ...(surface?.url ? { controlUrl: surface.url } : {}),
    body: {
      ...(surface?.port ? { controlPort: surface.port } : {}),
      pid: process.pid
    }
  });
}

/** Set the run's status, optionally refreshing spawn-config metadata that was
 *  not knowable at announce time (the routed runtime, say). */
export function touchSession(id, status, patch = {}) {
  return put(id, { ...patch, status });
}

/** A generation opened on this run: the node is busy until the last one closes. */
export function openGeneration(id) {
  openGenerations += 1;
  return openGenerations === 1 ? touchSession(id, "running") : Promise.resolve(null);
}

/** A generation closed. Only the last one in flight returns the run to idle. */
export function closeGeneration(id) {
  openGenerations = Math.max(0, openGenerations - 1);
  return openGenerations === 0 ? touchSession(id, "idle") : Promise.resolve(null);
}

/** The run is over. `status` is "ended" for a clean shutdown, "failed" otherwise. */
export function endSession(id, status = "ended") {
  openGenerations = 0;
  const closing = put(id, { status, endedAt: new Date().toISOString() });
  bodies.delete(id);
  return closing;
}

/** Drop every cached decision (token rotation, tests). */
export function _resetForTests() {
  cachedClient = null;
  disabled = false;
  warnedKind = null;
  openGenerations = 0;
  cachedControlUrl = undefined;
  bodies.clear();
}

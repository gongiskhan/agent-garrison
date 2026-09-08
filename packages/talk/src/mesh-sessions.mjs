// The aggregated session list: this node's own Shells fitting index plus
// every mesh peer's published shells.sessions/node:<name> doc, one merged
// and sorted row set. Mirrors mesh-threads.mjs's shape (self identity, node
// registry, best-effort against an absent/unenrolled state service) but
// reads Rows, not thread indexes - see the shells decision doc section 2.2.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStateClient } from "@garrison/state-client";
import { listThreads } from "./threads.mjs";

const LOCAL_CACHE_MS = 2000;
const PEER_CACHE_MS = 5000;
const DEFAULT_ENDED_CAP_PER_NODE = Infinity;
const FETCH_TIMEOUT_MS = 2500;
const SNAPSHOT_STALE_MS = 90_000;

// Mirror of the shell's NODE_ACCENTS palette (src/lib/node-identity.ts),
// same duplication mesh-threads.mjs already carries.
const ACCENT_HEX = {
  moss: "#4a7d5f", fern: "#478529", brass: "#85763a", copper: "#a26949",
  rose: "#a7626b", plum: "#af5895", violet: "#8a62a7", steel: "#527c91"
};

function garrisonHome() {
  return process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function resolveAccent(raw) {
  const a = typeof raw === "string" ? raw.trim() : "";
  if (!a) return null;
  return a.startsWith("#") ? a : ACCENT_HEX[a] ?? null;
}

function selfName() {
  const env = process.env.GARRISON_NODE_NAME?.trim();
  if (env) return env;
  return readJsonSafe(path.join(garrisonHome(), "state.json"))?.node ?? null;
}

function selfIdentity() {
  const node = selfName();
  const accentColor = resolveAccent(readJsonSafe(path.join(garrisonHome(), "node.json"))?.accent);
  return { node, accentColor };
}

let cachedClient;
let clientFailed = false;
function client() {
  if (cachedClient || clientFailed) return cachedClient ?? null;
  try {
    cachedClient = createStateClient({
      env: { GARRISON_HOME: garrisonHome(), ...process.env },
      readFileSync: (p, enc) => readFileSync(p, enc),
      timeoutMs: 5000
    });
  } catch {
    clientFailed = true;
    return null;
  }
  return cachedClient;
}

function readLocalShellsInfo() {
  const file = path.join(garrisonHome(), "ui-fittings", "remote-shell-runtime.json");
  const info = readJsonSafe(file);
  return info?.url ? info : null;
}

let localCache = { at: 0, body: null, available: false, lastSuccessAt: 0 };
async function fetchLocalIndex(fetchImpl = fetch) {
  const now = Date.now();
  if (localCache.at && now - localCache.at < LOCAL_CACHE_MS) return localCache;
  const info = readLocalShellsInfo();
  let body = null;
  if (info?.url) {
    try {
      const res = await fetchImpl(`${info.url}/index`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const candidate = await res.json();
        if (Array.isArray(candidate?.rows)) body = candidate;
      } else await res.body?.cancel();
    } catch {
      body = null;
    }
  }
  // A timeout is not an empty index. Preserve its original freshness so a
  // retained working row eventually becomes unknown instead of spinning forever.
  localCache = body
    ? { at: now, body, available: true, lastSuccessAt: now }
    : { ...localCache, at: now, available: false };
  return localCache;
}

const peerCache = new Map(); // node -> {at, body}
async function fetchPeerIndex(c, node) {
  const cached = peerCache.get(node);
  const now = Date.now();
  if (cached && now - cached.at < PEER_CACHE_MS) return cached.body;
  let body = cached?.body ?? null;
  try {
    const doc = await c.getConfig("shells.sessions", `node:${node}`);
    if (!doc) body = null;
    else if (Array.isArray(doc.body?.rows)) body = doc.body;
  } catch { /* Retain the last successful snapshot during authority outages. */ }
  peerCache.set(node, { at: now, body });
  return body;
}

const VALID_STATUS = new Set(["working", "idle", "ended", "unknown"]);
let registryCache = [];

function withSnapshotStatus(row, snapshotAt) {
  const stale = !Number.isFinite(snapshotAt) || Date.now() - snapshotAt > SNAPSHOT_STALE_MS;
  return stale && row.status === "working"
    ? { ...row, status: "unknown", statusSource: "stale-node" }
    : row;
}

/** Tolerant of a legacy/foreign row shape - a peer runs whatever version of
 *  this fitting it runs, and a malformed row must be dropped, never thrown
 *  on. */
function normalizeRow(raw, node) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  const status = VALID_STATUS.has(raw.status)
    ? raw.status
    : raw.state === "running" ? "working" : raw.state === "idle" ? "idle" : "unknown";
  return { ...raw, status, node };
}

/** Resolve an indexed transcript on this owner only. Opening local output must
 * not wait for the authority, peer documents or conversation-thread binding.
 * A failed index read is distinct from a successful index without this id. */
export async function localSessionForStream(id, { fetchImpl = fetch, signal, timeoutMs = 5000 } = {}) {
  const self = selfIdentity();
  for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt += 1) {
    const info = readLocalShellsInfo();
    if (!info?.url) break;
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(`${info.url}/index`, {
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline
      });
      if (!response.ok) { await response.body?.cancel(); continue; }
      const body = await response.json();
      if (!Array.isArray(body?.rows)) continue;
      const row = body.rows.find((candidate) => candidate?.id === id);
      return { available: true, row: normalizeRow(row, self.node) };
    } catch { /* One retry covers a cold index or fitting restart. */ }
  }
  return { available: false, row: null };
}

/** @returns {{self, nodes, rows}} */
export async function meshSessions({ limitEndedPerNode = DEFAULT_ENDED_CAP_PER_NODE, fetchImpl = fetch } = {}) {
  const self = selfIdentity();
  const local = await fetchLocalIndex(fetchImpl);
  let localBody = local.body;
  let localSnapshotAt = Date.parse(localBody?.updatedAt) || local.lastSuccessAt;
  const c = client();
  if (!local.available && c && self.node) {
    // A cold/slow owner index can already have a healthy published snapshot.
    // Prefer newer publication over retained local data, without resurrecting
    // rows after a successful empty local read.
    const published = await fetchPeerIndex(c, self.node);
    const publishedAt = Date.parse(published?.updatedAt);
    if (published && (!localBody || publishedAt > localSnapshotAt)) {
      localBody = published;
      localSnapshotAt = publishedAt;
    }
  }
  const localRows = (localBody?.rows ?? [])
    .map((r) => normalizeRow(r, self.node))
    .filter(Boolean)
    .map((r) => ({ ...withSnapshotStatus(r, localSnapshotAt), nodeAccent: self.accentColor, nodeStatus: "active", shellOrigin: null }));

  const nodes = [{
    node: self.node,
    accentColor: self.accentColor,
    status: "active",
    lastSeenAt: null,
    shellOrigin: localBody?.shellOrigin?.public ?? null
  }];

  let peerRows = [];
  if (c && self.node) {
    let registry = registryCache;
    try {
      const latest = await c.listNodes();
      if (Array.isArray(latest)) registry = registryCache = latest;
    } catch { /* Failed discovery does not remove previously known owners. */ }
    await Promise.all(registry.map(async (peer) => {
      if (peer.name === self.node) return;
      const body = await fetchPeerIndex(c, peer.name);
      nodes.push({
        node: peer.name,
        accentColor: resolveAccent(peer.accentColor) ?? peer.accentColor ?? null,
        status: peer.status ?? "unknown",
        lastSeenAt: peer.lastSeenAt ?? null,
        shellOrigin: body?.shellOrigin?.public ?? null
      });
      const rows = (body?.rows ?? [])
        .map((r) => normalizeRow(r, peer.name))
        .filter(Boolean)
        .map((r) => ({
          ...withSnapshotStatus(r, Date.parse(body?.updatedAt)),
          nodeAccent: resolveAccent(peer.accentColor) ?? peer.accentColor ?? null,
          nodeStatus: peer.status ?? "unknown",
          shellOrigin: body?.shellOrigin?.public ?? null
        }));
      peerRows.push(...rows);
    }));
  }

  const cutoff = Date.now() - 5 * 86_400_000;
  let all = [...localRows, ...peerRows].filter((r) => r.status === "working" ||
    Date.parse(r.lastActivityAt ?? r.startedAt) >= cutoff);

  // Bind this node's wrapper threads to their exact shell on ANY node.
  // Native conversation identities remain owner-local.
  if (self.node) {
    const threads = await listThreads().catch(() => []);
    const byShellKey = new Map();
    const byClaudeSession = new Map();
    for (const t of threads) {
      if (t.shell?.transport && t.shell?.tmuxSession) {
        byShellKey.set(`${t.shell.node || self.node} ${t.shell.transport} ${t.shell.tmuxSession}`, t.id);
      }
      if (t.claudeSessionId) byClaudeSession.set(t.claudeSessionId, t.id);
    }
    all = all.map((r) => {
      if (r.kind === "shell" && r.shell?.transport && r.shell?.tmuxSession) {
        const tid = byShellKey.get(`${r.node} ${r.shell.transport} ${r.shell.tmuxSession}`);
        if (tid) return { ...r, threadId: tid };
      }
      if (r.node === self.node && r.runtime === "claude" && byClaudeSession.has(r.id)) {
        return { ...r, boundTo: { kind: "conversation", threadId: byClaudeSession.get(r.id) } };
      }
      return r;
    });
  }

  const rank = (status) => (status === "working" ? 0 : status === "idle" ? 1 : status === "unknown" ? 2 : 3);
  all.sort((a, b) => {
    const d = rank(a.status) - rank(b.status);
    if (d !== 0) return d;
    return (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0);
  });

  const endedPerNode = new Map();
  const rows = [];
  for (const r of all) {
    if (r.status === "ended") {
      const n = endedPerNode.get(r.node) ?? 0;
      if (n >= limitEndedPerNode) continue;
      endedPerNode.set(r.node, n + 1);
    }
    rows.push(r);
  }

  return { self, nodes, rows };
}

export function _resetCachesForTests() {
  localCache = { at: 0, body: null, available: false, lastSuccessAt: 0 };
  peerCache.clear();
  registryCache = [];
  cachedClient = undefined;
  clientFailed = false;
}

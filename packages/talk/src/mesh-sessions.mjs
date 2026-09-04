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
const DEFAULT_ENDED_CAP_PER_NODE = 20;
const FETCH_TIMEOUT_MS = 2500;

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

let localCache = { at: 0, body: null };
async function fetchLocalIndex(fetchImpl = fetch) {
  const now = Date.now();
  if (localCache.body && now - localCache.at < LOCAL_CACHE_MS) return localCache.body;
  const info = readLocalShellsInfo();
  let body = null;
  if (info?.url) {
    try {
      const res = await fetchImpl(`${info.url}/index`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) body = await res.json();
    } catch {
      body = null;
    }
  }
  localCache = { at: now, body };
  return body;
}

const peerCache = new Map(); // node -> {at, body}
async function fetchPeerIndex(c, node) {
  const cached = peerCache.get(node);
  const now = Date.now();
  if (cached && now - cached.at < PEER_CACHE_MS) return cached.body;
  let body = null;
  try {
    const doc = await c.getConfig("shells.sessions", `node:${node}`);
    body = doc?.body ?? null;
  } catch {
    body = null;
  }
  peerCache.set(node, { at: now, body });
  return body;
}

const VALID_STATUS = new Set(["working", "idle", "ended", "unknown"]);

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

/** @returns {{self, nodes, rows}} */
export async function meshSessions({ limitEndedPerNode = DEFAULT_ENDED_CAP_PER_NODE, fetchImpl = fetch } = {}) {
  const self = selfIdentity();
  const localBody = await fetchLocalIndex(fetchImpl);
  const localRows = (localBody?.rows ?? [])
    .map((r) => normalizeRow(r, self.node))
    .filter(Boolean)
    .map((r) => ({ ...r, nodeAccent: self.accentColor, nodeStatus: "active", shellOrigin: null }));

  const nodes = [{
    node: self.node,
    accentColor: self.accentColor,
    status: "active",
    lastSeenAt: null,
    shellOrigin: localBody?.shellOrigin?.public ?? null
  }];

  let peerRows = [];
  const c = client();
  if (c && self.node) {
    let registry = [];
    try {
      registry = await c.listNodes();
    } catch {
      registry = [];
    }
    for (const peer of registry) {
      if (peer.name === self.node) continue;
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
          ...r,
          nodeAccent: resolveAccent(peer.accentColor) ?? peer.accentColor ?? null,
          nodeStatus: peer.status ?? "unknown",
          shellOrigin: body?.shellOrigin?.public ?? null
        }));
      peerRows.push(...rows);
    }
  }

  let all = [...localRows, ...peerRows];

  // Bind LOCAL rows to a thread this node already owns - a peer's row can
  // only be bound by ITS OWN node (that is what publishes threadId into the
  // row before this node ever sees it).
  if (self.node) {
    const threads = await listThreads().catch(() => []);
    const byShellKey = new Map();
    const byClaudeSession = new Map();
    for (const t of threads) {
      if (t.shell?.transport && t.shell?.tmuxSession) {
        byShellKey.set(`${t.shell.transport} ${t.shell.tmuxSession}`, t.id);
      }
      if (t.claudeSessionId) byClaudeSession.set(t.claudeSessionId, t.id);
    }
    all = all.map((r) => {
      if (r.node !== self.node) return r;
      if (r.kind === "shell" && r.shell?.transport && r.shell?.tmuxSession) {
        const tid = byShellKey.get(`${r.shell.transport} ${r.shell.tmuxSession}`);
        if (tid) return { ...r, threadId: tid };
      }
      if (r.runtime === "claude" && byClaudeSession.has(r.id)) {
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
  localCache = { at: 0, body: null };
  peerCache.clear();
  cachedClient = undefined;
  clientFailed = false;
}

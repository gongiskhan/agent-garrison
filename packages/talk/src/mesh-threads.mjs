// Cross-node thread visibility for the Conversations sidebar.
//
// Every node's Conversations engine mirrors its thread INDEX into the state
// service (thread-registry.mjs, config doc "web-channel.threads"/"node:<name>").
// This module reads every OTHER node's index plus the node registry, and
// hands the UI ready-made rows: node identity + its recent threads + an
// openUrl on THIS node's shell (`/mesh/talk/<node>/<id>`), the page that frames
// the conversation from its home node. Conversations stay HOME-NODE-OWNED: the
// transcript renders from the node that holds it, never a proxy of the message
// bodies, but the window that shows it stays on its own origin.

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createStateClient } from "@garrison/state-client";

const CACHE_MS = 5000;

let cachedClient;
let clientFailed = false;
let cache = { at: 0, body: null };

function client() {
  if (cachedClient || clientFailed) return cachedClient ?? null;
  try {
    cachedClient = createStateClient({
      env: {
        GARRISON_HOME: process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"),
        ...process.env
      },
      readFileSync: (p, enc) => readFileSync(p, enc),
      timeoutMs: 5000
    });
  } catch {
    // Unenrolled box: the rail simply stays empty — never an error surface.
    clientFailed = true;
    return null;
  }
  return cachedClient;
}

function selfName() {
  const env = process.env.GARRISON_NODE_NAME?.trim();
  if (env) return env;
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    return JSON.parse(readFileSync(path.join(home, "state.json"), "utf8")).node ?? null;
  } catch {
    return null;
  }
}

// Mirror of the shell's NODE_ACCENTS palette (src/lib/node-identity.ts) so a
// node.json carrying a palette ID resolves to the same hex the shell paints.
const ACCENT_HEX = {
  moss: "#4a7d5f", fern: "#478529", brass: "#85763a", copper: "#a26949",
  rose: "#a7626b", plum: "#af5895", violet: "#8a62a7", steel: "#527c91"
};

// This node's own identity, so the unified session list can badge LOCAL rows
// with the same accent the node paints everywhere else. node.json may carry a
// raw hex or a palette id; resolve either. Absent file → null accent, and the
// UI falls back to a neutral dot.
function selfIdentity() {
  const name = selfName();
  let accent = null;
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const raw = JSON.parse(readFileSync(path.join(home, "node.json"), "utf8"));
    const a = typeof raw.accent === "string" ? raw.accent.trim() : "";
    accent = a.startsWith("#") ? a : ACCENT_HEX[a] ?? null;
  } catch {
    accent = null;
  }
  return { node: name, accentColor: accent };
}

// Only node-registry addresses are eligible; no user-supplied URL is fetched.
export function peerThreadsOrigin(peer) {
  try {
    const origin = peer.health?.node?.appOrigin;
    if (origin && new URL(origin).protocol === "https:") return new URL(origin).origin;
  } catch { /* fall through */ }
  const host = String(peer.tailnetHost ?? "").trim().replace(/\.$/, "");
  return /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : null;
}

export async function meshThreads({ limitPerNode = 2000, fetchImpl = fetch } = {}) {
  const now = Date.now();
  if (cache.body && now - cache.at < CACHE_MS) return cache.body;
  const self0 = selfIdentity();
  const c = client();
  if (!c) return { self: self0, nodes: [] };
  const self = self0.node;

  const registry = await c.listNodes();
  const peers = registry.filter((n) => n.name !== self);
  const nodes = [];
  await Promise.all(peers.map(async (peer) => {
    let threads = [];
    try {
      const doc = await c.getConfig("web-channel.threads", `node:${peer.name}`);
      threads = (doc?.body?.threads ?? []).slice(0, limitPerNode);
    } catch {
      threads = [];
    }
    // The durable index is the outage fallback. Running state is process-local
    // and must come from the owner's live metadata endpoint, which never
    // returns transcript/message bodies and does not recurse into meshThreads.
    let live = false;
    const origin = peerThreadsOrigin(peer);
    if (origin) {
      try {
        const res = await fetchImpl(`${origin}/api/threads`, { signal: AbortSignal.timeout(4000), redirect: "error" });
        if (res.ok) {
          const body = await res.json();
          if (Array.isArray(body?.threads)) { threads = body.threads; live = true; }
        }
      } catch { /* an unreachable node remains visible without a false spinner */ }
    }
    const cutoff = now - 5 * 86_400_000;
    threads = threads.filter((t) => t.runningSince || Date.parse(t.updatedAt ?? t.lastMessageAt ?? t.createdAt) >= cutoff)
      .sort((a, b) => Number(Boolean(b.runningSince)) - Number(Boolean(a.runningSince)) ||
        Date.parse(b.updatedAt ?? b.lastMessageAt ?? "0") - Date.parse(a.updatedAt ?? a.lastMessageAt ?? "0"))
      .slice(0, limitPerNode);
    // A TETHERED peer (csg) has no tailnetHost at all - its appOrigin (carried
    // through the beat's health.node.appOrigin) is its only real address, so
    // it must not be skipped just for lacking a tailnetHost.
    const appOrigin = peer.health?.node?.appOrigin ?? null;
    if (!peer.tailnetHost && !appOrigin && threads.length === 0) return;
    // Rows open THIS node's /mesh/talk/<node>/<id> page, which frames the
    // conversation on its home node. The top window never leaves this origin:
    // a cross-origin top-level load is a new tab on a phone browser, a Safari
    // hand-off in the Garrison app, and a scope exit for a Home Screen install.
    // The page resolves the node's tailnet host (or, for a tethered node, its
    // appOrigin) from the roster and says so when it has neither.
    const base = `/mesh/talk/${encodeURIComponent(peer.name)}`;
    nodes.push({
      node: peer.name,
      accentColor: peer.accentColor ?? null,
      status: peer.status,
      connection: live ? "connected" : "disconnected",
      lastSeenAt: peer.lastSeenAt ?? null,
      openBase: base,
      threads: threads.map((t) => ({
        id: t.id,
        title: t.title ?? null,
        lastMessageAt: t.updatedAt ?? t.lastMessageAt ?? null,
        runningSince: live ? t.runningSince ?? null : null,
        source: t.source ?? null,
        messageCount: t.messageCount ?? null,
        openUrl: `${base}/${encodeURIComponent(t.id)}`
      }))
    });
  }));
  nodes.sort((a, b) => a.node.localeCompare(b.node));
  const body = { self: self0, nodes };
  cache = { at: now, body };
  return body;
}

export function _resetCachesForTests() {
  cachedClient = undefined;
  clientFailed = false;
  cache = { at: 0, body: null };
}

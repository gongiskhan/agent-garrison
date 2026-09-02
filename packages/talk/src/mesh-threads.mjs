// Cross-node thread visibility for the Conversations sidebar.
//
// Every node's Conversations engine mirrors its thread INDEX into the state
// service (thread-registry.mjs, config doc "web-channel.threads"/"node:<name>").
// This module reads every OTHER node's index plus the node registry, and
// hands the UI ready-made rows: node identity + its recent threads + an
// absolute openUrl on that node's own app (`/talk/<id>` on the peer's tailnet
// origin, computable without asking the peer). Conversations stay
// HOME-NODE-OWNED: opening one is a cross-origin navigation to the node that
// holds the transcript, never a proxy of the message bodies.

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createStateClient } from "@garrison/state-client";

const CACHE_MS = 20_000;

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

export async function meshThreads({ limitPerNode = 8 } = {}) {
  const now = Date.now();
  if (cache.body && now - cache.at < CACHE_MS) return cache.body;
  const self0 = selfIdentity();
  const c = client();
  if (!c) return { self: self0, nodes: [] };
  const self = self0.node;

  const registry = await c.listNodes();
  const peers = registry.filter((n) => n.name !== self);
  const nodes = [];
  for (const peer of peers) {
    let threads = [];
    try {
      const doc = await c.getConfig("web-channel.threads", `node:${peer.name}`);
      threads = (doc?.body?.threads ?? []).slice(0, limitPerNode);
    } catch {
      threads = [];
    }
    if (!peer.tailnetHost && threads.length === 0) continue;
    const base = peer.tailnetHost ? `https://${peer.tailnetHost.replace(/\.$/, "")}` : null;
    nodes.push({
      node: peer.name,
      accentColor: peer.accentColor ?? null,
      status: peer.status,
      lastSeenAt: peer.lastSeenAt ?? null,
      openBase: base,
      threads: threads.map((t) => ({
        id: t.id,
        title: t.title ?? null,
        lastMessageAt: t.lastMessageAt ?? null,
        messageCount: t.messageCount ?? null,
        openUrl: base ? `${base}/talk/${encodeURIComponent(t.id)}` : null
      }))
    });
  }
  const body = { self: self0, nodes };
  cache = { at: now, body };
  return body;
}

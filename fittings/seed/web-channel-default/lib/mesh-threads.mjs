// Cross-node thread visibility for the web channel sidebar.
//
// Every node's web channel mirrors its thread INDEX into the state service
// (thread-registry.mjs, config doc "web-channel.threads"/"node:<name>").
// This module reads every OTHER node's index plus the node registry, and
// hands the UI ready-made rows: node identity + its recent threads + an
// absolute openUrl on that node's own web channel (the serve-port formula is
// a mesh invariant, so the URL is computable without asking the peer).
// Conversations stay HOME-NODE-OWNED: opening one is a cross-origin
// navigation to the node that holds the transcript, never a proxy of the
// message bodies.

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createStateClient } from "./state-client.mjs";

const WEB_CHANNEL_BASE_PORT = 8083;
const SERVE_PORT = 8400 + (WEB_CHANNEL_BASE_PORT % 1000);
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

export async function meshThreads({ limitPerNode = 8 } = {}) {
  const now = Date.now();
  if (cache.body && now - cache.at < CACHE_MS) return cache.body;
  const c = client();
  if (!c) return { nodes: [] };
  const self = selfName();

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
    const base = peer.tailnetHost ? `https://${peer.tailnetHost}:${SERVE_PORT}` : null;
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
        openUrl: base ? `${base}/?thread=${encodeURIComponent(t.id)}` : null
      }))
    });
  }
  const body = { nodes };
  cache = { at: now, body };
  return body;
}

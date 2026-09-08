// This node's identity for the shells surface: its name (for the state
// service scope and the Row.node field) and the origin the browser should
// use to reach this fitting from ANOTHER node's page.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { garrisonHome } from "./transports.mjs";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** GARRISON_NODE_NAME, else $GARRISON_HOME/state.json's own node field, else
 *  node.json's id, else the OS hostname - the same precedence the mesh's own
 *  discoverStateConfig()/node identity readers use elsewhere. */
export function nodeName(env = process.env) {
  const fromEnv = env.GARRISON_NODE_NAME?.trim();
  if (fromEnv) return fromEnv;
  const home = garrisonHome(env);
  const state = readJson(path.join(home, "state.json"));
  if (typeof state?.node === "string" && state.node.trim()) return state.node.trim();
  const node = readJson(path.join(home, "node.json"));
  if (typeof node?.id === "string" && node.id.trim()) return node.id.trim();
  return os.hostname();
}

// The mesh serve-port invariant (8400 + localPort % 1000) is authoritative in
// scripts/tailnet-serve-views.mjs (see tests/mesh-serve-ports.test.ts); this
// is the one OTHER place that formula appears, kept as a single literal.
function servePort(port) {
  return 8400 + (Number(port) % 1000);
}

/**
 * Where a browser on ANOTHER node should reach this fitting.
 * `node.json.shellOrigin` (an explicit override, e.g. for a tethered node
 * with no tailnet host of its own) wins; otherwise a tailnetHost node
 * computes the serve-port pair; a node with neither publishes no public
 * origin (peers can still reach it once one exists).
 */
export function shellOrigin(env = process.env, { port } = {}) {
  const home = garrisonHome(env);
  const node = readJson(path.join(home, "node.json"));
  const loopback = `http://127.0.0.1:${port}`;
  if (typeof node?.shellOrigin === "string" && node.shellOrigin.trim()) {
    return { loopback, public: node.shellOrigin.trim() };
  }
  if (typeof node?.tailnetHost === "string" && node.tailnetHost.trim()) {
    return { loopback, public: `https://${node.tailnetHost.trim()}:${servePort(port)}` };
  }
  return { loopback, public: null };
}

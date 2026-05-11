#!/usr/bin/env node
// Garrison Outpost host — accepts WebSocket connections from garrison-outpost-bridge
// daemons running on remote Macs. Manages auth, event buffering, and blocking RPC relay.
//
// HTTP (0.0.0.0:3702):
//   GET  /health                   → { ok, outposts: [{name, connected, lastHeartbeat}] }
//   GET  /outposts                 → [{name, connected, lastHeartbeat, events}]
//   POST /registry/register        → { name, token } → register or update outpost in registry
//   DELETE /registry/:name         → unregister and disconnect outpost
//   POST /outposts/:name/rpc       → { type, payload } → blocking RPC call to bridge
//
// WebSocket: ws://0.0.0.0:3702/bridge (bridge connects out to this)

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const PORT = parseInt(process.env.GARRISON_OUTPOST_PORT || "3702", 10);
const BIND = process.env.GARRISON_OUTPOST_BIND || "0.0.0.0";
const PROTOCOL_VERSION = 1;
const AUTH_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 10_000;
const EVENT_RING_SIZE = 50;

const GARRISON_DIR = join(homedir(), ".garrison");
const REGISTRY_PATH = join(GARRISON_DIR, "outpost-registry.json");

// Active WS connections — removed on disconnect
// Map<name, { ws, lastHeartbeat, pendingRpcs: Map<id, {resolve,reject,timer}> }>
const connections = new Map();

// Event history per outpost — persists across reconnects
// Map<name, {type, payload, receivedAt}[]>
const eventHistory = new Map();

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function loadRegistry() {
  try {
    if (!existsSync(REGISTRY_PATH)) return { outposts: [] };
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return { outposts: [] };
  }
}

function saveRegistry(reg) {
  mkdirSync(GARRISON_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), { mode: 0o600 });
}

function findByToken(token) {
  return loadRegistry().outposts.find((o) => o.token === token);
}

function registerOutpost(name, token) {
  const reg = loadRegistry();
  const idx = reg.outposts.findIndex((o) => o.name === name);
  const entry = { name, token, registeredAt: new Date().toISOString() };
  if (idx >= 0) reg.outposts[idx] = entry;
  else reg.outposts.push(entry);
  saveRegistry(reg);
  return entry;
}

function unregisterOutpost(name) {
  const reg = loadRegistry();
  const before = reg.outposts.length;
  reg.outposts = reg.outposts.filter((o) => o.name !== name);
  if (reg.outposts.length < before) saveRegistry(reg);
  return reg.outposts.length < before;
}

// ---------------------------------------------------------------------------
// Event history helpers
// ---------------------------------------------------------------------------

function pushEvent(name, frame) {
  if (!eventHistory.has(name)) eventHistory.set(name, []);
  const ring = eventHistory.get(name);
  ring.push({ ...frame, receivedAt: new Date().toISOString() });
  if (ring.length > EVENT_RING_SIZE) ring.shift();
}

function getStatusList() {
  return loadRegistry().outposts.map((entry) => {
    const conn = connections.get(entry.name);
    return {
      name: entry.name,
      registeredAt: entry.registeredAt,
      connected: !!conn,
      lastHeartbeat: conn?.lastHeartbeat ?? null,
      events: eventHistory.get(entry.name) ?? [],
    };
  });
}

// ---------------------------------------------------------------------------
// WebSocket bridge handler
// ---------------------------------------------------------------------------

function handleBridgeConnection(ws) {
  let connName = null;
  let authed = false;

  const send = (frame) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(frame));
  };

  const authTimer = setTimeout(() => {
    if (!authed) {
      console.log("[outpost-host] auth timeout — closing unauthenticated connection");
      ws.close(1008, "auth timeout");
    }
  }, AUTH_TIMEOUT_MS);

  ws.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (!authed) {
      if (frame.type !== "auth") {
        send({ version: 1, type: "error", payload: { code: "unauthorized", message: "auth required" } });
        ws.close(1008, "auth required");
        clearTimeout(authTimer);
        return;
      }
      const { token, machine_name } = frame.payload ?? {};
      const entry = findByToken(token);
      if (!entry || entry.name !== machine_name) {
        console.warn(`[outpost-host] auth rejected for machine_name=${machine_name}`);
        send({ version: 1, type: "error", payload: { code: "unauthorized", message: "bad token" } });
        ws.close(1008, "unauthorized");
        clearTimeout(authTimer);
        return;
      }

      clearTimeout(authTimer);
      connName = machine_name;
      authed = true;

      const isReconnect = connections.has(connName);
      connections.set(connName, {
        ws,
        lastHeartbeat: new Date().toISOString(),
        pendingRpcs: new Map(),
      });

      send({
        version: 1,
        type: "auth_ok",
        payload: { protocol_version: PROTOCOL_VERSION, machine_name: "garrison-host" },
      });

      if (isReconnect) {
        pushEvent(connName, { type: "connection.reconnected", payload: {} });
      }
      console.log(`[outpost-host] authenticated: ${connName}${isReconnect ? " (reconnect)" : ""}`);
      return;
    }

    const conn = connections.get(connName);
    if (!conn) return;

    if (frame.type === "connection.heartbeat") {
      conn.lastHeartbeat = new Date().toISOString();
      return;
    }

    // Resolve pending RPC if this frame has a matching id
    if (frame.id && conn.pendingRpcs.has(frame.id)) {
      const rpc = conn.pendingRpcs.get(frame.id);
      conn.pendingRpcs.delete(frame.id);
      clearTimeout(rpc.timer);
      rpc.resolve(frame);
      return;
    }

    pushEvent(connName, frame);
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (!connName) return;
    console.log(`[outpost-host] disconnected: ${connName}`);
    const conn = connections.get(connName);
    if (conn?.ws === ws) {
      // Reject any pending RPCs
      for (const rpc of conn.pendingRpcs.values()) {
        clearTimeout(rpc.timer);
        rpc.reject(new Error("bridge disconnected"));
      }
      connections.delete(connName);
    }
  });

  ws.on("error", (err) => {
    console.error(`[outpost-host] ws error (${connName ?? "unauthed"}):`, err.message);
  });
}

// ---------------------------------------------------------------------------
// RPC relay (blocking)
// ---------------------------------------------------------------------------

function callRpc(name, type, payload) {
  return new Promise((resolve, reject) => {
    const conn = connections.get(name);
    if (!conn || conn.ws.readyState !== 1) {
      return reject(new Error(`outpost '${name}' not connected`));
    }
    const id = `rpc-${randomBytes(4).toString("hex")}`;
    const timer = setTimeout(() => {
      conn.pendingRpcs.delete(id);
      reject(new Error(`RPC timeout after ${RPC_TIMEOUT_MS}ms`));
    }, RPC_TIMEOUT_MS);
    conn.pendingRpcs.set(id, { resolve, reject, timer });
    conn.ws.send(JSON.stringify({ version: 1, type, id, payload: payload ?? {} }));
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      try {
        resolve(chunks ? JSON.parse(chunks) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  if (method === "GET" && (path === "/health" || path === "/")) {
    const outposts = getStatusList().map((o) => ({
      name: o.name,
      connected: o.connected,
      lastHeartbeat: o.lastHeartbeat,
    }));
    return json(res, 200, { ok: true, outposts });
  }

  if (method === "GET" && path === "/outposts") {
    return json(res, 200, { outposts: getStatusList() });
  }

  if (method === "POST" && path === "/registry/register") {
    try {
      const body = await parseBody(req);
      const { name, token } = body;
      if (!name || !token) return json(res, 400, { error: "name and token required" });
      const entry = registerOutpost(name, token);
      return json(res, 200, { ok: true, entry });
    } catch (err) {
      return json(res, 400, { error: String(err) });
    }
  }

  const deleteMatch = path.match(/^\/registry\/(.+)$/);
  if (method === "DELETE" && deleteMatch) {
    const name = decodeURIComponent(deleteMatch[1]);
    const conn = connections.get(name);
    if (conn?.ws) {
      for (const rpc of conn.pendingRpcs.values()) {
        clearTimeout(rpc.timer);
        rpc.reject(new Error("outpost unregistered"));
      }
      conn.ws.close(1001, "unregistered");
    }
    connections.delete(name);
    eventHistory.delete(name);
    const removed = unregisterOutpost(name);
    return json(res, 200, { ok: true, removed });
  }

  const rpcMatch = path.match(/^\/outposts\/(.+)\/rpc$/);
  if (method === "POST" && rpcMatch) {
    const name = decodeURIComponent(rpcMatch[1]);
    try {
      const body = await parseBody(req);
      const { type, payload } = body;
      if (!type) return json(res, 400, { error: "type required" });
      const result = await callRpc(name, type, payload);
      return json(res, 200, { ok: true, result });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  return json(res, 404, { error: "not found" });
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/bridge") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleBridgeConnection(ws);
  });
});

httpServer.listen(PORT, BIND, () => {
  const addr = httpServer.address();
  const port = typeof addr === "object" ? addr?.port : PORT;
  console.log(`[outpost-host] listening on ${BIND}:${port}`);
  console.log(`[outpost-host] registry: ${REGISTRY_PATH}`);
  console.log(`[outpost-host] bridges connect to ws://<this-host>:${port}/bridge`);
});

process.on("SIGINT", () => {
  httpServer.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  httpServer.close();
  process.exit(0);
});

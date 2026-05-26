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
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
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
const PID_FILE = join(GARRISON_DIR, "outpost-host.pid");

// Active WS connections — removed on disconnect
// Map<name, { ws, lastHeartbeat, pendingRpcs: Map<id, {resolve,reject,timer}> }>
const connections = new Map();

// Event history per outpost — persists across reconnects
// Map<name, {type, payload, receivedAt}[]>
const eventHistory = new Map();

// Per-handle subscriber WS connections — persists across bridge disconnect
// Map<outpostName, Map<handle, Set<ws>>>
const outpostSubscribers = new Map();

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
        // Notify process subscribers that the bridge is back online
        const subsByHandle = outpostSubscribers.get(connName);
        if (subsByHandle) {
          const msg = JSON.stringify({ type: "bridge_reconnected" });
          for (const subs of subsByHandle.values()) {
            for (const sub of subs) {
              if (sub.readyState === 1) sub.send(msg);
            }
          }
        }
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

    // Fan out process.output / process.exit to per-handle subscribers
    if (frame.payload?.handle &&
        (frame.type === "process.output" || frame.type === "process.exit")) {
      const subsByHandle = outpostSubscribers.get(connName);
      const subs = subsByHandle?.get(frame.payload.handle);
      if (subs && subs.size > 0) {
        const msg = JSON.stringify(frame);
        for (const sub of subs) {
          if (sub.readyState === 1) sub.send(msg);
        }
        if (frame.type === "process.exit") subsByHandle.delete(frame.payload.handle);
        return;
      }
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
      // Notify process subscribers that the bridge is offline
      const subsByHandle = outpostSubscribers.get(connName);
      if (subsByHandle) {
        const msg = JSON.stringify({ type: "bridge_disconnected" });
        for (const subs of subsByHandle.values()) {
          for (const sub of subs) {
            if (sub.readyState === 1) sub.send(msg);
          }
        }
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[outpost-host] ws error (${connName ?? "unauthed"}):`, err.message);
  });
}

// ---------------------------------------------------------------------------
// Subscriber connection handler — ws://host:3702/outposts/:name/io
// Spawns a PTY on the named outpost and brokers I/O between the subscriber
// and the bridge. Each subscriber WS maps to exactly one process handle.
// ---------------------------------------------------------------------------

function handleSubscriberConnection(ws, outpostName) {
  let handle = null;
  let spawned = false;

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  const registerSub = () => {
    if (!outpostSubscribers.has(outpostName)) outpostSubscribers.set(outpostName, new Map());
    const byHandle = outpostSubscribers.get(outpostName);
    if (!byHandle.has(handle)) byHandle.set(handle, new Set());
    byHandle.get(handle).add(ws);
  };

  const unregisterSub = () => {
    if (!handle) return;
    const byHandle = outpostSubscribers.get(outpostName);
    if (!byHandle) return;
    const subs = byHandle.get(handle);
    if (subs) {
      subs.delete(ws);
      if (subs.size === 0) byHandle.delete(handle);
    }
  };

  ws.on("message", async (data, isBinary) => {
    if (!spawned) {
      // First frame: spawn request JSON
      let req;
      try {
        req = JSON.parse(data.toString("utf8"));
      } catch {
        send({ type: "spawn_error", code: "invalid_payload", message: "expected JSON spawn frame" });
        ws.close();
        return;
      }

      if (req.type !== "spawn") {
        send({ type: "spawn_error", code: "invalid_payload", message: `expected type=spawn, got ${req.type}` });
        ws.close();
        return;
      }

      const conn = connections.get(outpostName);
      if (!conn || conn.ws.readyState !== 1) {
        send({ type: "spawn_error", code: "not_connected", message: `outpost '${outpostName}' not connected` });
        ws.close();
        return;
      }

      let result;
      try {
        result = await callRpc(outpostName, "process.spawn", {
          command: req.command || "/bin/zsh",
          args: req.args ?? [],
          cwd: req.cwd ?? undefined,
          env: req.env ?? {},
          pty: true,
          cols: req.cols ?? 80,
          rows: req.rows ?? 24,
        });
      } catch (err) {
        send({ type: "spawn_error", code: "operation_failed", message: err.message });
        ws.close();
        return;
      }

      // Bridge uses type "process.spawn.ok" (not in spec, but is the actual wire format)
      if (result.type === "error" || result.payload?.code) {
        send({ type: "spawn_error", code: result.payload?.code ?? "operation_failed", message: result.payload?.message ?? "spawn failed" });
        ws.close();
        return;
      }

      handle = result.payload?.handle;
      if (!handle) {
        send({ type: "spawn_error", code: "operation_failed", message: "bridge returned no handle" });
        ws.close();
        return;
      }

      spawned = true;
      registerSub();
      send({ type: "spawn_ok", handle });
      console.log(`[outpost-host] subscriber spawned handle=${handle} on outpost=${outpostName}`);
      return;
    }

    // Post-spawn: binary = stdin bytes, JSON = control frames
    if (!handle) return;

    if (isBinary) {
      // Raw bytes from the terminal — base64-encode for the bridge
      const b64 = data.toString("base64");
      callRpc(outpostName, "process.send_input", { handle, data: b64 }).catch((err) => {
        console.error(`[outpost-host] send_input error (${handle}):`, err.message);
      });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (msg.type === "resize") {
      callRpc(outpostName, "process.resize", { handle, cols: msg.cols, rows: msg.rows }).catch((err) => {
        console.error(`[outpost-host] resize error (${handle}):`, err.message);
      });
    } else if (msg.type === "kill") {
      callRpc(outpostName, "process.kill", { handle, signal: msg.signal ?? "SIGTERM" }).catch(() => {});
    }
  });

  ws.on("close", () => {
    unregisterSub();
    // Do not kill the remote PTY on subscriber disconnect — trenches-ws owns reaping policy.
    if (handle) console.log(`[outpost-host] subscriber detached handle=${handle}`);
  });

  ws.on("error", (err) => {
    console.error(`[outpost-host] subscriber ws error (${outpostName}/${handle ?? "unspawned"}):`, err.message);
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

const ioPathRe = /^\/outposts\/(.+)\/io$/;

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/bridge") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleBridgeConnection(ws);
    });
    return;
  }

  const ioMatch = url.pathname.match(ioPathRe);
  if (ioMatch) {
    const outpostName = decodeURIComponent(ioMatch[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleSubscriberConnection(ws, outpostName);
    });
    return;
  }

  socket.destroy();
});

// Lookup the PID currently holding our TCP port (best-effort, macOS/Linux only).
function findPortHolder(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split(/\s+/).filter(Boolean).map((n) => parseInt(n, 10))[0] || null;
  } catch {
    return null;
  }
}

// Read recorded PID file; returns null if missing/unreadable.
function readPidFile() {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePidFile() {
  try {
    mkdirSync(GARRISON_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  } catch (err) {
    console.warn(`[outpost-host] could not write PID file ${PID_FILE}: ${err.message}`);
  }
}

function clearPidFile() {
  try {
    const recorded = readPidFile();
    if (recorded === process.pid) unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

// Resilience: bind failures should not take down the rest of Garrison.
// Concurrently was previously launched with --kill-others-on-fail; a non-zero
// exit here would kill the Next dev server. We exit 0 on EADDRINUSE so the
// main UI keeps running, but log loudly so the user can fix the conflict.
httpServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    const holder = findPortHolder(PORT);
    const recordedPid = readPidFile();
    const recordedAlive = pidAlive(recordedPid);
    console.error("");
    console.error(`[outpost-host] PORT ${PORT} IS ALREADY IN USE — this instance will not start.`);
    if (holder) {
      console.error(`[outpost-host]   port held by PID ${holder}`);
    }
    if (recordedPid) {
      if (recordedAlive && recordedPid === holder) {
        console.error(`[outpost-host]   that PID matches the recorded outpost-host PID — another instance is already running, nothing to do.`);
      } else if (recordedAlive) {
        console.error(`[outpost-host]   recorded outpost-host PID ${recordedPid} is alive but does NOT hold the port — the port is held by something else.`);
      } else {
        console.error(`[outpost-host]   recorded outpost-host PID ${recordedPid} is gone; PID file is stale and will be cleaned up.`);
        try { unlinkSync(PID_FILE); } catch {}
      }
    }
    console.error(`[outpost-host]   to free the port:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN  then  kill <pid>`);
    console.error(`[outpost-host]   Garrison's main UI will continue without the outpost host.`);
    console.error("");
    process.exit(0); // graceful — keep concurrently siblings alive
  }
  console.error(`[outpost-host] fatal http error:`, err);
  clearPidFile();
  process.exit(1);
});

// Pre-flight: if we have a recorded PID that's alive and holds the port, defer
// before we even attempt to bind. This avoids the noisy EADDRINUSE stack trace
// for the most common case (the previous instance is still healthy).
{
  const recordedPid = readPidFile();
  if (pidAlive(recordedPid)) {
    const holder = findPortHolder(PORT);
    if (recordedPid === holder) {
      console.log(`[outpost-host] another outpost-host is already running on ${BIND}:${PORT} (PID ${recordedPid}); exiting cleanly.`);
      process.exit(0);
    }
  }
}

httpServer.listen(PORT, BIND, () => {
  const addr = httpServer.address();
  const port = typeof addr === "object" ? addr?.port : PORT;
  writePidFile();
  console.log(`[outpost-host] listening on ${BIND}:${port} (pid ${process.pid})`);
  console.log(`[outpost-host] registry: ${REGISTRY_PATH}`);
  console.log(`[outpost-host] bridges connect to ws://<this-host>:${port}/bridge`);
});

function shutdown(signal) {
  console.log(`[outpost-host] received ${signal}, shutting down`);
  clearPidFile();
  httpServer.close(() => process.exit(0));
  // Hard-stop fallback if close() hangs on open WS sockets
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", clearPidFile);

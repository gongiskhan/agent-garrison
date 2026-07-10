#!/usr/bin/env node
// Garrison Outpost host — accepts WebSocket connections from garrison-outpost-bridge
// daemons running on remote Macs. Manages auth, event buffering, and blocking RPC relay.
//
// HTTP (0.0.0.0:3702):
//   GET  /health                   → { ok, outposts: [{name, connected, lastHeartbeat}] }
//   GET  /outposts                 → { outposts: [{name, connected, lastHeartbeat, agentVersion,
//                                       pending, verbs, events, …}] }
//   GET  /outposts/:name/log?limit → { ok, entries: [...] } last N invocation-log entries
//   GET  /install.sh               → the one-line-installer bootstrap script (text/plain)
//   POST /registry/register        → { name, token } → register or update outpost in registry
//   POST /registry/pair            → { name } → mint a token + return the one-line installer
//   DELETE /registry/:name         → unregister and disconnect outpost
//   POST /outposts/:name/rpc       → { type, payload } → blocking RPC call to bridge (logged)
//
// WebSocket: ws://0.0.0.0:3702/bridge (bridge connects out to this)
//
// The module exports startHost({ port, bind }) so it can be booted on an ephemeral port
// in tests; run directly it starts the singleton daemon (PID file + graceful port guard).

import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = parseInt(process.env.GARRISON_OUTPOST_PORT || "3702", 10);
// Secure by default: bind LOOPBACK, not 0.0.0.0. The daemon's HTTP API relays
// exec.run to connected Mac bridges (RCE-to-Mac) and mutates the registry, all
// unauthenticated; 0.0.0.0 exposed that on every interface (the public GCP one
// included), so anyone on the LAN/tailnet could pair + relay commands. The local
// UI proxy reaches it on 127.0.0.1; pairing a REMOTE Mac requires the operator to
// opt into a tailnet bind explicitly via GARRISON_OUTPOST_BIND=<tailnet-ip>.
const BIND = process.env.GARRISON_OUTPOST_BIND || "127.0.0.1";
const PROTOCOL_VERSION = 1;
const AUTH_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 10_000;
const EVENT_RING_SIZE = 50;

// The static protocol verb catalog surfaced per outpost (GET /outposts entries).
// These are the verbs the bridge implements and this host relays — kept in sync by
// hand with the bridge, honest about what a caller can actually invoke.
const PROTOCOL_VERBS = Object.freeze([
  "exec.run",
  "fs.read",
  "fs.write",
  "fs.list",
  "process.spawn",
  "process.send_input",
  "process.resize",
  "process.kill",
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = join(HERE, "bootstrap-outpost.sh");

// Paths are resolved dynamically (not frozen at import time) so a test can point
// GARRISON_HOME at a sandbox before calling the exported helpers.
function garrisonHome() {
  return process.env.GARRISON_HOME || join(homedir(), ".garrison");
}
function registryPath() {
  return join(garrisonHome(), "outpost-registry.json");
}
function pidFilePath() {
  return join(garrisonHome(), "outpost-host.pid");
}
function invocationLogDir() {
  return join(garrisonHome(), "outposts", "log");
}

// The port this instance actually bound (set on listen). Used to build the pairing
// installer line so it points at the port the host is really serving on.
let livePort = PORT;

// Active WS connections — removed on disconnect
// Map<name, { ws, lastHeartbeat, agentVersion, hostname, tailscaleIp, pendingRpcs: Map<id, {resolve,reject,timer}> }>
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
    if (!existsSync(registryPath())) return { outposts: [] };
    return JSON.parse(readFileSync(registryPath(), "utf8"));
  } catch {
    return { outposts: [] };
  }
}

function saveRegistry(reg) {
  mkdirSync(garrisonHome(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(reg, null, 2), { mode: 0o600 });
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

// Mint a pairing token for a NEW (or re-paired) Mac. The entry is stored `pending: true`
// until a bridge authenticates with the token, at which point clearPending() flips it.
export function mintPairing(name) {
  const reg = loadRegistry();
  const token = randomBytes(24).toString("hex");
  const idx = reg.outposts.findIndex((o) => o.name === name);
  const entry = { name, token, registeredAt: new Date().toISOString(), pending: true };
  if (idx >= 0) reg.outposts[idx] = { ...reg.outposts[idx], ...entry };
  else reg.outposts.push(entry);
  saveRegistry(reg);
  return entry;
}

// A bridge authed with a pending token → the pairing completed. Drop the flag.
function clearPending(name) {
  const reg = loadRegistry();
  const entry = reg.outposts.find((o) => o.name === name);
  if (entry && entry.pending) {
    delete entry.pending;
    saveRegistry(reg);
  }
}

function unregisterOutpost(name) {
  const reg = loadRegistry();
  const before = reg.outposts.length;
  reg.outposts = reg.outposts.filter((o) => o.name !== name);
  if (reg.outposts.length < before) saveRegistry(reg);
  return reg.outposts.length < before;
}

// ---------------------------------------------------------------------------
// Invocation log — file-per-day JSONL under ~/.garrison/outposts/log/
// ---------------------------------------------------------------------------

function dayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Record ONE relayed RPC. O_APPEND on the same filesystem is atomic for a single
// short line, so a serialized-line append needs no lock. Best-effort: a logging
// failure must never fail the RPC it describes.
export function logInvocation(entry) {
  try {
    const dir = invocationLogDir();
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    appendFileSync(join(dir, `${dayStamp()}.jsonl`), line);
  } catch {
    // logging is diagnostic only — swallow
  }
}

function readLogFile(stamp) {
  try {
    const file = join(invocationLogDir(), `${stamp}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// The last `limit` invocation-log entries for one outpost, chronological (oldest→newest).
// Reads today's file plus yesterday's so a query just after midnight still tails the
// recent history.
export function readInvocationLog(name, limit = 20) {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const all = [...readLogFile(dayStamp(yesterday)), ...readLogFile(dayStamp(now))];
  const mine = all.filter((e) => e && e.outpost === name);
  const n = Math.max(1, Math.min(1000, Number(limit) || 20));
  return mine.slice(-n);
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
      pending: !!entry.pending,
      lastHeartbeat: conn?.lastHeartbeat ?? null,
      agentVersion: conn?.agentVersion ?? null,
      hostname: conn?.hostname ?? entry.hostname ?? null,
      tailscaleIp: conn?.tailscaleIp ?? entry.tailscaleIp ?? null,
      verbs: PROTOCOL_VERBS,
      events: eventHistory.get(entry.name) ?? [],
    };
  });
}

// ---------------------------------------------------------------------------
// Tailnet address + installer line
// ---------------------------------------------------------------------------

// Best-effort discovery of THIS host's Tailscale IPv4, used to build the pairing
// installer command a remote Mac curls. Order: the tailscale CLI; then a CGNAT
// 100.64.0.0/10 interface address (Tailscale's range); then any non-internal IPv4.
export function detectTailnetIp() {
  try {
    const out = execSync("tailscale ip -4", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")[0]
      .trim();
    if (out) return out;
  } catch {
    // tailscale not installed / not up — fall through
  }
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) {
        const oct = a.address.split(".").map(Number);
        if (oct[0] === 100 && oct[1] >= 64 && oct[1] <= 127) return a.address;
      }
    }
  }
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

// The single one-line installer: fetch the bootstrap over the tailnet and run it with
// the pairing token. GARRISON_HOST is the http base — bootstrap-outpost.sh derives the
// ws bridge URL from it.
export function buildInstaller(name, token, ip = detectTailnetIp(), port = livePort) {
  const base = `http://${ip}:${port}`;
  return `curl -fsSL ${base}/install.sh | GARRISON_HOST=${base} GARRISON_TOKEN=${token} GARRISON_MACHINE=${name} bash`;
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
        // Optional metadata the bridge may carry in its auth payload.
        agentVersion: frame.payload?.version ?? null,
        hostname: frame.payload?.hostname ?? null,
        tailscaleIp: frame.payload?.tailscale_ip ?? frame.payload?.tailscaleIp ?? null,
        pendingRpcs: new Map(),
      });

      // A pending pairing entry is confirmed the first time its token authenticates.
      clearPending(connName);

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

// CSRF guard for the mutating / RCE-relaying endpoints (register, pair, rpc,
// unregister). A drive-by webpage the user visits can POST to a loopback service
// (readBody accepts any content-type, so it's a no-preflight "simple request")
// and reach exec.run relay → RCE on a paired Mac. A browser cross-site request
// always carries an Origin header; legitimate callers (the local UI proxy, the
// Mac's `curl`, server-to-server) send none. So: reject any request whose Origin
// is present and not loopback. Returns true when blocked (already answered 403).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
function crossSiteBlocked(req, res) {
  const origin = req.headers["origin"];
  if (origin) {
    let ok = false;
    try { ok = LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase()); } catch { ok = false; }
    if (!ok) { json(res, 403, { error: "forbidden", reason: "cross-site Origin (CSRF guard)" }); return true; }
  }
  return false;
}

async function handleHttp(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${livePort}`);
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

  // Serve the one-line-installer bootstrap so a paired Mac can curl it.
  if (method === "GET" && path === "/install.sh") {
    try {
      const script = readFileSync(BOOTSTRAP_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(script),
      });
      return res.end(script);
    } catch (err) {
      return json(res, 500, { error: `install script unavailable: ${err.message}` });
    }
  }

  // Per-outpost invocation log tail.
  const logMatch = path.match(/^\/outposts\/(.+)\/log$/);
  if (method === "GET" && logMatch) {
    const name = decodeURIComponent(logMatch[1]);
    const limit = url.searchParams.get("limit");
    return json(res, 200, { ok: true, entries: readInvocationLog(name, limit ?? 20) });
  }

  if (method === "POST" && path === "/registry/register") {
    if (crossSiteBlocked(req, res)) return;
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

  // Mint a pairing token and return the one-line installer for a new Mac.
  if (method === "POST" && path === "/registry/pair") {
    if (crossSiteBlocked(req, res)) return;
    try {
      const body = await parseBody(req);
      const name = (body?.name || "").trim();
      if (!name) return json(res, 400, { error: "name required" });
      const entry = mintPairing(name);
      const ip = detectTailnetIp();
      const host = `http://${ip}:${livePort}`;
      return json(res, 200, {
        name: entry.name,
        token: entry.token,
        pending: true,
        host,
        installer: buildInstaller(entry.name, entry.token, ip, livePort),
      });
    } catch (err) {
      return json(res, 400, { error: String(err) });
    }
  }

  const deleteMatch = path.match(/^\/registry\/(.+)$/);
  if (method === "DELETE" && deleteMatch) {
    if (crossSiteBlocked(req, res)) return;
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
    if (crossSiteBlocked(req, res)) return;
    const name = decodeURIComponent(rpcMatch[1]);
    const caller = String(req.headers["x-garrison-caller"] || req.socket.remoteAddress || "unknown");
    const started = Date.now();
    let body;
    try {
      body = await parseBody(req);
      const { type, payload } = body;
      if (!type) return json(res, 400, { error: "type required" });
      const result = await callRpc(name, type, payload);
      logInvocation({ verb: type, outpost: name, caller, ok: true, ms: Date.now() - started });
      return json(res, 200, { ok: true, result });
    } catch (err) {
      logInvocation({
        verb: body?.type ?? "?",
        outpost: name,
        caller,
        ok: false,
        ms: Date.now() - started,
        error: err.message,
      });
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  return json(res, 404, { error: "not found" });
}

const ioPathRe = /^\/outposts\/(.+)\/io$/;

function createHostServer() {
  const server = createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://127.0.0.1:${livePort}`);

    if (url.pathname === "/bridge") {
      wss.handleUpgrade(req, socket, head, (ws) => handleBridgeConnection(ws));
      return;
    }

    const ioMatch = url.pathname.match(ioPathRe);
    if (ioMatch) {
      const outpostName = decodeURIComponent(ioMatch[1]);
      wss.handleUpgrade(req, socket, head, (ws) => handleSubscriberConnection(ws, outpostName));
      return;
    }

    socket.destroy();
  });

  return { server, wss };
}

// ---------------------------------------------------------------------------
// PID-file singleton guard (daemon path only)
// ---------------------------------------------------------------------------

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
    if (!existsSync(pidFilePath())) return null;
    const pid = parseInt(readFileSync(pidFilePath(), "utf8").trim(), 10);
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
    mkdirSync(garrisonHome(), { recursive: true });
    writeFileSync(pidFilePath(), String(process.pid), { mode: 0o600 });
  } catch (err) {
    console.warn(`[outpost-host] could not write PID file ${pidFilePath()}: ${err.message}`);
  }
}

function clearPidFile() {
  try {
    const recorded = readPidFile();
    if (recorded === process.pid) unlinkSync(pidFilePath());
  } catch {
    // ignore
  }
}

function installGracefulErrorHandler(server, port) {
  // Resilience: bind failures should not take down the rest of Garrison.
  // Concurrently was previously launched with --kill-others-on-fail; a non-zero
  // exit here would kill the Next dev server. We exit 0 on EADDRINUSE so the
  // main UI keeps running, but log loudly so the user can fix the conflict.
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      const holder = findPortHolder(port);
      const recordedPid = readPidFile();
      const recordedAlive = pidAlive(recordedPid);
      console.error("");
      console.error(`[outpost-host] PORT ${port} IS ALREADY IN USE — this instance will not start.`);
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
          try { unlinkSync(pidFilePath()); } catch {}
        }
      }
      console.error(`[outpost-host]   to free the port:  lsof -nP -iTCP:${port} -sTCP:LISTEN  then  kill <pid>`);
      console.error(`[outpost-host]   Garrison's main UI will continue without the outpost host.`);
      console.error("");
      process.exit(0); // graceful — keep concurrently siblings alive
    }
    console.error(`[outpost-host] fatal http error:`, err);
    clearPidFile();
    process.exit(1);
  });
}

function installSignalHandlers(server) {
  const shutdown = (signal) => {
    console.log(`[outpost-host] received ${signal}, shutting down`);
    clearPidFile();
    server.close(() => process.exit(0));
    // Hard-stop fallback if close() hangs on open WS sockets
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", clearPidFile);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

// Boot a host instance. `managePidFile` engages the singleton daemon behaviour
// (PID file, graceful EADDRINUSE exit, signal handlers); tests leave it off and get
// a plain server that rejects on a bind error. Returns { server, wss, port, close }.
export async function startHost({ port = PORT, bind = BIND, managePidFile = false } = {}) {
  if (managePidFile) {
    // Pre-flight: if we have a recorded PID that's alive and holds the port, defer
    // before we even attempt to bind. Avoids the noisy EADDRINUSE stack trace for the
    // most common case (the previous instance is still healthy).
    const recordedPid = readPidFile();
    if (pidAlive(recordedPid)) {
      const holder = findPortHolder(port);
      if (recordedPid === holder) {
        console.log(`[outpost-host] another outpost-host is already running on ${bind}:${port} (PID ${recordedPid}); exiting cleanly.`);
        process.exit(0);
      }
    }
  }

  const { server, wss } = createHostServer();
  if (managePidFile) installGracefulErrorHandler(server, port);

  await new Promise((resolvePromise, rejectPromise) => {
    const onErr = (err) => {
      server.removeListener("listening", onListen);
      rejectPromise(err);
    };
    const onListen = () => {
      server.removeListener("error", onErr);
      resolvePromise();
    };
    server.once("error", onErr);
    server.once("listening", onListen);
    server.listen(port, bind);
  });

  const addr = server.address();
  livePort = typeof addr === "object" && addr ? addr.port : port;

  if (managePidFile) {
    writePidFile();
    installSignalHandlers(server);
  }

  console.log(`[outpost-host] listening on ${bind}:${livePort} (pid ${process.pid})`);
  console.log(`[outpost-host] registry: ${registryPath()}`);
  console.log(`[outpost-host] bridges connect to ws://<this-host>:${livePort}/bridge`);

  return {
    server,
    wss,
    port: livePort,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isMain) {
  startHost({ managePidFile: true }).catch((err) => {
    console.error("[outpost-host] failed to start:", err);
    clearPidFile();
    process.exit(1);
  });
}

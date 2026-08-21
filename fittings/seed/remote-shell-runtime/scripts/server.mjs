// remote-shell own-port server.
//
// Holds everything long-lived: devtunnel client children, ssh+tmux attach
// PTYs, per-session output replay buffers, the hook-driven events watchers,
// and the WS terminal stream. The gateway-side RemoteShellAdapter and the
// web-channel terminal pane are both thin clients of this server over
// loopback / the tailnet-served pair.
//
// Scaffolding (routing, WS upgrade, status file, static serving) follows the
// dev-env fitting; the /io WS speaks the same protocol as dev-env's so the
// shared TerminalPane component works against either server unchanged.

import { readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer } from "ws";
import { HttpError, SessionManager } from "../lib/sessions.mjs";
import { TunnelManager, garrisonHome, loadTransports } from "../lib/transports.mjs";

const FITTING_ID = "remote-shell-runtime";
const DEFAULT_PORT = 7098;
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const STATUS_ROOT = path.join(garrisonHome(), "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, `${FITTING_ID}.json`);

function parseArgs(argv) {
  const out = {
    port: Number(process.env.GARRISON_REMOTESHELLRUNTIME_PORT || DEFAULT_PORT),
    host: process.env.GARRISON_REMOTESHELLRUNTIME_BIND_HOST || process.env.GARRISON_BIND_HOST || "127.0.0.1",
    // Empty = every running fitting that answers /notify (404 = skip).
    notifyFittings: String(process.env.GARRISON_REMOTESHELLRUNTIME_NOTIFY_FITTINGS || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--host") out.host = argv[++i];
  }
  return out;
}

// ── Channel notify fan-out (the repo's discovery pattern) ───────────────────
// Every running fitting's status file is a candidate; POST /notify to each and
// treat HTTP 404 as "not a notify-capable channel" — implementing /notify IS
// the opt-in (kanban-loop notify-origin.mjs / improver probe-notify.mjs
// precedent). `notifyFittings` optionally restricts the set; empty = all.

// Under vitest with no explicit GARRISON_HOME, discovery would read the REAL
// ~/.garrison and put live pushes on the user's phone (this exact accident
// shipped once, 2026-08-18, from kanban's fan-out). Fail closed.
function underTestRunner() {
  return Boolean(process.env.VITEST) && !process.env.GARRISON_HOME;
}

async function notifyChannels(notifyFittings, payload) {
  if (underTestRunner()) return;
  let names = [];
  try {
    names = (await import("node:fs")).readdirSync(STATUS_ROOT).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names) {
    const fittingId = name.slice(0, -".json".length);
    if (fittingId === FITTING_ID) continue;
    if (notifyFittings.length > 0 && !notifyFittings.includes(fittingId)) continue;
    try {
      const status = JSON.parse(readFileSync(path.join(STATUS_ROOT, name), "utf8"));
      if (!status?.url) continue;
      const res = await fetch(`${status.url}/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000)
      });
      // 404 = not a notify-capable channel; anything else is a real outcome.
      if (res.status !== 404 && !res.ok) {
        console.warn(`[remote-shell] ${fittingId}/notify -> ${res.status}`);
      }
    } catch (err) {
      console.warn(`[remote-shell] notify ${fittingId} failed: ${err.message}`);
    }
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function jsonRes(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function assertStatusSlotFree() {
  let recorded;
  try { recorded = JSON.parse(readFileSync(STATUS_FILE, "utf8")); } catch { return; }
  const pid = Number(recorded?.pid);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
    console.error(`[remote-shell] ${STATUS_FILE} is held by live pid ${pid} — refusing to start a duplicate`);
    process.exit(1);
  }
}

async function assertPortFree(port, host) {
  const net = await import("node:net");
  const free = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
  if (!free) {
    console.error(`[remote-shell] port ${port} is already in use — refusing to start on a shifted port`);
    process.exit(1);
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const transports = await loadTransports();
  const tunnels = new TunnelManager({});
  const manager = new SessionManager({
    tunnels,
    transports,
    notify: (payload) => notifyChannels(opts.notifyFittings, payload)
  });
  const restored = await manager.restore();
  if (restored > 0) console.log(`[remote-shell] restored ${restored} session record(s)`);

  const distDir = path.resolve(HERE, "..", "dist");

  const server = http.createServer(async (req, res) => {
    const { pathname, query } = url.parse(req.url || "/", true);
    try {
      if (req.method === "GET" && pathname === "/health") {
        return jsonRes(res, 200, {
          ok: true,
          port: opts.port,
          pid: process.pid,
          transports: [...transports.keys()],
          tunnels: tunnels.status(),
          sessions: manager.list().length
        });
      }
      if (req.method === "GET" && pathname === "/transports") {
        return jsonRes(res, 200, {
          transports: [...transports.values()].map((t) => ({
            name: t.name,
            label: t.label,
            via: t.via ? "devtunnel" : "ssh",
            tmuxSession: t.tmuxSession,
            cwd: t.cwd,
            agentCommand: t.agentCommand,
            routingTarget: t.routingTarget
          }))
        });
      }
      if (req.method === "GET" && pathname === "/sessions") {
        return jsonRes(res, 200, { sessions: manager.list() });
      }
      if (req.method === "POST" && pathname === "/sessions") {
        const body = await readJsonBody(req);
        const session = await manager.start(String(body.transport || ""), { label: body.label });
        return jsonRes(res, 200, { session: manager.summary(session) });
      }

      const m = pathname?.match(/^\/sessions\/([A-Za-z0-9-]+)(\/.*)?$/);
      if (m) {
        const session = manager.get(m[1]);
        if (!session) return jsonRes(res, 404, { error: "unknown session" });
        const rest = m[2] || "";

        if (req.method === "GET" && rest === "") {
          return jsonRes(res, 200, { session: manager.summary(session) });
        }
        if (req.method === "POST" && rest === "/input") {
          const body = await readJsonBody(req);
          await manager.sendInstruction(session, String(body.text ?? ""));
          return jsonRes(res, 200, { ok: true });
        }
        if (req.method === "POST" && rest === "/keys") {
          const body = await readJsonBody(req);
          await manager.sendKeys(session, String(body.keys ?? ""));
          return jsonRes(res, 200, { ok: true });
        }
        if (req.method === "POST" && rest === "/turn") {
          const body = await readJsonBody(req);
          const turn = await manager.startTurn(session, String(body.text ?? ""));
          return jsonRes(res, 200, { turn: { id: turn.id, startedAt: turn.startedAt, state: turn.state } });
        }
        const tm = rest.match(/^\/turns\/([A-Za-z0-9-]+)$/);
        if (req.method === "GET" && tm) {
          const waitMs = Math.min(Number(query.waitMs) || 0, 120_000);
          const turn = await manager.awaitTurn(session, tm[1], waitMs);
          return jsonRes(res, 200, {
            turn: {
              id: turn.id,
              state: turn.state,
              startedAt: turn.startedAt,
              endedAt: turn.endedAt,
              tail: turn.tail ?? null,
              error: turn.error ?? null
            }
          });
        }
        if (req.method === "GET" && rest === "/screen") {
          const text = await manager.capturePane(session, Number(query.lines) || 60);
          return jsonRes(res, 200, { text });
        }
        if (req.method === "POST" && rest === "/detach") {
          manager.detach(session);
          return jsonRes(res, 200, { ok: true });
        }
        if (req.method === "DELETE" && rest === "") {
          await manager.remove(session.id);
          return jsonRes(res, 200, { ok: true });
        }
      }

      // Static UI (dist/) for the own-port view.
      if (req.method === "GET") {
        const { createReadStream, existsSync, statSync } = await import("node:fs");
        const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const file = path.join(distDir, rel);
        if (file.startsWith(distDir) && existsSync(file) && statSync(file).isFile()) {
          const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
          res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
          createReadStream(file).pipe(res);
          return;
        }
      }
      return jsonRes(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return jsonRes(res, err.status, { error: err.message });
      console.error("[remote-shell] request failed:", err);
      return jsonRes(res, 500, { error: err.message });
    }
  });

  // WS /io — dev-env protocol: {init sessionId cols rows} → init_ack + replay;
  // binary/raw frames = stdin; {resize}; server pushes bytes + {state} frames.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = url.parse(request.url || "/");
    if (pathname !== "/io") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    let session = null;
    let unsubscribe = null;
    ws.on("message", (data, isBinary) => {
      if (!session) {
        let msg;
        try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
        if (msg.type !== "init" || typeof msg.sessionId !== "string") return;
        session = manager.get(msg.sessionId);
        if (!session) {
          try { ws.send(JSON.stringify({ type: "error", message: "session not found" })); } catch {}
          ws.close();
          return;
        }
        manager.ensureAttached(session);
        unsubscribe = manager.subscribe(session, ws);
        if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          manager.resize(session, msg.cols, msg.rows);
        }
        try {
          ws.send(JSON.stringify({ type: "init_ack", id: session.id, tmux: true, state: session.state }));
          if (session.buffer.length > 0) ws.send(session.buffer);
        } catch {}
        return;
      }
      if (isBinary) {
        manager.writeRaw(session, data.toString("utf8"));
        return;
      }
      const text = data.toString("utf8");
      if (text.startsWith("{")) {
        try {
          const frame = JSON.parse(text);
          if (frame?.type === "resize") { manager.resize(session, frame.cols, frame.rows); return; }
          if (frame?.type === "ping") { try { ws.send(JSON.stringify({ type: "pong" })); } catch {} return; }
        } catch {}
      }
      manager.writeRaw(session, text);
    });
    ws.on("close", () => { unsubscribe?.(); });
  });

  assertStatusSlotFree();
  await assertPortFree(opts.port, opts.host);

  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[remote-shell] port ${opts.port} is already in use`);
      process.exit(1);
    }
    throw err;
  });

  await new Promise((resolve) => {
    server.listen(opts.port, opts.host, async () => {
      await mkdir(STATUS_ROOT, { recursive: true });
      await writeFile(STATUS_FILE, JSON.stringify({
        fittingId: FITTING_ID,
        port: opts.port,
        url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      }, null, 2));
      console.log(`[remote-shell] listening on ${opts.host}:${opts.port} (${transports.size} transport(s))`);
      resolve();
    });
  });

  const shutdown = async () => {
    manager.shutdownAll();
    tunnels.shutdown();
    try { await unlink(STATUS_FILE); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}

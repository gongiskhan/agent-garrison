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
import { SETTLE_SUPERVISOR_MS, TunnelManager, garrisonHome, loadTransports } from "../lib/transports.mjs";
import { refreshHostTokens, DEFAULT_REFRESH_MS } from "../lib/host-credential.mjs";
import { TetherManager, tetherArmed } from "../lib/tether.mjs";
import { ForwardManager } from "../lib/forwards.mjs";
import { listRemoteDir, readRemoteFile } from "../lib/remote-files.mjs";
import { buildIndex } from "../lib/session-index.mjs";
import { nodeName, shellOrigin } from "../lib/node-identity.mjs";
import { flush as flushIndex, schedulePublish as publishIndex } from "../lib/index-publisher.mjs";
import { applyCors, verdict as originVerdict } from "../lib/origin-guard.mjs";
import { installHooks } from "./install-hooks.mjs";

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
      .split(",").map((s) => s.trim()).filter(Boolean),
    sessionWindowDays: Number(process.env.GARRISON_REMOTESHELLRUNTIME_SESSION_WINDOW_DAYS) > 0
      ? Number(process.env.GARRISON_REMOTESHELLRUNTIME_SESSION_WINDOW_DAYS) : 5,
    indexPublishSeconds: Number(process.env.GARRISON_REMOTESHELLRUNTIME_INDEX_PUBLISH_SECONDS) > 0
      ? Number(process.env.GARRISON_REMOTESHELLRUNTIME_INDEX_PUBLISH_SECONDS) : 10
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

/** How long an off-the-request-path caller waits for a fresh devtunnel client
 *  to bring its forward up. Config, never a literal: a hand-run `devtunnel
 *  connect` was once silent for 45s before it settled. */
function tunnelSettleMs() {
  const sec = Number(process.env.GARRISON_REMOTESHELLRUNTIME_TUNNEL_SETTLE_SECONDS);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : SETTLE_SUPERVISOR_MS;
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
  const notify = (payload) => notifyChannels(opts.notifyFittings, payload);
  const tunnels = new TunnelManager({ notify });
  const forwards = new ForwardManager({});
  const tether = new TetherManager({ notify });
  const manager = new SessionManager({ tunnels, transports, notify });

  // A tether transport is inert everywhere except its declared owner (checked
  // per-call by tetherArmed) - so it is always safe to try ensure() + start
  // ticking for every tethered transport here; on every other node in the
  // mesh those calls are a quick no-op.
  for (const t of transports.values()) {
    if (!t.tether) continue;
    void tether.ensure(t);
    tether.startTicking(t);
  }
  // A tunnel coming back is the moment everything that gave up while it was
  // down should be restarted — the session pulse, the events watchers, and any
  // attach a browser is still waiting on. Nothing else observes that edge.
  tunnels.onRecovered = (transport) => manager.transportRecovered(transport);
  const restored = await manager.restore();
  if (restored > 0) console.log(`[remote-shell] restored ${restored} session record(s)`);

  // NEVER under vitest: installHooks() merges into the REAL Cursor/Codex/
  // Gemini config on whatever machine runs the suite (it is not sandboxed by
  // GARRISON_HOME the way everything else here is - it reads HOME/CODEX_HOME/
  // GEMINI_CLI_HOME/GARRISON_CURSOR_HOME, which a test booting a live server
  // has no reason to pin). A test that wants installHooks() behavior calls it
  // directly with every home pinned (tests/shells-hooks-install.test.ts) -
  // same fail-closed discipline as notifyChannels' underTestRunner() below.
  if (!process.env.VITEST) {
    try {
      installHooks(process.env, (line) => console.log(`[remote-shell] ${line}`));
    } catch (err) {
      console.warn(`[remote-shell] hook install failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  const distDir = path.resolve(HERE, "..", "dist");

  // ── the session index (owned shells + every listed external session) ─────
  let lastIndex = { node: nodeName(), shellOrigin: shellOrigin(process.env, { port: opts.port }), updatedAt: null, rows: [] };
  let indexBuilding = false;
  function refreshIndex() {
    if (indexBuilding) return lastIndex;
    indexBuilding = true;
    try {
      const rows = buildIndex({ manager, windowDays: opts.sessionWindowDays, garrisonHomeDir: garrisonHome() });
      lastIndex = {
        node: nodeName(),
        shellOrigin: shellOrigin(process.env, { port: opts.port }),
        updatedAt: new Date().toISOString(),
        rows
      };
      void publishIndex(lastIndex);
    } catch (err) {
      console.warn(`[remote-shell] index build failed: ${err?.message ?? err}`);
    } finally {
      indexBuilding = false;
    }
    return lastIndex;
  }
  refreshIndex();
  const indexTimer = setInterval(refreshIndex, opts.indexPublishSeconds * 1000);
  indexTimer.unref?.();

  const server = http.createServer(async (req, res) => {
    const { pathname, query } = url.parse(req.url || "/", true);
    const guard = originVerdict({ host: req.headers.host, origin: req.headers.origin });
    if (guard.blocked) return jsonRes(res, 403, { error: "forbidden", reason: guard.reason });
    applyCors(res, req.headers.origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return void res.end();
    }
    try {
      if (req.method === "GET" && pathname === "/index") {
        return jsonRes(res, 200, lastIndex);
      }
      if (req.method === "GET" && pathname === "/health") {
        return jsonRes(res, 200, {
          ok: true,
          port: opts.port,
          pid: process.pid,
          transports: [...transports.keys()],
          tunnels: tunnels.status(),
          sessions: manager.list().length,
          local: { enabled: transports.has("local"), tmux: transports.has("local") }
        });
      }
      if (req.method === "GET" && pathname === "/transports") {
        return jsonRes(res, 200, {
          transports: [...transports.values()].map((t) => ({
            name: t.name,
            label: t.label,
            kind: t.kind,
            via: t.via ? "devtunnel" : t.kind === "local" ? "local" : "ssh",
            // The join key for /tunnels: the UI renders health per transport row.
            tunnel: t.via?.devtunnel?.tunnel ?? null,
            tmuxSession: t.tmuxSession,
            cwd: t.cwd,
            projectsRoot: t.projectsRoot,
            agentCommand: t.agentCommand,
            routingTarget: t.routingTarget,
            // Cheap read: reports what is already up, never dials.
            forwards: t.kind === "local" ? [] : forwards.snapshot(t)
          }))
        });
      }
      if (req.method === "GET" && pathname === "/runtimes") {
        const rows = await manager.listRuntimes(String(query.transport || ""));
        return jsonRes(res, 200, { runtimes: rows });
      }
      // Tunnel health, and the one lever that used to be "restart the whole
      // fitting" - which is what both observed outages actually required.
      if (req.method === "GET" && pathname === "/tunnels") {
        return jsonRes(res, 200, { tunnels: tunnels.status() });
      }
      if (req.method === "POST" && /^\/tunnels\/[^/]+\/repair$/.test(pathname)) {
        const key = decodeURIComponent(pathname.split("/")[2]);
        // Accept either the transport name (what the UI shows) or the tunnel id
        // (what /tunnels is keyed by).
        const transport = transports.get(key)
          ?? [...transports.values()].find((t) => t.via?.devtunnel?.tunnel === key);
        if (!transport) return jsonRes(res, 404, { error: `no transport named "${key}" and no transport on a tunnel with that id` });
        const result = await tunnels.repair(transport);
        return jsonRes(res, result.ok ? 200 : 502, { ...result, tunnels: tunnels.status() });
      }
      // The tethered-node analog of /tunnels: every transport that declares a
      // tether block, its armed-ness on THIS node, and its current status.
      if (req.method === "GET" && pathname === "/tether") {
        const rows = [...transports.values()]
          .filter((t) => t.tether)
          .map((t) => ({
            transport: t.name,
            node: t.tether.node,
            owner: t.tether.owner,
            armed: tetherArmed(t),
            ...tether.status(t.name)
          }));
        return jsonRes(res, 200, { tether: rows });
      }
      if (req.method === "POST" && /^\/tether\/[^/]+\/repair$/.test(pathname)) {
        const name = decodeURIComponent(pathname.split("/")[2]);
        const transport = transports.get(name);
        if (!transport || !transport.tether) return jsonRes(res, 404, { error: `no tethered transport named "${name}"` });
        if (!tetherArmed(transport)) {
          return jsonRes(res, 409, { error: `tether for "${name}" is not armed on this node (owner mismatch)` });
        }
        await tether.stop(name);
        const result = await tether.ensure(transport);
        return jsonRes(res, result.ok ? 200 : 502, { ...result, tether: tether.status(name) });
      }
      // Bring a transport's forwards up (idempotent) and report where they landed.
      // POST because it opens ssh channels - a GET that dials would make a status
      // poll hold connections into someone else's machine open.
      if (req.method === "POST" && /^\/transports\/[^/]+\/forwards$/.test(pathname)) {
        const name = decodeURIComponent(pathname.split("/")[2]);
        const transport = transports.get(name);
        if (!transport) return jsonRes(res, 404, { error: `unknown transport "${name}"` });
        const tunnel = await tunnels.ensure(transport);
        if (!tunnel.ok) return jsonRes(res, 502, { error: tunnel.error, forwards: [] });
        return jsonRes(res, 200, { forwards: await forwards.ensureAll(transport) });
      }
      // Read-only browse of the remote's project tree. The file browser consumes
      // these; nothing else needs to learn how to reach the machine.
      if (req.method === "GET" && /^\/transports\/[^/]+\/files$/.test(pathname)) {
        const name = decodeURIComponent(pathname.split("/")[2]);
        const transport = transports.get(name);
        if (!transport) return jsonRes(res, 404, { error: `unknown transport "${name}"` });
        const tunnel = await tunnels.ensure(transport);
        if (!tunnel.ok) return jsonRes(res, 502, { error: tunnel.error });
        try {
          const listing = await listRemoteDir(transport, query.path || "");
          return jsonRes(res, 200, { ...listing, root: transport.cwd, transport: name });
        } catch (err) {
          return jsonRes(res, 400, { error: String(err?.message || err) });
        }
      }
      if (req.method === "GET" && /^\/transports\/[^/]+\/file$/.test(pathname)) {
        const name = decodeURIComponent(pathname.split("/")[2]);
        const transport = transports.get(name);
        if (!transport) return jsonRes(res, 404, { error: `unknown transport "${name}"` });
        const tunnel = await tunnels.ensure(transport);
        if (!tunnel.ok) return jsonRes(res, 502, { error: tunnel.error });
        try {
          const file = await readRemoteFile(transport, query.path || "");
          return jsonRes(res, 200, { ...file, transport: name });
        } catch (err) {
          return jsonRes(res, 400, { error: String(err?.message || err) });
        }
      }
      if (req.method === "GET" && pathname === "/sessions") {
        return jsonRes(res, 200, { sessions: manager.list() });
      }
      if (req.method === "POST" && pathname === "/sessions") {
        const body = await readJsonBody(req);
        const session = await manager.start(String(body.transport || ""), {
          label: typeof body.label === "string" ? body.label : undefined,
          recycle: body.recycle === true,
          // The multi-session spec: a named tmux session in a chosen project
          // folder. Absent, this is the transport's standing session as ever.
          tmuxSession: typeof body.tmuxSession === "string" && body.tmuxSession.trim() ? body.tmuxSession.trim() : null,
          cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null,
          // "another agent in this folder": the tmux name above is a BASE and
          // the free instance beside it is chosen here (see start()).
          allocate: body.allocate === true,
          // The runtime catalog: which CLI to type into a fresh pane, and
          // (optionally) which of its own sessions to resume or attach.
          runtime: typeof body.runtime === "string" && body.runtime.trim() ? body.runtime.trim() : null,
          resume: typeof body.resume === "string" && body.resume.trim() ? body.resume.trim() : null,
          attach: body.attach === true
        });
        return jsonRes(res, 200, { session: manager.summary(session) });
      }

      // ── the exec lane ──────────────────────────────────────────────────
      // Loopback tools only, never a browser: refuse outright when the
      // request carries an Origin header (a same-origin fetch never sends
      // one; only a browser page does) - deliberately ABSENT from the web
      // channel's proxy allow-list too. The tmux lane above is the
      // interactive face of the same transport; this is the structured one.
      if (req.method === "POST" && pathname === "/exec") {
        if (req.headers.origin) return jsonRes(res, 403, { error: "forbidden", reason: "loopback tools only" });
        const body = await readJsonBody(req);
        const out = await manager.execArgv(String(body.transport || ""), {
          argv: body.argv,
          cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null,
          stdin: typeof body.stdin === "string" ? body.stdin : null,
          timeoutMs: Number(body.timeoutMs) > 0 ? Math.min(Number(body.timeoutMs), 900_000) : undefined,
          login: body.login !== false
        });
        return jsonRes(res, 200, out);
      }

      // One headless agent turn, STREAMED as NDJSON: {delta} lines while the
      // agent works, then one {result} or {error}. A turn runs for minutes, so a
      // buffered response would show nothing until it ended - and the caller
      // could not tell a slow turn from a dead one.
      if (req.method === "POST" && pathname === "/agent-turns") {
        if (req.headers.origin) return jsonRes(res, 403, { error: "forbidden", reason: "loopback tools only" });
        const body = await readJsonBody(req);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Cache-Control", "no-store");
        const send = (obj) => { try { res.write(`${JSON.stringify(obj)}\n`); } catch { /* client gone */ } };
        let child = null;
        // A client that hangs up mid-turn takes the remote command with it:
        // killing the local ssh drops the channel and the far side gets a HUP.
        req.on("aborted", () => { try { child?.kill("SIGTERM"); } catch {} });
        try {
          const turn = await manager.agentTurn(String(body.transport || ""), {
            prompt: typeof body.prompt === "string" ? body.prompt : "",
            model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : null,
            cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null,
            resumeId: typeof body.resumeId === "string" && body.resumeId.trim() ? body.resumeId.trim() : null,
            timeoutMs: Number(body.timeoutMs) > 0 ? Math.min(Number(body.timeoutMs), 3_600_000) : undefined,
            onDelta: (delta) => send({ delta }),
            onSpawn: (c) => { child = c; }
          });
          send({ result: turn });
        } catch (err) {
          send({ error: String(err?.message || err), status: err?.status ?? 500 });
        }
        return void res.end();
      }

      // The spawn targets the Shells picker offers: folders under ~/dev on the
      // transport, annotated with any session already working there.
      if (req.method === "GET" && pathname === "/projects") {
        const projects = await manager.listProjects(String(query.transport || ""));
        return jsonRes(res, 200, { projects });
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
          // `sinceRev` turns the long-poll into a stream: it returns as soon as
          // the running turn has printed something the caller has not seen.
          const sinceRev = query.sinceRev == null ? null : Number(query.sinceRev);
          const turn = await manager.awaitTurn(session, tm[1], waitMs, sinceRev);
          return jsonRes(res, 200, {
            turn: {
              id: turn.id,
              state: turn.state,
              startedAt: turn.startedAt,
              endedAt: turn.endedAt,
              output: turn.output ?? "",
              outputRev: turn.outputRev ?? 0,
              // The progress read still never fails the turn - but it stops
              // pretending. A frozen transcript now says the link went, instead
              // of hanging silently until the gateway's own timeout.
              degraded: Boolean(turn.degraded),
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
          await manager.remove(session.id, { killRemote: query.kill === "1" });
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
    const guard = originVerdict({ host: request.headers.host, origin: request.headers.origin });
    if (guard.blocked) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
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
          const replay = manager.replayBuffer(session);
          if (replay.length > 0) ws.send(replay);
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

  // Supervision starts HERE and not a line earlier. A dead remote must never
  // delay the port opening or the status file landing, or `up()`'s own-port
  // wait times out and the whole fitting reports failed for a tunnel problem.
  // The first tick is scheduled, never awaited, and the interval is unref'd.
  const checkSec = Number(process.env.GARRISON_REMOTESHELLRUNTIME_TUNNEL_CHECK_SECONDS);
  const supervising = tunnels.startSupervision({
    transports: [...transports.values()],
    // 0 disables the loop entirely - the escape hatch if it ever misbehaves.
    intervalMs: Number.isFinite(checkSec) ? checkSec * 1000 : undefined
  });
  if (supervising) console.log("[remote-shell] tunnel supervision armed");

  // Keep the remote's host credential alive from HERE. The remote is reachable
  // only through the tunnel it hosts, so a credential that must be renewed there
  // cannot be renewed at all once it lapses. See lib/host-credential.mjs.
  const refreshMin = Number(process.env.GARRISON_REMOTESHELLRUNTIME_TOKEN_REFRESH_MIN);
  const refreshMs = Number.isFinite(refreshMin) && refreshMin > 0 ? refreshMin * 60_000 : DEFAULT_REFRESH_MS;
  const pushTokens = async () => {
    // Off the request path, so it gets the patient settle window: a fresh
    // deploy genuinely wants the tunnel up rather than a fast "not yet".
    const settleMs = tunnelSettleMs();
    const results = await refreshHostTokens([...transports.values()], {
      ensure: (t) => tunnels.ensure(t, { settleMs, reason: "host-token" })
    });
    for (const r of results) {
      if (r.ok) console.log(`[remote-shell] host token delivered to ${r.transport} (expires ${r.expiration ?? "unknown"})`);
      else console.warn(`[remote-shell] host token ${r.stage} failed for ${r.transport}: ${r.error}`);
    }
  };
  // Once at startup so a fresh deploy heals a remote whose token is stale, then
  // hourly against a 24h token - a full day of slack before the remote lapses.
  pushTokens().catch((err) => console.warn(`[remote-shell] host token refresh failed: ${err.message}`));
  const refreshTimer = setInterval(
    () => pushTokens().catch((err) => console.warn(`[remote-shell] host token refresh failed: ${err.message}`)),
    refreshMs
  );
  refreshTimer.unref();

  const shutdown = async () => {
    clearInterval(refreshTimer);
    clearInterval(indexTimer);
    try { await flushIndex(); } catch {}
    tunnels.stopSupervision();
    manager.shutdownAll();
    tunnels.shutdown();
    try { await unlink(STATUS_FILE); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}

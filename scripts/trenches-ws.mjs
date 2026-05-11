#!/usr/bin/env node
// Garrison Trenches terminal server — adapted from Harmonika's
// server/terminal.js. Single-user, no tmux, no Express.
//
// HTTP (127.0.0.1:3601):
//   GET    /health                 → { ok, sessions }
//   GET    /sessions               → [{ id, name, type, cwd, busy, ... }]
//   POST   /terminals              → { id, name, type, cwd, ... }
//     body: { name?, cwd?, shell?, host?, sshUser?, sshAddress?, initialCommand? }
//   DELETE /terminals/<id>         → { ok }
//
// WebSocket protocol (ws://127.0.0.1:3601/io):
//   client → server, first frame, JSON: { type: "init", sessionId }
//   server → client, JSON: { type: "init_ack" }  OR { type: "error", message }
//   client → server, binary: stdin
//   server → client, binary: stdout
//   client → server, JSON: { type: "resize", cols, rows } | { type: "ping" }
//   server → client, JSON: { type: "pong", ts }

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { spawn as childSpawn } from "node:child_process";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const PORT = parseInt(process.env.GARRISON_TRENCHES_PORT || "3601", 10);
const HOST = process.env.GARRISON_TRENCHES_HOST || "127.0.0.1";
const BUSY_WINDOW_MS = 2000;
const PTY_DETACHED_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_BUFFER_BYTES = 10 * 1024;
const MAX_SESSIONS = 100;

// Map<sessionId, Session>
//   Session = {
//     id, name, type ("terminal"),
//     cwd, shell, host (null | { user, address }),
//     pty, ws, lastActivity, createdAt,
//     buffer (recent stdout for reconnection),
//     detachTimeout (Timeout | null),
//   }
const sessions = new Map();
let counter = 0;

function expandTilde(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}${value.slice(1)}`;
  return value;
}

function spawnPty({ cwd, shell, host, sshUser, sshAddress, env, cols = 80, rows = 24 }) {
  const ptyEnv = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "garrison-trenches",
    ...(env || {}),
  };

  if (host && host !== "local") {
    if (!sshUser || !sshAddress) {
      throw new Error("Remote sessions require sshUser and sshAddress");
    }
    return pty.spawn(
      "ssh",
      ["-tt", `${sshUser}@${sshAddress}`],
      { name: "xterm-256color", cols, rows, cwd: process.env.HOME || "/tmp", env: ptyEnv }
    );
  }

  const expanded = expandTilde(cwd);
  let workingDir = expanded || process.env.HOME || "/tmp";
  if (expanded && !existsSync(expanded)) {
    console.warn(`[trenches-ws] cwd ${expanded} does not exist, falling back to HOME`);
    workingDir = process.env.HOME || "/tmp";
  }
  const shellExe = shell || process.env.SHELL || "/bin/bash";
  return pty.spawn(shellExe, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: workingDir,
    env: ptyEnv,
  });
}

function createSession({ name, cwd, shell, host, sshUser, sshAddress, initialCommand }) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error("trenches at session capacity");
  }
  const id = randomUUID();
  counter += 1;
  const sessionName = name || `terminal-${counter}`;

  const ptyProcess = spawnPty({ cwd, shell, host, sshUser, sshAddress });

  const session = {
    id,
    name: sessionName,
    type: "terminal",
    cwd: cwd || homedir(),
    host: host && host !== "local" ? { user: sshUser, address: sshAddress } : null,
    pty: ptyProcess,
    ws: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    buffer: "",
    detachTimeout: null,
    initialCommand: initialCommand || null,
    initialCommandSent: false,
  };

  ptyProcess.onData((data) => {
    session.lastActivity = Date.now();
    session.buffer += data;
    if (session.buffer.length > OUTPUT_BUFFER_BYTES) {
      session.buffer = session.buffer.slice(-OUTPUT_BUFFER_BYTES);
    }
    if (session.ws && session.ws.readyState === 1) {
      session.ws.send(Buffer.from(data, "utf8"), { binary: true });
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[trenches-ws] PTY ${id} exited (code=${exitCode} signal=${signal})`);
    const live = sessions.get(id);
    if (live?.ws && live.ws.readyState === 1) {
      try {
        live.ws.close(1000, "PTY exited");
      } catch {
        // ignore
      }
    }
    sessions.delete(id);
  });

  sessions.set(id, session);

  // Run an initial command (e.g. `claude --append-system-prompt-file ...`).
  // Tiny delay so the shell prompt is ready.
  if (initialCommand) {
    setTimeout(() => {
      if (sessions.has(id)) {
        try {
          ptyProcess.write(`${initialCommand}\r`);
          session.initialCommandSent = true;
        } catch (err) {
          console.error(`[trenches-ws] initialCommand failed for ${id}:`, err);
        }
      }
    }, 200);
  }

  console.log(`[trenches-ws] created session ${id} (${sessionName})`);
  return summarize(session);
}

function summarize(session) {
  const now = Date.now();
  return {
    id: session.id,
    name: session.name,
    type: session.type,
    cwd: session.cwd,
    host: session.host,
    busy: now - session.lastActivity < BUSY_WINDOW_MS,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    connected: Boolean(session.ws && session.ws.readyState === 1),
  };
}

function killSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.detachTimeout) {
    clearTimeout(session.detachTimeout);
    session.detachTimeout = null;
  }
  try {
    session.pty.kill();
  } catch {
    // ignore
  }
  if (session.ws && session.ws.readyState === 1) {
    try {
      session.ws.close(1000, "Session deleted");
    } catch {
      // ignore
    }
  }
  sessions.delete(id);
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (chunk) => {
      chunks += chunk.toString("utf8");
      if (chunks.length > 64 * 1024) {
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      if (!chunks) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(chunks));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = req.url || "/";
    if (req.method === "GET" && url === "/health") {
      sendJson(res, 200, { ok: true, sessions: sessions.size });
      return;
    }
    if (req.method === "GET" && url === "/sessions") {
      const list = Array.from(sessions.values()).map(summarize);
      sendJson(res, 200, { sessions: list });
      return;
    }
    if (req.method === "POST" && url === "/terminals") {
      const body = await readJsonBody(req);
      try {
        const summary = createSession(body || {});
        sendJson(res, 201, summary);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }
    const deleteMatch = req.method === "DELETE" && url.match(/^\/terminals\/([0-9a-f-]+)$/i);
    if (deleteMatch) {
      const ok = killSession(deleteMatch[1]);
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    console.error("[trenches-ws] http error:", err);
    sendJson(res, 500, { error: String(err) });
  }
});

const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });

wss.on("connection", (ws, req) => {
  if (req.url !== "/io" && req.url !== "/io/") {
    ws.close(4000, "Unknown WS path");
    return;
  }
  let session = null;
  let initialized = false;

  ws.on("message", (data, isBinary) => {
    if (!initialized) {
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.type !== "init" || typeof msg.sessionId !== "string") {
          ws.close(4001, "Expected init with sessionId");
          return;
        }
        session = sessions.get(msg.sessionId);
        if (!session) {
          ws.close(4004, "Unknown sessionId");
          return;
        }
        if (session.detachTimeout) {
          clearTimeout(session.detachTimeout);
          session.detachTimeout = null;
        }
        session.ws = ws;
        initialized = true;
        const cols = clamp(parseInt(msg.cols, 10) || 80, 10, 500);
        const rows = clamp(parseInt(msg.rows, 10) || 24, 5, 200);
        try {
          session.pty.resize(cols, rows);
        } catch {
          // ignore
        }
        ws.send(JSON.stringify({
          type: "init_ack",
          sessionId: session.id,
          cols,
          rows,
          cwd: session.cwd,
        }));
        if (session.buffer) {
          ws.send(Buffer.from(session.buffer, "utf8"), { binary: true });
        }
      } catch (err) {
        ws.close(4001, "Invalid init JSON");
      }
      return;
    }

    if (!session) return;
    if (isBinary) {
      try {
        session.pty.write(data.toString("utf8"));
      } catch (err) {
        console.error("[trenches-ws] pty.write failed:", err);
      }
      return;
    }
    try {
      const msg = JSON.parse(data.toString("utf8"));
      if (msg.type === "resize") {
        const cols = clamp(parseInt(msg.cols, 10), 10, 500);
        const rows = clamp(parseInt(msg.rows, 10), 5, 200);
        session.pty.resize(cols, rows);
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      }
    } catch {
      // ignore malformed control frames
    }
  });

  ws.on("close", () => {
    if (!session) return;
    if (session.ws === ws) {
      session.ws = null;
    }
    // Schedule a detached-PTY cleanup; if a fresh WS reattaches in time,
    // the timeout is cleared on init.
    if (sessions.has(session.id) && !session.detachTimeout) {
      session.detachTimeout = setTimeout(() => {
        if (sessions.has(session.id) && !session.ws) {
          console.log(`[trenches-ws] timing out detached session ${session.id}`);
          killSession(session.id);
        }
      }, PTY_DETACHED_TIMEOUT_MS);
    }
  });

  ws.on("error", (err) => {
    console.error("[trenches-ws] ws error:", err);
  });
});

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function shutdown(signal) {
  console.log(`[trenches-ws] received ${signal}, shutting down`);
  for (const session of sessions.values()) {
    try {
      session.pty.kill();
    } catch {
      // ignore
    }
  }
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

httpServer.listen(PORT, HOST, () => {
  console.log(`[trenches-ws] listening on http://${HOST}:${PORT}`);
});

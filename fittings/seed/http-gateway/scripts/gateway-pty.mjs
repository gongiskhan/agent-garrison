#!/usr/bin/env node
/**
 * Agent Garrison HTTP gateway — PTY engine.
 *
 * The operative is a single, persistent INTERACTIVE `claude` TUI driven via
 * @garrison/claude-pty (node-pty + @xterm/headless). This replaces the
 * in-process Agent SDK (gateway-legacy.mjs). Real Claude Code: slash
 * commands, skills, hooks, status line, modes — all available.
 *
 * Endpoint surface is byte-compatible with gateway-legacy.mjs so the
 * web-channel and slack-channel relays work unchanged:
 *   POST /chat          { message }            → { reply, session_id, cost_usd }
 *   POST /chat/stream    { message }           → SSE open/chunk/tool/done/error
 *   POST /jobs           { kind, ... }         → { ack: true }
 *   POST /attachments    { filename, content_base64 } → { path, bytes }
 *   GET  /health                               → { ok, session_id, uptime_ms, engine, pty_status }
 *
 * Environment (set by src/lib/runner.ts spawnGateway):
 *   GARRISON_GATEWAY_HOST / GARRISON_GATEWAY_PORT
 *   GARRISON_SYSTEM_PROMPT_PATH    → --append-system-prompt-file
 *   GARRISON_COMPOSITION_DIR       → cwd
 *   GARRISON_PERMISSION_MODE       → bypassPermissions | acceptEdits | plan | default
 *   GARRISON_MODEL                 → --model
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import {
  OperativePtySession,
  extractReply,
  openRichStream,
  richStatus,
  keySequence,
  cycleMode,
  enumerateCommandsCached,
} from "@garrison/claude-pty";

const HOST = process.env.GARRISON_GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GARRISON_GATEWAY_PORT ?? "4777");
const SYSTEM_PROMPT_PATH = process.env.GARRISON_SYSTEM_PROMPT_PATH ?? "";
const COMPOSITION_DIR = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();
const PERMISSION_MODE = process.env.GARRISON_PERMISSION_MODE ?? "bypassPermissions";
const MODEL = process.env.GARRISON_MODEL ?? "opus";
const CLAUDE_BINARY = process.env.GARRISON_CLAUDE_BINARY ?? "claude";

const STARTED_AT = Date.now();
const SESSION_ID_FILE = path.join(COMPOSITION_DIR, ".garrison", "operative-session-id");

// ─────────────────────────────────────────────────────── module state
let session = null;
let ptyStatus = "spawning"; // spawning | ready | failed
let ptyError = null;
let inflight = null; // promise chain — turns serialize
let readyResolve;
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve;
});

function logEvent(stream, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), component: "http-gateway-pty", stream, ...payload });
  (stream === "stderr" ? process.stderr : process.stdout).write(line + "\n");
}

// ─────────────────────────────────────────────────────── session lifecycle

// A marker file recording that this composition has had at least one operative
// session, so a restart resumes the latest conversation via `claude --continue`
// (claude 2.1.x persists conversations for --continue even though they are not
// in the readable session JSONL; --resume <id> is unreliable for those).
async function hasPriorSession() {
  try {
    await fs.access(SESSION_ID_FILE);
    return true;
  } catch {
    return false;
  }
}

async function markPriorSession() {
  try {
    await fs.mkdir(path.dirname(SESSION_ID_FILE), { recursive: true });
    await fs.writeFile(SESSION_ID_FILE, session?.getClaudeSessionId() ?? "continue", "utf8");
  } catch (err) {
    logEvent("stderr", { kind: "persist-session-marker-failed", error: err.message });
  }
}

async function spawnOperative({ resume = true } = {}) {
  const continueSession = resume && (await hasPriorSession());
  const appendSystemPromptFile = SYSTEM_PROMPT_PATH || undefined;
  logEvent("stdout", {
    kind: "spawning",
    model: MODEL,
    permission_mode: PERMISSION_MODE,
    continue: continueSession,
    composition_dir: COMPOSITION_DIR,
  });
  session = await OperativePtySession.spawn({
    compositionDir: COMPOSITION_DIR,
    appendSystemPromptFile,
    model: MODEL,
    permissionMode: PERMISSION_MODE,
    continueSession,
    claudeBinary: CLAUDE_BINARY,
  });
  ptyStatus = "ready";
  await markPriorSession();
  logEvent("stdout", { kind: "ready", session_id: session.getClaudeSessionId(), continued: continueSession });
  readyResolve();
}

/** Run one turn against the live operative. Spawns/respawns on demand.
 *  onChunk(text) streams the growing assistant reply (screen-derived). */
async function runTurn(message, onChunk) {
  if (!session || session.isDisposed() || !session.isAlive()) {
    logEvent("stdout", { kind: "respawn-before-turn" });
    ptyStatus = "spawning";
    await spawnOperative({ resume: true });
  }
  let lastEmitted = "";
  const onScreen = onChunk
    ? () => {
        const current = extractReply(session.handle, message);
        if (current && current.length > lastEmitted.length && current.startsWith(lastEmitted)) {
          onChunk(current.slice(lastEmitted.length));
          lastEmitted = current;
        } else if (current && current !== lastEmitted) {
          // Reflow / divergence — re-emit the whole thing as a correction.
          onChunk(current, true);
          lastEmitted = current;
        }
      }
    : undefined;
  const outcome = await session.runTurn({ message, onScreen });
  await markPriorSession();
  return { reply: outcome.reply, session_id: outcome.sessionId, cost_usd: null };
}

/** Serialize turns — the TUI is one-turn-at-a-time. */
function enqueueTurn(message, onChunk) {
  const previous = inflight ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => runTurn(message, onChunk));
  inflight = next;
  return next;
}

// ─────────────────────────────────────────────────────── HTTP plumbing

const UPLOADS_DIR = path.join(COMPOSITION_DIR, ".garrison", "uploads");
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function sseWrite(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(request, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > limit) {
        request.destroy();
        reject(new Error(`request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    request.on("error", reject);
  });
}

function safeFilename(input) {
  const base = path.basename(String(input ?? "file"));
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}

async function saveAttachment(filename, contentBase64) {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const safe = safeFilename(filename);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const target = path.join(UPLOADS_DIR, `${stamp}-${safe}`);
  const buffer = Buffer.from(contentBase64, "base64");
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`attachment exceeds ${MAX_UPLOAD_BYTES} bytes`);
  await fs.writeFile(target, buffer);
  return { path: target, bytes: buffer.length };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: ptyStatus !== "failed",
        session_id: session?.getClaudeSessionId() ?? null,
        uptime_ms: Date.now() - STARTED_AT,
        engine: "pty",
        pty_status: ptyStatus,
        error: ptyError,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      const body = await readJsonBody(request);
      const message = String(body.message ?? "").trim();
      if (!message) return sendJson(response, 400, { error: "message is required" });
      await readyPromise;
      logEvent("stdout", { kind: "chat-in", message: message.slice(0, 200) });
      const result = await enqueueTurn(message);
      logEvent("stdout", { kind: "chat-out", reply: result.reply.slice(0, 200) });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat/stream") {
      const body = await readJsonBody(request);
      const message = String(body.message ?? "").trim();
      if (!message) return sendJson(response, 400, { error: "message is required" });

      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders?.();
      sseWrite(response, "open", { ts: Date.now() });
      const heartbeat = setInterval(() => {
        try {
          response.write(": keepalive\n\n");
        } catch {
          /* ignore */
        }
      }, 15_000);

      try {
        await readyPromise;
        const result = await enqueueTurn(message, (text) => {
          try {
            sseWrite(response, "chunk", { type: "chunk", text });
          } catch {
            /* client gone */
          }
        });
        sseWrite(response, "done", result);
        logEvent("stdout", { kind: "chat-stream-out", reply: result.reply.slice(0, 200) });
      } catch (err) {
        sseWrite(response, "error", { error: err.message });
        logEvent("stderr", { kind: "chat-stream-failed", error: err.message });
      } finally {
        clearInterval(heartbeat);
        response.end();
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/attachments") {
      const body = await readJsonBody(request, MAX_UPLOAD_BYTES + 256_000);
      const filename = String(body.filename ?? "").trim();
      const contentBase64 = String(body.content_base64 ?? "");
      if (!filename || !contentBase64) {
        return sendJson(response, 400, { error: "filename and content_base64 are required" });
      }
      const saved = await saveAttachment(filename, contentBase64);
      logEvent("stdout", { kind: "attachment-saved", path: saved.path, bytes: saved.bytes });
      sendJson(response, 200, saved);
      return;
    }

    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readJsonBody(request);
      const description = typeof body.kind === "string" ? `Heartbeat job: ${body.kind}` : "Heartbeat tick";
      const jobMessage = `${description}\n\nPayload:\n${JSON.stringify(body)}`;
      readyPromise
        .then(() => enqueueTurn(jobMessage))
        .catch((err) => logEvent("stderr", { kind: "job-turn-failed", error: err.message }));
      sendJson(response, 202, { ack: true });
      return;
    }

    // ───────────────────────── rich chat surface (/claude/*)
    if (url.pathname.startsWith("/claude/")) {
      if (!session || !session.isAlive()) {
        if (url.pathname === "/claude/stream") {
          // Still open the SSE so the client can wait; emit an error once.
          response.statusCode = 200;
          response.setHeader("content-type", "text/event-stream");
          response.flushHeaders?.();
          response.write(`event: error\ndata: ${JSON.stringify({ message: "operative not ready" })}\n\n`);
          return;
        }
        return sendJson(response, 503, { error: "operative not ready", pty_status: ptyStatus });
      }
      if (request.method === "GET" && url.pathname === "/claude/stream") {
        openRichStream(session.handle, response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/claude/status") {
        return sendJson(response, 200, richStatus(session.handle));
      }
      if (request.method === "GET" && url.pathname === "/claude/commands") {
        return sendJson(response, 200, { commands: enumerateCommandsCached({ cwd: COMPOSITION_DIR }) });
      }
      if (request.method === "POST" && url.pathname === "/claude/message") {
        const body = await readJsonBody(request);
        const text = String(body.text ?? body.message ?? "").trim();
        if (!text) return sendJson(response, 400, { error: "text is required" });
        // Non-blocking: enqueue the turn; the SSE reflects progress.
        enqueueTurn(text).catch((err) => logEvent("stderr", { kind: "claude-message-failed", error: err.message }));
        return sendJson(response, 202, { ack: true });
      }
      if (request.method === "POST" && url.pathname === "/claude/keys") {
        const body = await readJsonBody(request);
        const seq = keySequence(String(body.key ?? ""));
        if (!seq) return sendJson(response, 400, { error: "unknown key" });
        session.writeKeys(seq);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/claude/mode") {
        const body = await readJsonBody(request);
        const target = String(body.mode ?? "");
        const result = await cycleMode(session.handle, target, (b) => session.writeKeys(b));
        return sendJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/claude/interrupt") {
        session.writeKeys("\x1b");
        return sendJson(response, 200, { ok: true });
      }
    }

    sendJson(response, 404, { error: "not found", path: url.pathname });
  } catch (err) {
    logEvent("stderr", { kind: "request-failed", method: request.method, path: url.pathname, error: err.message });
    sendJson(response, 500, { error: err.message });
  }
});

async function main() {
  // Listen FIRST so /health answers while the PTY spins up (the runner's
  // health-poll deadline is short; PTY readiness can take several seconds).
  server.listen(PORT, HOST, () => {
    logEvent("stdout", {
      kind: "listening",
      host: HOST,
      port: PORT,
      engine: "pty",
      model: MODEL,
      permission_mode: PERMISSION_MODE,
      composition_dir: COMPOSITION_DIR,
    });
    spawnOperative({ resume: true }).catch((err) => {
      ptyStatus = "failed";
      ptyError = err.message;
      logEvent("stderr", { kind: "spawn-failed", error: err.message });
      // Unblock waiters so pending /chat calls fail fast instead of hanging.
      readyResolve();
    });
  });
}

async function shutdown(signal) {
  logEvent("stdout", { kind: "shutdown", signal });
  // Give claude a chance to persist the conversation (so a restart can
  // --continue with context): double Ctrl-C exits the TUI cleanly. Then kill.
  try {
    if (session && session.isAlive() && !session.isTurnActive()) {
      session.writeKeys("\x03");
      await new Promise((r) => setTimeout(r, 200));
      session.writeKeys("\x03");
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch {
    /* best effort */
  }
  try {
    session?.dispose();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  logEvent("stderr", { kind: "boot-failed", error: err.message });
  process.exit(1);
});

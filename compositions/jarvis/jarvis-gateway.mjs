#!/usr/bin/env node
// Minimal Jarvis gateway — bridges the jarvis-os /chat/stream surface to
// `claude -p` (non-interactive print mode), avoiding the interactive-TUI
// claude-pty path that breaks on Claude Code 2.1.179. Same idea as the Fable
// runner (which drives `claude -p`).
//
// No bypassPermissions: in -p mode the model just converses; tools that need
// approval are denied (no TTY), so a voice assistant stays safe.
//
// Endpoints (subset the Jarvis HUD uses):
//   GET  /health                  → { ok, engine, model }
//   POST /chat/stream { message }  → SSE: open → done { reply } | error
//   GET  /channels/:id/stream      → SSE keepalive (HUD's optional /api/stream)
//
// Env (same names the http-gateway uses):
//   GARRISON_GATEWAY_HOST (127.0.0.1) / GARRISON_GATEWAY_PORT (4777)
//   GARRISON_MODEL (sonnet) / GARRISON_SYSTEM_PROMPT_PATH / GARRISON_CLAUDE_BINARY

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const HOST = process.env.GARRISON_GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GARRISON_GATEWAY_PORT ?? "4777");
const MODEL = process.env.GARRISON_MODEL ?? "sonnet";
const CLAUDE = process.env.GARRISON_CLAUDE_BINARY ?? "claude";
const SP_PATH = process.env.GARRISON_SYSTEM_PROMPT_PATH ?? "";
const SYSTEM_PROMPT = SP_PATH && existsSync(SP_PATH) ? readFileSync(SP_PATH, "utf8").trim() : "";

// Conversation memory: the first turn starts a Claude session; we capture its
// session_id and --resume it on later turns, so Jarvis remembers the context.
let sessionId = null;

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
function sseHead(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}
function sseEvent(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}
function sseComment(res, c) { try { res.write(`: ${c}\n\n`); } catch {} }

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); try { req.destroy(); } catch {} return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const method = req.method || "GET";

  if (u.pathname === "/health") {
    return jsonRes(res, 200, { ok: true, engine: "claude-print", model: MODEL, hasSystemPrompt: Boolean(SYSTEM_PROMPT) });
  }

  if (u.pathname === "/chat/stream" && method === "POST") {
    let body;
    try { body = await readJson(req); } catch (e) { return jsonRes(res, 400, { error: `bad json: ${e.message}` }); }
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return jsonRes(res, 400, { error: "message is required" });

    sseHead(res);
    sseEvent(res, "open", { ts: Date.now() });
    const ka = setInterval(() => sseComment(res, "keepalive"), 5000);

    // First turn: seed the system prompt + start a session. Later turns:
    // --resume the session (the system prompt is already in it). --output-format
    // json gives us back the session_id to carry forward.
    const args = ["-p", message, "--model", MODEL, "--output-format", "json"];
    if (sessionId) args.push("--resume", sessionId);
    else if (SYSTEM_PROMPT) args.push("--append-system-prompt", SYSTEM_PROMPT);

    const child = spawn(CLAUDE, args, { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearInterval(ka);
      if (code !== 0) {
        sseEvent(res, "error", { error: (err.trim() || `claude exited ${code}`).slice(0, 500) });
        try { res.end(); } catch {}
        return;
      }
      // Parse the JSON envelope: { result, session_id, ... }. Fall back to raw.
      let reply = out.trim();
      try {
        const parsed = JSON.parse(out.trim());
        if (typeof parsed.result === "string") reply = parsed.result.trim();
        if (typeof parsed.session_id === "string") sessionId = parsed.session_id;
      } catch { /* not JSON — use raw text */ }
      sseEvent(res, "done", { reply, session_id: sessionId ?? "jarvis" });
      try { res.end(); } catch {}
    });
    child.on("error", (e) => {
      clearInterval(ka);
      sseEvent(res, "error", { error: e.message });
      try { res.end(); } catch {}
    });
    req.on("close", () => { clearInterval(ka); try { child.kill("SIGTERM"); } catch {} });
    return;
  }

  // Optional live channel stream the HUD may open (/api/stream). Keepalive only.
  if (u.pathname.startsWith("/channels/") && u.pathname.endsWith("/stream") && method === "GET") {
    sseHead(res);
    sseComment(res, "connected");
    const ka = setInterval(() => sseComment(res, "keepalive"), 15000);
    req.on("close", () => clearInterval(ka));
    return;
  }

  jsonRes(res, 404, { error: "not found", path: u.pathname });
});

server.listen(PORT, HOST, () => {
  console.log(`[jarvis-gateway] claude -p bridge on http://${HOST}:${PORT} (model=${MODEL}, systemPrompt=${SYSTEM_PROMPT ? "set" : "none"})`);
});

const shutdown = (sig) => { console.log(`[jarvis-gateway] shutdown (${sig})`); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 2000); };
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

#!/usr/bin/env node
// Web-channel Fitting backend — mobile-first browser chat surface.
//
// Talks to the Operative through the http-gateway:
//   - POST /api/chat   → proxies gateway POST /chat/stream (SSE)
//   - GET  /api/stream → proxies gateway GET  /channels/web/stream (SSE)
// Also serves a static React bundle from dist/.
//
// LAN bind: default 127.0.0.1 (mirrors CLAUDE.md "talks only to localhost").
// User opts into 0.0.0.0 via config_schema.bind_host when they want phone access.

import { createReadStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { listThreads, getThread, ensureThread, appendMessages, deleteThread } from "./threads.mjs";

// Mirrors garrisonDir() in src/lib/claude-home.ts: GARRISON_HOME (when set)
// IS the .garrison root, else ~/.garrison. Sandboxed runs (spike drivers) set
// it so their spawned instances never touch the live install's status files;
// voice/monitor discovery below reads the same root, so a sandboxed voice
// instance is still found by a sandboxed web-channel.
function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

const STATUS_ROOT = path.join(garrisonDir(), "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "web-channel-default.json");
const MONITOR_STATUS_FILE = path.join(STATUS_ROOT, "monitor-default.json");
const VOICE_STATUS_FILE = path.join(STATUS_ROOT, "deepgram-voice.json");

const CHANNEL_ID = "web";

function parseArgs(argv) {
  const out = {
    port: Number(process.env.WEB_CHANNEL_PORT || 7083),
    host: process.env.WEB_CHANNEL_HOST || "127.0.0.1",
    gatewayUrl: process.env.GARRISON_GATEWAY_URL || "",
    tlsCert: process.env.WEB_CHANNEL_TLS_CERT || "",
    tlsKey: process.env.WEB_CHANNEL_TLS_KEY || ""
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--gateway-url") out.gatewayUrl = argv[++i];
    else if (a === "--tls-cert") out.tlsCert = argv[++i];
    else if (a === "--tls-key") out.tlsKey = argv[++i];
  }
  if (!out.gatewayUrl) {
    const h = process.env.GARRISON_GATEWAY_HOST || "127.0.0.1";
    const p = process.env.GARRISON_GATEWAY_PORT || "4777";
    out.gatewayUrl = `http://${h}:${p}`;
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
}

async function handleMonitor(req, res) {
  if (!existsSync(MONITOR_STATUS_FILE)) {
    jsonRes(res, 200, { available: false });
    return;
  }
  let info;
  try {
    info = JSON.parse(readFileSync(MONITOR_STATUS_FILE, "utf8"));
  } catch {
    jsonRes(res, 200, { available: false });
    return;
  }
  if (!info?.url) {
    jsonRes(res, 200, { available: false });
    return;
  }
  const ok = await pingHealth(info.url, 500);
  if (!ok) {
    jsonRes(res, 200, { available: false });
    return;
  }
  jsonRes(res, 200, { available: true, url: info.url });
}

function pingHealth(baseUrl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const target = new URL("/health", baseUrl);
      const req = http.request({
        method: "GET",
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        timeout: timeoutMs
      }, (res) => {
        res.resume();
        settle(res.statusCode === 200);
      });
      req.on("error", () => settle(false));
      req.on("timeout", () => { req.destroy(); settle(false); });
      req.end();
    } catch {
      settle(false);
    }
  });
}

function readVoiceInfo() {
  if (!existsSync(VOICE_STATUS_FILE)) return null;
  try {
    const info = JSON.parse(readFileSync(VOICE_STATUS_FILE, "utf8"));
    return info?.url ? info : null;
  } catch {
    return null;
  }
}

// Voice availability — mirrors handleMonitor. The web UI hides its mic / speaker
// controls when this reports unavailable.
async function handleVoiceInfo(res) {
  const info = readVoiceInfo();
  if (!info?.url) {
    jsonRes(res, 200, { available: false });
    return;
  }
  const ok = await pingHealth(info.url, 600);
  jsonRes(res, 200, ok ? { available: true, url: info.url } : { available: false });
}

// GET /api/voice/health → { available, url?, keyConfigured? } — the contract the
// shared claude-chat VoiceClient probes (<base>/voice/health). Mirrors dev-env's
// handleVoiceHealth so read-aloud lights up when deepgram-voice is running and
// degrades silently (available:false, no errors) when it is absent or its key
// is missing. Never throws to the client.
async function handleVoiceHealth(res) {
  const info = readVoiceInfo();
  if (!info?.url) {
    jsonRes(res, 200, { available: false });
    return;
  }
  const voiceUrl = String(info.url).replace(/\/$/, "");
  try {
    const probe = await fetch(`${voiceUrl}/health`, { signal: AbortSignal.timeout(2500) });
    if (!probe.ok) {
      jsonRes(res, 200, { available: false, url: voiceUrl });
      return;
    }
    const h = await probe.json().catch(() => ({}));
    jsonRes(res, 200, { available: true, url: voiceUrl, keyConfigured: h.keyConfigured !== false });
  } catch {
    jsonRes(res, 200, { available: false, url: voiceUrl });
  }
}

// Binary proxy to the voice Fitting. Used for both /stt (audio in → JSON) and
// /tts (JSON in → audio out). pipeUpstreamSse/readJsonBody can't carry binary
// bodies, so this buffers the request and pipes the upstream response straight
// back, preserving the upstream Content-Type (audio/* or application/json).
// Same-origin so the browser needs no CORS, and the Deepgram key stays on the
// voice Fitting — the web UI never sees it.
async function handleVoiceProxy(req, res, subpath) {
  const info = readVoiceInfo();
  if (!info?.url) {
    jsonRes(res, 503, { error: "voice fitting not available" });
    return;
  }
  let body;
  try {
    body = await readRawBody(req);
  } catch (err) {
    jsonRes(res, 400, { error: `bad body: ${err.message}` });
    return;
  }
  const target = new URL(subpath, info.url);
  const upstream = http.request(
    {
      method: "POST",
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/octet-stream",
        "Content-Length": body.length
      }
    },
    (up) => {
      res.statusCode = up.statusCode || 502;
      if (up.headers["content-type"]) res.setHeader("Content-Type", up.headers["content-type"]);
      res.setHeader("Cache-Control", "no-store");
      up.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    try { jsonRes(res, 502, { error: `voice upstream: ${err.message}` }); } catch {}
  });
  upstream.end(body);
}

// Pure passthrough relay: browser WS ⇄ voice Fitting /stream WS. Binary (PCM)
// and text (control + transcript events) are forwarded verbatim in both
// directions; frames sent before the upstream opens are buffered briefly.
function relayVoiceStream(client, voiceHttpUrl, search) {
  const upstreamUrl = voiceHttpUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/stream" + (search || "");
  const upstream = new WebSocket(upstreamUrl);
  const pending = [];

  upstream.on("open", () => {
    for (const { data, isBinary } of pending) upstream.send(data, { binary: isBinary });
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", () => { try { client.close(); } catch {} });
  upstream.on("error", () => { try { client.close(); } catch {} });

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else pending.push({ data, isBinary });
  });
  client.on("close", () => { try { upstream.close(); } catch {} });
  client.on("error", () => { try { upstream.close(); } catch {} });
}

function readRawBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pipeUpstreamSse(req, res, upstreamOpts, upstreamBody) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const upstream = http.request(upstreamOpts, (up) => {
    if (up.statusCode && up.statusCode >= 400) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: `upstream ${up.statusCode}` })}\n\n`);
      up.resume();
      res.end();
      return;
    }
    up.on("data", (chunk) => {
      try { res.write(chunk); } catch {}
    });
    up.on("end", () => {
      try { res.end(); } catch {}
    });
    up.on("error", (err) => {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`); } catch {}
      try { res.end(); } catch {}
    });
  });
  upstream.on("error", (err) => {
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } catch {}
  });
  req.on("close", () => {
    try { upstream.destroy(); } catch {}
  });
  if (upstreamBody !== undefined) {
    upstream.write(upstreamBody);
  }
  upstream.end();
}

// SSE proxy for POST /api/chat with SERVER-SIDE turn persistence. Differs from
// pipeUpstreamSse in two deliberate ways:
//   1. It watches the upstream stream for the `done` event and tees the exchange
//      (user message + settled reply) into the thread store, so the transcript
//      survives navigation/tab-close mid-turn.
//   2. It does NOT propagate client-close to the gateway request - the turn runs
//      to `done` server-side so the reply is persisted and the task is never
//      orphaned invisibly. Writes to a gone client are simply skipped.
function pipeChatSse(req, res, upstreamOpts, upstreamBody, { threadId, userMessage } = {}) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let clientGone = false;
  req.on("close", () => { clientGone = true; });
  req.on("error", () => { clientGone = true; });
  res.on("error", () => { clientGone = true; });
  const clientWrite = (chunk) => {
    if (clientGone || res.writableEnded || res.destroyed) return;
    try { res.write(chunk); } catch { clientGone = true; }
  };
  const clientEnd = () => {
    if (res.writableEnded || res.destroyed) return;
    try { res.end(); } catch { /* gone */ }
  };

  let persisted = false;
  const persistDone = (reply) => {
    if (persisted || !threadId) return;
    persisted = true;
    const messages = [{ role: "user", text: userMessage }];
    if (typeof reply === "string" && reply.trim()) messages.push({ role: "assistant", text: reply });
    appendMessages(threadId, messages).catch((err) => {
      console.error(`[web-channel] failed to persist turn into thread ${threadId}: ${err.message}`);
    });
  };
  // Scan the upstream SSE frames for the `done` event (same block parse as the
  // browser client). The gateway JSON-stringifies each payload on one data line.
  let scanBuf = "";
  const scanForDone = (chunk) => {
    scanBuf += chunk.toString("utf8");
    let idx;
    while ((idx = scanBuf.indexOf("\n\n")) !== -1) {
      const block = scanBuf.slice(0, idx);
      scanBuf = scanBuf.slice(idx + 2);
      let name = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (name !== "done") continue;
      let payload = {};
      try { payload = data ? JSON.parse(data) : {}; } catch { /* ignore */ }
      persistDone(payload?.reply);
    }
  };

  const upstream = http.request(upstreamOpts, (up) => {
    if (up.statusCode && up.statusCode >= 400) {
      clientWrite(`event: error\ndata: ${JSON.stringify({ error: `upstream ${up.statusCode}` })}\n\n`);
      up.resume();
      clientEnd();
      return;
    }
    up.on("data", (chunk) => {
      scanForDone(chunk);
      clientWrite(chunk);
    });
    up.on("end", () => clientEnd());
    up.on("error", (err) => {
      clientWrite(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      clientEnd();
    });
  });
  upstream.on("error", (err) => {
    clientWrite(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    clientEnd();
  });
  if (upstreamBody !== undefined) {
    upstream.write(upstreamBody);
  }
  upstream.end();
}

function handleStream(req, res, opts) {
  const target = new URL(`/channels/${CHANNEL_ID}/stream`, opts.gatewayUrl);
  pipeUpstreamSse(req, res, {
    method: "GET",
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: { Accept: "text/event-stream" }
  });
}

// Rich chat surface: proxy /api/claude/* to the gateway's /claude/*. The SSE
// stream uses pipeUpstreamSse; the JSON actions buffer + forward.
function handleClaudeStream(req, res, opts) {
  const target = new URL("/claude/stream", opts.gatewayUrl);
  pipeUpstreamSse(req, res, {
    method: "GET",
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: { Accept: "text/event-stream" }
  });
}

async function handleClaudeProxy(req, res, opts, subpath, method) {
  let payload;
  if (method === "POST") {
    try {
      payload = JSON.stringify(await readJsonBody(req));
    } catch (err) {
      return jsonRes(res, 400, { error: `invalid json: ${err.message}` });
    }
  }
  const target = new URL(`/claude/${subpath}`, opts.gatewayUrl);
  const headers = { Accept: "application/json" };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  const upstream = http.request(
    { method, hostname: target.hostname, port: target.port, path: target.pathname + (target.search || ""), headers },
    (up) => {
      res.statusCode = up.statusCode || 502;
      res.setHeader("Content-Type", up.headers["content-type"] || "application/json");
      up.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    try { jsonRes(res, 502, { error: `gateway: ${err.message}` }); } catch {}
  });
  if (payload !== undefined) upstream.write(payload);
  upstream.end();
}

async function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

// ── Brief documents (view + edit the Discuss brief in the channel) ───────────
// The web channel edits the markdown brief a Discuss session produces. The brief's
// ABSOLUTE path is handed in by the host (Kanban / Automations) via the Discuss
// context (briefAbsPath) — the channel never derives it. Direct file access is safe
// here because it is CONFINED: a path is accepted only if, after normalising +
// expanding "~", it is absolute, ends in ".md", contains no "..", lives inside a
// directory literally named "briefs", AND its deepest existing ancestor realpaths
// under the user's home dir (blocks symlink escape + any out-of-home write). This is
// a local, single-user app (localhost only), so "*.md under ~/**/briefs/" is the
// whole attack surface a tampered context could reach.
export function resolveBriefPath(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let p = raw.trim();
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) return null;
  const norm = path.normalize(p);
  if (!norm.toLowerCase().endsWith(".md")) return null;
  const segs = norm.split(path.sep);
  if (segs.includes("..")) return null;
  // Accept either a file inside a "briefs/" dir (project / automation briefs) OR any
  // file under the Garrison store ~/.garrison/ (the card-owned kanban brief at
  // ~/.garrison/kanban-loop/cards/<id>/brief.md).
  const garrisonStore = path.join(os.homedir(), ".garrison") + path.sep;
  const inBriefsDir = path.dirname(norm).split(path.sep).includes("briefs");
  const inGarrisonStore = norm.startsWith(garrisonStore);
  if (!inBriefsDir && !inGarrisonStore) return null;
  // Realpath the deepest EXISTING ancestor (the brief file itself may not exist yet)
  // and require it under the real home dir.
  let anc = path.dirname(norm);
  while (!existsSync(anc) && path.dirname(anc) !== anc) anc = path.dirname(anc);
  let realAnc;
  let realHome;
  try {
    realAnc = realpathSync(anc);
    realHome = realpathSync(os.homedir());
  } catch {
    return null;
  }
  if (realAnc !== realHome && !realAnc.startsWith(realHome + path.sep)) return null;
  return norm;
}

async function handleBriefGet(res, rawPath) {
  const p = resolveBriefPath(rawPath);
  if (!p) return jsonRes(res, 400, { error: "invalid or out-of-bounds brief path" });
  try {
    const content = await readFile(p, "utf8");
    jsonRes(res, 200, { exists: true, path: p, content });
  } catch (err) {
    if (err.code === "ENOENT") return jsonRes(res, 200, { exists: false, path: p, content: "" });
    jsonRes(res, 500, { error: err.message });
  }
}

async function handleBriefPut(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return jsonRes(res, 400, { error: `invalid json: ${err.message}` });
  }
  const p = resolveBriefPath(body?.path);
  if (!p) return jsonRes(res, 400, { error: "invalid or out-of-bounds brief path" });
  const content = typeof body?.content === "string" ? body.content : "";
  if (content.length > 512 * 1024) return jsonRes(res, 413, { error: "brief too large (512 KB cap)" });
  try {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");
    jsonRes(res, 200, { ok: true, path: p });
  } catch (err) {
    jsonRes(res, 500, { error: err.message });
  }
}

// Build the gateway /chat/stream body from a channel request. GENERIC by
// design: a fitting hands this channel an OPAQUE `context` blob and a `mode`
// string and the channel forwards them verbatim — it never inspects or
// interprets them (a card, a Dev Env session, James/Joe/Gary, anything). The
// gateway's souls-mode honors `mode` + a classification hint; the channel just
// passes through.
//
// Backward-compat contract (asserted by tests/web-channel-context.test.ts):
//   - context/mode absent     → EXACTLY { message, channel: "web" }
//   - context present          → adds `context` (forwarded untouched)
//   - mode present (non-empty) → adds `mode`
// `message` is required upstream; `channel` is always pinned to "web".
export function buildGatewayChatBody({ message, context, mode, classification, sessionId } = {}) {
  const body = { message, channel: CHANNEL_ID };
  if (context !== undefined && context !== null) body.context = context;
  if (typeof mode === "string" && mode.trim()) body.mode = mode.trim();
  // D19: the conversation's thread id, forwarded as the gateway's session key so a
  // multi-turn thread attaches to ONE card instead of registering a duplicate per
  // turn. Absent → the gateway falls back to the channel name.
  if (typeof sessionId === "string" && sessionId.trim()) body.sessionId = sessionId.trim();
  // Forward an explicit routing hint (the interactive Discuss path sends
  // { taskType, tier: "T0-trivial" } to keep extended thinking OFF — thinking on a
  // "design a process" prompt trips Anthropic's usage-policy classifier). The gateway
  // validates it (routeHintsFromBody); a malformed hint is simply ignored there.
  if (classification && typeof classification === "object") body.classification = classification;
  return body;
}

async function handleChat(req, res, opts) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonRes(res, 400, { error: `invalid json: ${err.message}` });
    return;
  }
  const message = typeof body?.message === "string" ? body.message : "";
  if (!message.trim()) {
    jsonRes(res, 400, { error: "message is required" });
    return;
  }
  // The client's thread id (never forwarded to the gateway) - the exchange is
  // persisted into it server-side when the upstream `done` event arrives.
  const threadId = typeof body?.thread === "string" && body.thread.trim() ? body.thread.trim() : null;
  // Forward the opaque context + mode + optional routing hint through to the gateway.
  const payload = JSON.stringify(
    buildGatewayChatBody({ message, context: body?.context, mode: body?.mode, classification: body?.classification, sessionId: threadId })
  );
  const target = new URL("/chat/stream", opts.gatewayUrl);
  pipeChatSse(req, res, {
    method: "POST",
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Accept: "text/event-stream"
    }
  }, payload, { threadId, userMessage: message });
}

// Answer an AskUserQuestion picker (a tapped option label / free text / dismiss).
// Buffers the JSON and forwards to the gateway's POST /chat/answer, which drives
// the live TUI picker. Same shape as handleClaudeProxy but on the /chat path.
async function handleChatAnswer(req, res, opts) {
  let payload;
  try {
    payload = JSON.stringify(await readJsonBody(req));
  } catch (err) {
    return jsonRes(res, 400, { error: `invalid json: ${err.message}` });
  }
  const target = new URL("/chat/answer", opts.gatewayUrl);
  const upstream = http.request(
    {
      method: "POST",
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Accept: "application/json"
      }
    },
    (up) => {
      res.statusCode = up.statusCode || 502;
      res.setHeader("Content-Type", up.headers["content-type"] || "application/json");
      up.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    try { jsonRes(res, 502, { error: `gateway: ${err.message}` }); } catch {}
  });
  upstream.write(payload);
  upstream.end();
}

// ── Conversation threads (session list + history) ──────────────────────────
// Generic, opaque-keyed transcript organizer over the one rolling operative. The
// server persists each completed exchange itself (handleChat tees the upstream
// `done` event into the thread the client named) and lists/serves prior threads
// so the UI can show a session list and move between conversations.
async function handleThreadsList(res) {
  jsonRes(res, 200, { threads: await listThreads() });
}

async function handleThreadCreate(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return jsonRes(res, 400, { error: `invalid json: ${err.message}` }); }
  const thread = await ensureThread({
    id: typeof body?.id === "string" ? body.id : undefined,
    title: typeof body?.title === "string" ? body.title : undefined,
    source: typeof body?.source === "string" ? body.source : undefined,
    mode: typeof body?.mode === "string" ? body.mode : undefined,
    context: body?.context,
  });
  jsonRes(res, 200, { thread });
}

async function handleThreadGet(res, id) {
  const thread = await getThread(id);
  if (!thread) return jsonRes(res, 404, { error: "thread not found" });
  jsonRes(res, 200, { thread });
}

async function handleThreadAppend(req, res, id) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return jsonRes(res, 400, { error: `invalid json: ${err.message}` }); }
  try {
    jsonRes(res, 200, { thread: await appendMessages(id, body?.messages) });
  } catch (err) {
    jsonRes(res, 400, { error: err.message });
  }
}

async function handleThreadDelete(res, id) {
  const ok = await deleteThread(id);
  jsonRes(res, ok ? 200 : 404, { ok });
}

// Route /api/threads, /api/threads/:id, /api/threads/:id/messages. Returns true
// when it handled the request.
function routeThreads(req, res, pathname, method) {
  if (pathname === "/api/threads" && method === "GET") { void handleThreadsList(res); return true; }
  if (pathname === "/api/threads" && method === "POST") { void handleThreadCreate(req, res); return true; }
  if (pathname.startsWith("/api/threads/")) {
    const parts = pathname.slice("/api/threads/".length).split("/").filter(Boolean).map((p) => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
    const id = parts[0];
    if (id && parts.length === 1 && method === "GET") { void handleThreadGet(res, id); return true; }
    if (id && parts.length === 1 && method === "DELETE") { void handleThreadDelete(res, id); return true; }
    if (id && parts.length === 2 && parts[1] === "messages" && method === "POST") { void handleThreadAppend(req, res, id); return true; }
  }
  return false;
}

function serveStatic(req, res, distDir) {
  let pathname = url.parse(req.url).pathname || "/";
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(distDir, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(distDir)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    const indexFallback = path.join(distDir, "index.html");
    if (existsSync(indexFallback)) {
      const data = readFileSync(indexFallback);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end(data);
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("web-channel: dist/ not built yet — run `node ui/build.mjs` in the Fitting directory.");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const ctMap = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".map": "application/json"
  };
  res.statusCode = 200;
  res.setHeader("Content-Type", ctMap[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
}

// True when `pid` names a live process (EPERM still means alive, just not ours).
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function readStatusFile() {
  try {
    return JSON.parse(await readFile(STATUS_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: "web-channel-default",
    port: opts.port,
    url: `${opts.scheme ?? "http"}://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const distDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "dist");

  // Port discipline: never overwrite a status file whose pid is a LIVE other
  // process - a second spawn must fail loudly instead of silently stealing the
  // tracking slot and orphaning the first instance (the two-generations bug).
  const existing = await readStatusFile();
  if (existing && Number.isInteger(existing.pid) && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(
      `[web-channel] refusing to start: ${STATUS_FILE} tracks a live instance ` +
      `(pid ${existing.pid}, ${existing.url ?? `port ${existing.port}`}) - stop it first`
    );
    process.exit(1);
  }
  // Optional TLS so mobile browsers get a secure context (getUserMedia / mic
  // capture is blocked on plain http over a LAN IP). When tls_cert/tls_key are
  // configured and readable, serve https; otherwise plain http (localhost is a
  // secure context, so desktop dev and Playwright are unaffected).
  let tls = null;
  if (opts.tlsCert && opts.tlsKey && existsSync(opts.tlsCert) && existsSync(opts.tlsKey)) {
    try {
      tls = { cert: readFileSync(opts.tlsCert), key: readFileSync(opts.tlsKey) };
    } catch (err) {
      console.error(`[web-channel] failed to read TLS cert/key, falling back to http: ${err.message}`);
      tls = null;
    }
  }
  const liveOpts = { ...opts, scheme: tls ? "https" : "http" };

  const requestHandler = async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health" || pathname === "/api/health") return handleHealth(req, res, liveOpts);
      // Presence heartbeat relay (GARRISON-UNIFY-V1 S14, D34): the UI POSTs
      // same-origin; relay to the Power fitting via its status file. Power
      // absent → 204 silently (advisory).
      if (pathname === "/power-heartbeat" && method === "POST") {
        try {
          const statusFile = path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "ui-fittings", "power-default.json");
          const st = JSON.parse(readFileSync(statusFile, "utf8"));
          const base = st.url || `http://127.0.0.1:${st.port}`;
          await fetch(`${base}/presence`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ source: "web-channel" }),
            signal: AbortSignal.timeout(1500)
          });
        } catch { /* advisory */ }
        res.statusCode = 204;
        return res.end();
      }
      if (pathname === "/api/monitor" && method === "GET") return handleMonitor(req, res);
      if (pathname === "/api/voice/health" && method === "GET") return handleVoiceHealth(res);
      if (pathname === "/api/voice" && method === "GET") return handleVoiceInfo(res);
      if (pathname === "/api/voice/stt" && method === "POST") return handleVoiceProxy(req, res, "/stt");
      if (pathname === "/api/voice/tts" && method === "POST") return handleVoiceProxy(req, res, "/tts");
      if (pathname === "/api/stream" && method === "GET") return handleStream(req, res, liveOpts);
      if (pathname === "/api/chat/answer" && method === "POST") return handleChatAnswer(req, res, liveOpts);
      if (pathname === "/api/chat" && method === "POST") return handleChat(req, res, liveOpts);
      if (pathname === "/api/brief" && method === "GET") return handleBriefGet(res, parsed.query.path);
      if (pathname === "/api/brief" && method === "PUT") return handleBriefPut(req, res);
      if (pathname.startsWith("/api/threads") && routeThreads(req, res, pathname, method)) return;
      if (pathname === "/api/claude/stream" && method === "GET") return handleClaudeStream(req, res, liveOpts);
      if (pathname === "/api/claude/status" && method === "GET") return handleClaudeProxy(req, res, liveOpts, "status", "GET");
      if (pathname === "/api/claude/commands" && method === "GET") return handleClaudeProxy(req, res, liveOpts, "commands", "GET");
      if (pathname === "/api/claude/message" && method === "POST") return handleClaudeProxy(req, res, liveOpts, "message", "POST");
      if (pathname === "/api/claude/keys" && method === "POST") return handleClaudeProxy(req, res, liveOpts, "keys", "POST");
      if (pathname === "/api/claude/mode" && method === "POST") return handleClaudeProxy(req, res, liveOpts, "mode", "POST");
      if (pathname === "/api/claude/interrupt" && method === "POST") return handleClaudeProxy(req, res, liveOpts, "interrupt", "POST");
      if (pathname === "/api/claude/answer" && method === "POST") return handleClaudeProxy(req, res, liveOpts, "answer", "POST");
      if (pathname.startsWith("/api/")) {
        jsonRes(res, 404, { error: "not found", path: pathname });
        return;
      }
      return serveStatic(req, res, distDir);
    } catch (err) {
      console.error("[web-channel] handler error:", err);
      jsonRes(res, 500, { error: err.message });
    }
  };

  const server = tls
    ? https.createServer(tls, requestHandler)
    : http.createServer(requestHandler);

  // Streaming voice: pure passthrough WS relay browser ⇄ voice Fitting /stream.
  // No parsing — all Deepgram logic stays in the voice Fitting; the key never
  // reaches the browser. The page connects to /api/voice/stream (wss when this
  // server is TLS), and we forward the query (sample_rate) verbatim.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const parsed = url.parse(request.url || "/", true);
    if (parsed.pathname !== "/api/voice/stream") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const info = readVoiceInfo();
    if (!info?.url) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => relayVoiceStream(client, info.url, parsed.search || ""));
  });

  // Bind the CONFIGURED port only - no findFreePort auto-shift. A busy port is a
  // hard, loud failure so the runner surfaces the conflict instead of the server
  // silently splitting brain across two ports.
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[web-channel] port ${liveOpts.port} on ${liveOpts.host} is already in use - refusing to auto-shift; free the port or change the configured port`);
    } else {
      console.error(`[web-channel] server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(liveOpts.port, liveOpts.host, async () => {
    await writeStatusFile(liveOpts);
    console.log(`[web-channel] listening on ${liveOpts.scheme}://${liveOpts.host}:${liveOpts.port} (gateway=${liveOpts.gatewayUrl})`);
  });

  const shutdown = async (signal) => {
    console.log(`[web-channel] shutdown (${signal})`);
    await clearStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { server, options: liveOpts };
}

const isDirect = (() => {
  if (!import.meta.url) return false;
  try {
    return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isDirect) {
  startServer().catch((err) => {
    console.error("[web-channel] failed to start:", err);
    process.exit(1);
  });
}

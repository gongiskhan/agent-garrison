#!/usr/bin/env node
// Web-channel Fitting backend — mobile-first browser chat surface.
//
// Talks to the Operative through the http-gateway:
//   - POST /api/chat            → proxies gateway POST /chat/stream (SSE)
//   - GET  /api/stream          → proxies gateway GET  /channels/web/stream (SSE)
//   - POST /api/chat/interrupt  → proxies gateway POST /chat/interrupt (Stop)
//   - GET  /api/route-options   → gateway GET /route/options + the board's /projects
// Also serves a static React bundle from dist/.
//
// Every gateway/board call is fronted same-origin like that: this fitting serves its
// own origin and the browser is almost never on this box, so it can neither reach
// Garrison's Next /api/* nor be handed a machine-local upstream URL.
//
// LAN bind: default 127.0.0.1 (mirrors CLAUDE.md "talks only to localhost").
// User opts into 0.0.0.0 via config_schema.bind_host when they want phone access.

import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile, appendFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  listThreads,
  getThread,
  ensureThread,
  appendMessages,
  deleteThread,
  setThreadSession,
  setThreadRouting,
  threadExistsSync,
  sanitizeRouteMeta,
  sanitizeRouting,
  markRunning,
  appendLiveFrame,
  subscribeLive,
  clearRunning,
  runningSince,
  runningThreadIds
} from "./threads.mjs";
import { SseFrameDecoder, formatSseFrame } from "../lib/live-event-stream.mjs";
import { getTailnetServeMap } from "../lib/tailnet-serve.mjs";
import {
  readJsonlLines,
  parseTranscriptLines,
  extractRelatedTaskRecords,
  relatedTaskEvents
} from "../lib/session-transcript.mjs";
import { sendPush } from "../lib/webpush.mjs";
import { readSubscriptions, saveSubscription, removeSubscription, vapidFromEnv } from "../lib/push-store.mjs";

// Mirrors garrisonDir() in src/lib/claude-home.ts: GARRISON_HOME (when set)
// IS the .garrison root, else ~/.garrison. Sandboxed runs (spike drivers) set
// it so their spawned instances never touch the live install's status files;
// voice discovery below reads the same root, so a sandboxed voice
// instance is still found by a sandboxed web-channel.
function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

const STATUS_ROOT = path.join(garrisonDir(), "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "web-channel-default.json");
const VOICE_STATUS_FILE = path.join(STATUS_ROOT, "deepgram-voice.json");

const CHANNEL_ID = "web";

function parseArgs(argv) {
  const out = {
    // Port precedence (house convention, same as improver/ports-default):
    // runner-projected composition config first (per-instance, e.g. main=7083
    // vs codex=27083), then the legacy explicit env (tests), then the default.
    port: Number(process.env.GARRISON_WEBCHANNELDEFAULT_PORT || process.env.WEB_CHANNEL_PORT || 7083),
    host: process.env.GARRISON_WEBCHANNELDEFAULT_BIND_HOST || process.env.WEB_CHANNEL_HOST || process.env.GARRISON_BIND_HOST || "127.0.0.1",
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

// Voice availability. The web UI hides its mic / speaker
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

// Pure passthrough relay: browser WS ⇄ a voice Fitting WS endpoint (STT /stream
// or read-aloud /tts-stream). Binary (PCM audio) and text (control + transcript
// events) are forwarded verbatim in both directions; frames sent before the
// upstream opens are buffered briefly. All Deepgram logic — and the API key —
// stay on the voice Fitting; this hop only shuttles frames.
// Cap on frames buffered before the upstream voice socket opens (codex S6a
// finding: an unbounded relay buffer is a memory-DoS if the upstream stalls).
const MAX_RELAY_PENDING = 256;

function relayVoiceStream(client, voiceHttpUrl, search, subpath = "/stream") {
  const upstreamUrl = voiceHttpUrl.replace(/^http/, "ws").replace(/\/+$/, "") + subpath + (search || "");
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
    else if (pending.length >= MAX_RELAY_PENDING) {
      // Pre-open buffer overflow — upstream stalled; tear both legs down.
      try { client.close(); } catch {}
      try { upstream.close(); } catch {}
    } else pending.push({ data, isBinary });
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

// ── Run context: attribution in, pins out ───────────────────────────────────
// Contract: docs/decisions/2026-07-25-web-channel-run-context.md (§1, §2, §4, §10).

// Wire spellings the gateway has always used that do NOT match the contract's
// RouteAttribution field names. Everything else on a `route` / `done` frame is
// already camelCase, and sanitizeRouteMeta drops whatever is not whitelisted - so
// only the genuinely-renamed keys need aliasing here. Without this the session id
// (the one field that makes the per-message transcript drill-down possible) would
// be silently dropped as an unknown key.
const FRAME_FIELD_ALIASES = {
  session_id: "sessionId",
  transcript_path: "transcriptPath",
  stopped_by_user: "stoppedByUser",
  stopped_reason: "stoppedReason"
};

/**
 * Normalise a gateway `route` / `done` frame into a persistable RouteAttribution.
 * Pure; returns null when the frame carried no attribution at all (null and absent
 * mean the same thing to every consumer - a missing badge, never a fake one).
 */
export function attributionFromFrame(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  const merged = { ...frame };
  for (const [wire, field] of Object.entries(FRAME_FIELD_ALIASES)) {
    if (Object.hasOwn(frame, wire) && merged[field] === undefined) merged[field] = frame[wire];
  }
  return sanitizeRouteMeta(merged);
}

/**
 * Effective pins for ONE turn: the thread's persisted TurnRouting with this
 * request's `routing` laid over it. Per-turn wins, and an explicit null CLEARS that
 * dimension for this turn only - the persisted pin is untouched, since the rail owns
 * it through PUT /api/threads/:id/routing. sanitizeRouting cannot express the clear
 * (it treats null and absent alike), so it is applied here against the raw body.
 * Returns null when nothing is pinned, so `buildGatewayChatBody` stays byte-identical
 * for an unpinned turn.
 */
export function mergeTurnRouting(pinned, perTurn) {
  const merged = { ...(sanitizeRouting(pinned) ?? {}), ...(sanitizeRouting(perTurn) ?? {}) };
  if (perTurn && typeof perTurn === "object" && !Array.isArray(perTurn)) {
    for (const [key, value] of Object.entries(perTurn)) {
      // Only a key the sanitizers already accepted can be cleared, so a hostile or
      // unknown key cannot reach `delete` at all.
      if (value === null && Object.hasOwn(merged, key)) delete merged[key];
    }
  }
  return Object.keys(merged).length ? merged : null;
}

// SSE proxy for POST /api/chat with SERVER-SIDE turn persistence. Differs from
// pipeUpstreamSse in two deliberate ways:
//   1. It watches the upstream stream for the `done` event and tees the exchange
//      (user message + settled reply) into the thread store, so the transcript
//      survives navigation/tab-close mid-turn.
//   2. It does NOT propagate client-close to the gateway request - the turn runs
//      to `done` server-side so the reply is persisted and the task is never
//      orphaned invisibly. Writes to a gone client are simply skipped.
function pipeChatSse(req, res, upstreamOpts, upstreamBody, { threadId } = {}) {
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

  // Attribution from the PRE-TURN `route` frame (contract §4: the frame is emitted
  // twice, once right after the route resolves and once folded into `done`). Merged,
  // never clobbered, so the pre-turn frame survives as the only attribution we have
  // when the turn never reaches `done`.
  let preRoute = null;
  let persisted = false;
  // handleChat persisted the user entry and marked the stream running BEFORE it
  // opened the upstream. Keep all subsequent thread writes serialized: a route
  // frame can carry the session id milliseconds before `done`, and two concurrent
  // read-modify-writes would otherwise lose either that id or the assistant reply.
  let persistence = Promise.resolve();
  const queueThreadWrite = (work) => {
    persistence = persistence.then(work).catch((err) => {
      console.error(`[web-channel] failed to persist live turn into thread ${threadId}: ${err.message}`);
    });
    return persistence;
  };
  const markSettled = () => { if (threadId) clearRunning(threadId); };
  const queueSession = (payload) => {
    const sid = payload?.session_id ?? payload?.sessionId;
    if (!threadId || !sid) return persistence;
    return queueThreadWrite(() => setThreadSession(threadId, String(sid)));
  };

  const persistDone = (payload) => {
    if (persisted) return;
    persisted = true;
    if (!threadId) return markSettled();
    const reply = payload?.reply;
    if (typeof reply === "string" && reply.trim()) {
      // The whole turn, not just its text: the resolved attribution rides in the
      // message so the badges survive a reload and the 10s thread poll's remount
      // (contract §10), and so the per-turn sessionId can open THIS turn's transcript
      // rather than the thread-level last-write-wins one (§12).
      queueThreadWrite(() => appendMessages(threadId, [{
        role: "assistant",
        text: reply,
        route: attributionFromFrame({ ...(preRoute ?? {}), ...payload }) ?? undefined
      }]));
    }
    // The Claude session id is also thread-level so /api/session-stream?thread=<id>
    // resolves without a message id. A pre-turn route may already have stored it;
    // setThreadSession is idempotent.
    queueSession(payload);
    // Keep the live stream discoverable until the settled reply is on disk. This
    // closes the tiny "running=false but history not written yet" reload gap.
    void persistence.finally(markSettled);
  };

  // Before this, NOTHING was persisted when a turn errored or `done` never arrived -
  // not even the user's message, so a failed or cancelled turn vanished from the
  // transcript on the next reload. Keeps whatever the pre-turn route frame already
  // told us so the rail can still say which lane broke.
  const persistFailed = (reason) => {
    if (persisted) return;
    persisted = true;
    if (!threadId) return markSettled();
    const why = String(reason || "turn did not complete").slice(0, 200);
    // `pending: null` drops the pre-turn frame's pending flag: this turn is over,
    // badly, and a persisted "still running" marker would be a lie.
    const route = attributionFromFrame({ ...(preRoute ?? {}), pending: null, stoppedReason: why });
    queueThreadWrite(() => appendMessages(threadId, [
      { role: "assistant", text: `_Turn did not complete: ${why}._`, route: route ?? undefined }
    ]));
    void persistence.finally(markSettled);
  };

  // Tee EVERY named upstream frame into the generic live journal before applying
  // chat-specific persistence. The data string is retained verbatim, including a
  // chunk's `replace:true`, so replay follows the exact same reducer as live send.
  const scanUpstream = new SseFrameDecoder(({ event: name, data }) => {
    if (threadId) appendLiveFrame(threadId, { event: name, data });
    let payload = {};
    try { payload = data ? JSON.parse(data) : {}; } catch { /* leave it observable, but do not interpret it */ }
    if (name === "route") {
      preRoute = { ...(preRoute ?? {}), ...payload };
      // Agent SDK and any future runtime can publish its session coordinate on a
      // route frame. Store it immediately; rich transcript discovery no longer
      // waits for a terminal `done` that may be minutes away.
      queueSession(payload);
      return;
    }
    if (name === "error") {
      persistFailed(String(payload?.error ?? "stream error"));
      return;
    }
    if (name === "done") persistDone(payload);
  });

  const emitLocalError = (message) => {
    const data = JSON.stringify({ error: String(message) });
    if (threadId) appendLiveFrame(threadId, { event: "error", data });
    clientWrite(`event: error\ndata: ${data}\n\n`);
  };

  const upstream = http.request(upstreamOpts, (up) => {
    if (up.statusCode && up.statusCode >= 400) {
      emitLocalError(`upstream ${up.statusCode}`);
      up.resume();
      persistFailed(`upstream ${up.statusCode}`);
      clientEnd();
      return;
    }
    up.on("data", (chunk) => {
      scanUpstream.push(chunk);
      clientWrite(chunk);
    });
    up.on("end", () => {
      // End WITHOUT a done frame: the gateway died, was restarted, or the turn was
      // killed upstream. The latch means a normal end after `done` is a no-op.
      persistFailed("the gateway stream ended without a done event");
      clientEnd();
    });
    up.on("error", (err) => {
      emitLocalError(err.message);
      persistFailed(err.message);
      clientEnd();
    });
  });
  upstream.on("error", (err) => {
    emitLocalError(err.message);
    persistFailed(err.message);
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

// Attach/paste uploads: proxy /api/attachments to the gateway's POST /attachments
// (filename + base64 content in, {path, bytes} out — the gateway saves the file
// to disk under its own uploads dir; Claude reads it back by path). Base64
// inflates payloads ~33%, so this needs a bigger body cap than the default
// readJsonBody limit — matched to the gateway's own 10MB MAX_UPLOAD_BYTES plus
// headroom for the JSON envelope.
const MAX_ATTACHMENT_BODY = 14 * 1024 * 1024;
async function handleAttachments(req, res, opts) {
  let payload;
  try {
    payload = JSON.stringify(await readJsonBody(req, MAX_ATTACHMENT_BODY));
  } catch (err) {
    return jsonRes(res, 400, { error: `invalid json: ${err.message}` });
  }
  const target = new URL("/attachments", opts.gatewayUrl);
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
  const upstream = http.request(
    { method: "POST", hostname: target.hostname, port: target.port, path: target.pathname, headers },
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
  const garrisonStore = (process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison")) + path.sep;
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
// design: a fitting hands this channel an opaque `context` blob and optional
// explicit routing fields; the channel forwards them without interpreting the
// card or domain payload.
//
// Backward-compat contract (asserted by tests/web-channel-context.test.ts):
//   - context absent          → EXACTLY { message, channel: "web" }
//   - context present          → adds `context` (forwarded untouched)
// `message` is required upstream; `channel` is always pinned to "web".
export function buildGatewayChatBody({ message, context, classification, sessionId, routing, turnSeq } = {}) {
  const body = { message, channel: CHANNEL_ID };
  if (context !== undefined && context !== null) body.context = context;
  // D19: the conversation's thread id, forwarded as the gateway's session key so a
  // multi-turn thread attaches to ONE card instead of registering a duplicate per
  // turn. Absent → the gateway falls back to the channel name.
  if (typeof sessionId === "string" && sessionId.trim()) body.sessionId = sessionId.trim();
  // Forward an explicit routing hint (the interactive Discuss path sends
  // { taskType, tier: "T0-trivial" } to keep extended thinking OFF — thinking on a
  // "design a process" prompt trips Anthropic's usage-policy classifier). The gateway
  // validates it (routeHintsFromBody); a malformed hint is simply ignored there.
  if (classification && typeof classification === "object") body.classification = classification;
  // The turn's effective pins (contract §3: body.routing -> routeHintsFromBody ->
  // applyTurnOverride). Emitted only when something is actually pinned - an unpinned
  // turn's body must stay byte-identical to the pre-run-context shape.
  if (routing && typeof routing === "object" && !Array.isArray(routing) && Object.keys(routing).length > 0) {
    body.routing = routing;
  }
  // Monotonic per-send counter (contract §5). The gateway echoes it on both `route`
  // frames so the client can DROP a frame belonging to an older turn.
  if (Number.isInteger(turnSeq) && turnSeq >= 0) body.turnSeq = turnSeq;
  return body;
}

// ─────────────────────────── S3b: materialized-turn context assembly (D8)
//
// A web thread is an ORIGIN, not a session: nothing runs and nothing holds context
// between messages. Each user message MATERIALIZES a turn — the server assembles a
// BOUNDED deterministic context block (recent thread window + this thread's board
// cards + a fetch-on-demand trailer) and sends it as body.context, so the gateway
// answers with assembled context instead of a standing accumulating session.

const CTX_CAP = 6000; // hard cap on assembled context (chars)
const THREAD_WINDOW = 12; // most recent thread messages
const MSG_CLIP = 500; // per-message clip
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function boardBaseUrl() {
  try {
    // Resolve at CALL time (not from the frozen STATUS_ROOT const): the kanban board
    // may come up after the web channel, and a sandbox sets GARRISON_HOME late.
    const s = JSON.parse(readFileSync(path.join(garrisonDir(), "ui-fittings", "kanban-loop.json"), "utf8"));
    return s.url || (s.port ? `http://127.0.0.1:${s.port}` : null);
  } catch {
    return null;
  }
}

// A done card's one-liner: prefer its handoff completionSummary, else lastReply/title.
async function doneOneLiner(base, c) {
  try {
    const r = await fetch(`${base}/cards/${encodeURIComponent(c.id)}/handoff`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const { handoff } = await r.json();
      const s = typeof handoff?.completionSummary === "string" ? handoff.completionSummary : "";
      if (s.trim()) return `${c.id} ${c.title} — done: ${clip(s.trim(), 120)}`;
    }
  } catch {
    /* fall back below */
  }
  const fallback = typeof c.lastReply === "string" && c.lastReply.trim() ? c.lastReply.trim() : c.title || "";
  return `${c.id} ${c.title} — done: ${clip(String(fallback), 120)}`;
}

// Assemble the block, then truncate DETERMINISTICALLY under the cap: drop oldest
// thread messages first, then done one-liners (active cards — the working state —
// are never dropped).
function buildContextBlock(threadMsgs, activeLines, doneLines, trailer, cap) {
  const msgs = threadMsgs.slice();
  const dones = doneLines.slice();
  const render = () => {
    const parts = [];
    if (msgs.length) parts.push("## Recent conversation\n" + msgs.join("\n"));
    if (activeLines.length) parts.push("## Active cards from this thread\n" + activeLines.join("\n"));
    if (dones.length) parts.push("## Completed cards from this thread\n" + dones.join("\n"));
    parts.push(trailer);
    return parts.join("\n\n");
  };
  let out = render();
  while (out.length > cap && msgs.length) {
    msgs.shift();
    out = render();
  }
  while (out.length > cap && dones.length) {
    dones.pop();
    out = render();
  }
  if (out.length > cap) out = out.slice(0, cap);
  return out;
}

export async function assembleMaterializedContext(threadId) {
  const telemetry = { threadId: threadId ?? null, assembledChars: 0, messages: 0, activeCards: 0, doneCards: 0 };
  if (!threadId) return { context: null, telemetry };
  let threadMsgs = [];
  try {
    const thread = await getThread(threadId);
    const msgs = Array.isArray(thread?.messages) ? thread.messages : [];
    threadMsgs = msgs.slice(-THREAD_WINDOW).map((m) => `${m.role}: ${clip(String(m.text ?? ""), MSG_CLIP)}`);
  } catch {
    /* no thread yet */
  }
  const activeLines = [];
  const doneLines = [];
  const base = boardBaseUrl();
  if (base) {
    try {
      const r = await fetch(`${base}/cards?origin_id=${encodeURIComponent(`web:${threadId}`)}`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const { cards } = await r.json();
        for (const c of Array.isArray(cards) ? cards : []) {
          if (c.list === "done") doneLines.push(await doneOneLiner(base, c));
          else if (c.list !== "needs-attention") activeLines.push(`${c.id} ${c.title} — ${c.list} (${clip(String(c.lastReply ?? ""), 150)})`);
        }
      }
    } catch {
      /* board down — assemble from the thread window alone */
    }
  }
  telemetry.messages = threadMsgs.length;
  telemetry.activeCards = activeLines.length;
  telemetry.doneCards = doneLines.length;
  const trailer = "Deeper detail for any card is available on demand via fetch_evidence(card_id, ref) — pull, do not assume.";
  const context = buildContextBlock(threadMsgs, activeLines, doneLines, trailer, CTX_CAP);
  telemetry.assembledChars = context.length;
  return { context, telemetry };
}

// Acceptance-7 evidence: one line per materialized turn proving bounded context.
async function appendMaterializedTurn(telemetry) {
  try {
    const dir = path.join(garrisonDir(), "web-channel");
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "materialized-turns.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...telemetry }) + "\n");
  } catch {
    /* telemetry is best-effort */
  }
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
  // persisted into it server-side. The USER side is written before the upstream
  // opens; the assistant side lands only when that upstream settles.
  const threadId = typeof body?.thread === "string" && body.thread.trim() ? body.thread.trim() : null;
  // The pins in force for THIS turn: the thread's persisted (conversation-sticky)
  // TurnRouting with the request's own `routing` laid over it. Read the thread again
  // rather than threading it out of the context assembly above - that helper's return
  // shape is a pinned contract of its own (tests/s3b-materialized.test.ts) and a
  // thread file is a couple of KB.
  const pinned = threadId ? (await getThread(threadId))?.routing ?? null : null;
  const routing = mergeTurnRouting(pinned, body?.routing);
  // S3b: MATERIALIZE the turn — assemble bounded deterministic context from this
  // thread's PRIOR history + board cards, and record the bounded-context telemetry.
  // This deliberately runs before appending the current ask: the explicit gateway
  // `message` is authoritative and must not also appear inside its own context.
  const { context: assembledContext, telemetry } = await assembleMaterializedContext(threadId);
  void appendMaterializedTurn(telemetry);
  if (threadId) {
    // Await this tiny atomic write before opening the upstream: navigating away
    // can never reopen a running thread that has forgotten the ask. The trailing
    // unanswered user message is already a supported history shape (toHistory).
    try {
      await appendMessages(threadId, [{ role: "user", text: message, overrides: routing ?? undefined }]);
    } catch (err) {
      // A persistence fault must be visible in logs, but it must not silently turn
      // the chat channel into a runtime outage.
      console.error(`[web-channel] failed to persist user turn into thread ${threadId}: ${err.message}`);
    }
  }
  // Forward assembled context and explicit routing through to the gateway.
  const payload = JSON.stringify(
    buildGatewayChatBody({
      message,
      context: assembledContext ?? body?.context,
      classification: body?.classification,
      sessionId: threadId,
      routing,
      turnSeq: body?.turnSeq
    })
  );
  const target = new URL("/chat/stream", opts.gatewayUrl);
  if (threadId) markRunning(threadId);
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
  }, payload, { threadId });
}

// POST a JSON object to a gateway path and stream the reply straight back. The
// browser only ever talks to this origin (the tailnet rule: it can be anywhere), so
// every gateway call is same-origin-fronted like this one.
function postGatewayJson(res, opts, subpath, bodyObj) {
  const payload = JSON.stringify(bodyObj ?? {});
  const target = new URL(subpath, opts.gatewayUrl);
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

// Answer an AskUserQuestion picker (a tapped option label / free text / dismiss).
// Buffers the JSON and forwards to the gateway's POST /chat/answer, which drives
// the live TUI picker. Same shape as handleClaudeProxy but on the /chat path.
async function handleChatAnswer(req, res, opts) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return jsonRes(res, 400, { error: `invalid json: ${err.message}` });
  }
  postGatewayJson(res, opts, "/chat/answer", body);
}

// Stop the turn this conversation is running (contract §9). The gateway keys its
// activeTurns map by the session id it was handed, which for a channel turn is the
// THREAD id (handleChat forwards it as `sessionId`); with no thread the gateway fell
// back to the channel name, so mirror that fallback here or a threadless ad-hoc turn
// would be uncancellable.
async function handleChatInterrupt(req, res, opts) {
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return jsonRes(res, 400, { error: `invalid json: ${err.message}` });
  }
  const raw = typeof body?.sessionId === "string" && body.sessionId.trim()
    ? body.sessionId
    : (typeof body?.thread === "string" && body.thread.trim() ? body.thread : CHANNEL_ID);
  postGatewayJson(res, opts, "/chat/interrupt", { sessionId: raw.trim() });
}

// ── Route options (one read for every rail menu, contract §11) ───────────────
// Merges the gateway's GET /route/options (targets / duties / efforts / accounts)
// with the kanban board's existing GET /projects - projects are deliberately NOT
// re-scanned here; the dev-root scan already exists in the board. Exposed
// same-origin because this fitting serves its own origin and the browser is almost
// never on this box, so it can neither reach Garrison's Next /api/* nor be handed a
// machine-local gateway URL.
//
// Degradation is per-DIMENSION, never global: a dead gateway still yields the
// project list and vice versa, because an options read must never be able to block
// the chat surface. An empty list is the UI's signal that the dimension is
// read-only - we never fabricate entries.
const OPTIONS_TTL_MS = 10_000;
const OPTIONS_DEGRADED_TTL_MS = 2_000;
const EMPTY_ROUTE_OPTIONS = {
  targets: [],
  duties: [],
  selectedDuties: [],
  efforts: [],
  accounts: [],
  account: null,
  // RUN-SPEC-V1 vocabularies. The proxy spreads the gateway's answer over these
  // defaults, so they exist as empty lists when the gateway is down - an empty menu
  // with an "unavailable" reason, never an undefined the rail would crash on.
  tiers: [],
  flows: [],
  defaultFlow: null,
  primaryRuntime: null,
  activeProfile: null
};
let optionsCache = null; // { expiresAt, body }

async function fetchGatewayRouteOptions(opts) {
  try {
    const target = new URL("/route/options", opts.gatewayUrl);
    const r = await fetch(target, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// The board's GET /projects → { devRoot, projects: [{ name, path }] }. Only the NAME
// travels on: a pin is a dev-root child name (contract §2), the absolute path is the
// gateway's business (it resolves and confines it) and would be meaningless on a
// phone.
async function fetchBoardProjectNames() {
  const base = boardBaseUrl();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/projects`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const j = await r.json();
    const list = Array.isArray(j?.projects) ? j.projects : null;
    if (!list) return null;
    return list
      .map((p) => (typeof p === "string" ? p : typeof p?.name === "string" ? p.name : ""))
      .filter((n) => n.trim())
      .map((n) => n.trim());
  } catch {
    return null;
  }
}

async function handleRouteOptions(req, res, opts) {
  const parsed = url.parse(req.url || "", true);
  // `?refresh=1` bypasses the cache - the menu is reopened after starting the board
  // or the operative, and a 10s stale "nothing available" reads as a broken UI.
  const refresh = parsed.query.refresh === "1" || parsed.query.refresh === "true";
  if (!refresh && optionsCache && optionsCache.expiresAt > Date.now()) {
    return jsonRes(res, 200, optionsCache.body);
  }
  const [gateway, projects] = await Promise.all([fetchGatewayRouteOptions(opts), fetchBoardProjectNames()]);
  const body = {
    ...EMPTY_ROUTE_OPTIONS,
    ...(gateway ?? {}),
    projects: projects ?? [],
    // Which sub-fetches answered, so the UI can say "board not running" on a
    // disabled row instead of implying the user has no projects.
    sources: { gateway: gateway !== null, board: projects !== null }
  };
  // A degraded answer is cached only briefly: the missing side is usually a fitting
  // that is still coming up, and pinning that for a full TTL is the wrong trade.
  const ttl = body.sources.gateway && body.sources.board ? OPTIONS_TTL_MS : OPTIONS_DEGRADED_TTL_MS;
  optionsCache = { expiresAt: Date.now() + ttl, body };
  jsonRes(res, 200, body);
}

// ── Conversation threads (session list + history) ──────────────────────────
// Generic, opaque-keyed transcript organizer over the one rolling operative. The
// server persists each completed exchange itself (handleChat tees the upstream
// `done` event into the thread the client named) and lists/serves prior threads
// so the UI can show a session list and move between conversations.
async function handleThreadsList(res) {
  // `runningSince` rides the list so the sidebar can mark which conversations
  // have a turn in flight, not just the one that is open.
  const running = new Set(runningThreadIds());
  const threads = (await listThreads()).map((t) =>
    running.has(t.id) ? { ...t, runningSince: runningSince(t.id) } : t
  );
  jsonRes(res, 200, { threads });
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
  // The client rebuilds a reopened thread from persisted history, which is empty
  // for a turn still in flight. Without this it cannot tell "idle" from "working"
  // and the conversation looks dead until the reply lands.
  jsonRes(res, 200, { thread: { ...thread, runningSince: runningSince(id) } });
}

// Replay the buffered prefix of a running turn, then follow new frames until the
// producer settles. The URL is deliberately same-origin and contains only the
// opaque thread id; no gateway address or machine-local path reaches the browser.
function handleThreadLive(req, res, id) {
  let closed = false;
  let keep = null;
  let subscription = null;
  const writeFrame = (frame) => {
    if (closed || res.writableEnded || res.destroyed) return;
    try { res.write(formatSseFrame(frame)); } catch { stop(); }
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    if (keep) clearInterval(keep);
    subscription?.unsubscribe();
  };
  const end = () => {
    if (closed) return;
    stop();
    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch { /* client gone */ }
    }
  };

  subscription = subscribeLive(id, { onFrame: writeFrame, onEnd: end });
  if (!subscription) return jsonRes(res, 404, { error: "thread has no running turn" });

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  for (const frame of subscription.frames) writeFrame(frame);
  keep = setInterval(() => {
    if (closed) return;
    try { res.write(": keep-alive\n\n"); } catch { stop(); }
  }, 15_000);
  keep.unref?.();
  req.on("aborted", stop);
  res.on("close", stop);
}

async function handleThreadAppend(req, res, id) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return jsonRes(res, 400, { error: `invalid json: ${err.message}` }); }
  try {
    jsonRes(res, 200, {
      thread: await appendMessages(id, body?.messages, { idempotencyKey: body?.idempotencyKey ?? null })
    });
  } catch (err) {
    jsonRes(res, 400, { error: err.message });
  }
}

// The thread's pinned run context (contract §13). Autosave semantics, no Save
// button: the rail PUTs on every change and the store skips the write when the pin is
// unchanged, so a re-assert on the 10s poll neither rewrites nor re-sorts the thread.
async function handleThreadRoutingGet(res, id) {
  const thread = await getThread(id);
  if (!thread) return jsonRes(res, 404, { error: "thread not found" });
  jsonRes(res, 200, { routing: thread.routing ?? null });
}

async function handleThreadRoutingPut(req, res, id) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return jsonRes(res, 400, { error: `invalid json: ${err.message}` }); }
  // A pin never conjures a thread, and setThreadRouting returns null for BOTH "cleared"
  // and "no such thread" - so check existence first rather than answering 200/null to a
  // write that went nowhere.
  if (!threadExistsSync(id)) return jsonRes(res, 404, { error: "thread not found" });
  // Accept the documented { routing: {...} } envelope or a bare pin object, so a client
  // that PUTs the pin directly does not silently CLEAR it.
  const raw = body && typeof body === "object" && !Array.isArray(body) && Object.hasOwn(body, "routing") ? body.routing : body;
  jsonRes(res, 200, { routing: await setThreadRouting(id, raw) });
}

async function handleThreadDelete(res, id) {
  const ok = await deleteThread(id);
  jsonRes(res, ok ? 200 : 404, { ok });
}

// Route /api/threads, /api/threads/:id, /api/threads/:id/live and mutations.
// Returns true
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
    if (id && parts.length === 2 && parts[1] === "live" && method === "GET") { handleThreadLive(req, res, id); return true; }
    if (id && parts.length === 2 && parts[1] === "messages" && method === "POST") { void handleThreadAppend(req, res, id); return true; }
    if (id && parts.length === 2 && parts[1] === "routing" && method === "GET") { void handleThreadRoutingGet(res, id); return true; }
    if (id && parts.length === 2 && parts[1] === "routing" && method === "PUT") { void handleThreadRoutingPut(req, res, id); return true; }
  }
  return false;
}

// ── Host-aware URL + file rendering (issues #3/#4) ──────────────────────────
// Same-origin serve map so the chat's host-rewriter turns a baked loopback link
// (e.g. a Kanban card URL) into the reachable tailnet URL for wherever the
// client is. This origin's own `tailscale serve` mapping fronts it.
async function handleHostMap(res) {
  let map = new Map();
  try { map = await getTailnetServeMap(); } catch { /* empty */ }
  jsonRes(res, 200, { map: Object.fromEntries(map) });
}

const FILE_IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp"
};
const FILE_TEXT_MIME = {
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8", ".pdf": "application/pdf"
};
const FILE_SENSITIVE = /(?:^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519|[^/]*\.pem|vault\.json)|\/\.git\//i;

// realpath the target and require it to stay within one of `roots` (realpath
// collapses any symlink in the chain, so a symlink can't escape).
function realpathConfined(target, roots) {
  let real;
  try { real = realpathSync(target); } catch { return null; }
  for (const root of roots) {
    let realRoot;
    try { realRoot = realpathSync(root); } catch { continue; }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }
  return null;
}

// Serve an operative reply's absolute file paths (attachments under the
// composition's .garrison/uploads, run artifacts) as inline images / links.
// Confined by realpath to Garrison-owned roots; never trusts the raw path.
function handleFile(req, res) {
  const parsed = url.parse(req.url || "", true);
  const raw = typeof parsed.query.path === "string" ? parsed.query.path : "";
  if (!raw || !path.isAbsolute(raw)) return jsonRes(res, 400, { error: "absolute path required" });
  if (FILE_SENSITIVE.test(raw)) return jsonRes(res, 403, { error: "forbidden" });
  const compDir = process.env.GARRISON_COMPOSITION_DIR || process.cwd();
  const roots = [path.join(compDir, ".garrison", "uploads"), path.join(garrisonDir(), "runs"), compDir];
  const confined = realpathConfined(raw, roots);
  if (!confined) return jsonRes(res, 404, { error: "not found or out of bounds" });
  let stat;
  try { stat = statSync(confined); } catch { return jsonRes(res, 404, { error: "not found" }); }
  if (!stat.isFile()) return jsonRes(res, 404, { error: "not a file" });
  const ext = path.extname(confined).toLowerCase();
  const image = FILE_IMAGE_MIME[ext];
  const text = FILE_TEXT_MIME[ext];
  res.statusCode = 200;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader("Cache-Control", "private, max-age=60");
  if (image) res.setHeader("Content-Type", image);
  else if (text) res.setHeader("Content-Type", text);
  else {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(confined).replace(/["\r\n]/g, "")}"`);
  }
  createReadStream(confined).pipe(res);
}

// ── Rich transcript (issue #1 on the web channel) ───────────────────────────
// Root of Claude Code's per-session JSONL transcripts. Mirrors
// packages/claude-pty/src/paths.mjs claudeProjectsDir().
function claudeProjectsRoot() {
  const override = process.env.GARRISON_CLAUDE_PROJECTS_DIR?.trim();
  if (override) return override;
  const home = process.env.GARRISON_CLAUDE_HOME?.trim();
  if (home) return path.join(home, "projects");
  return path.join(os.homedir(), ".claude", "projects");
}

// Find <sessionId>.jsonl by globbing every project dir - session ids are unique,
// so this sidesteps any cwd-encoding mismatch (the CLAUDE_CONFIG_DIR / SDK-cwd
// seam) between where the operative journaled and how we'd encode the dir.
async function findTranscriptBySession(sessionId) {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const root = claudeProjectsRoot();
  let dirs = [];
  try { dirs = await readdir(root); } catch { return null; }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function subagentsDirFor(parentTranscript) {
  return parentTranscript.endsWith(".jsonl")
    ? path.join(path.dirname(parentTranscript), path.basename(parentTranscript, ".jsonl"), "subagents")
    : null;
}

// Resolve an INTERNAL agent id only inside the parent session's real subagents
// directory. The returned path never crosses the HTTP boundary.
function confinedSubagentTranscript(parentTranscript, agentId) {
  const safe = typeof agentId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(agentId) ? agentId : null;
  const root = subagentsDirFor(parentTranscript);
  if (!safe || !root) return null;
  const candidate = path.join(root, `agent-${safe}.jsonl`);
  return realpathConfined(candidate, [root]);
}

function relatedTaskStreamUrl(parentTranscript, sessionId, task) {
  if (!confinedSubagentTranscript(parentTranscript, task?.agentId)) return null;
  return `/api/session-stream?session=${encodeURIComponent(sessionId)}&task=${encodeURIComponent(task.taskId)}`;
}

// A public task id is derived from the Agent/Task tool-use id, never the journal's
// explicitly-internal agentId. Search the confined journal tree so nested fan-out
// (a child spawning another child) remains openable through the same contract.
async function findRelatedTaskTranscript(parentTranscript, publicTaskId) {
  if (typeof publicTaskId !== "string" || !/^task-[A-Za-z0-9_-]{1,133}$/.test(publicTaskId)) return null;
  const root = subagentsDirFor(parentTranscript);
  const journals = [parentTranscript];
  if (root) {
    let names = [];
    try { names = await readdir(root); } catch { /* no children */ }
    for (const name of names) {
      if (!/^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/.test(name)) continue;
      const confined = realpathConfined(path.join(root, name), [root]);
      if (confined) journals.push(confined);
    }
  }
  for (const journal of journals) {
    let lines = [];
    try { ({ lines } = await readJsonlLines(journal, 0)); } catch { continue; }
    const task = extractRelatedTaskRecords(lines).find((candidate) => candidate.taskId === publicTaskId);
    if (!task?.agentId) continue;
    const child = confinedSubagentTranscript(parentTranscript, task.agentId);
    if (child) return child;
  }
  return null;
}

// SSE stream of a thread's (or an explicit session's) Claude transcript: the
// structured blocks (text / collapsible thinking / tool calls / inline images)
// the plain-text chat stream drops. Tails live; the client closes it.
async function handleSessionStream(req, res) {
  const parsed = url.parse(req.url || "", true);
  const threadId = typeof parsed.query.thread === "string" ? parsed.query.thread : null;
  let sessionId = typeof parsed.query.session === "string" ? parsed.query.session : null;
  const publicTaskId = typeof parsed.query.task === "string" ? parsed.query.task : null;
  if (!sessionId && threadId) {
    const thread = await getThread(threadId);
    sessionId = thread?.claudeSessionId ?? null;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const emit = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };

  const parentAbs = sessionId ? await findTranscriptBySession(sessionId) : null;
  const abs = parentAbs && publicTaskId
    ? await findRelatedTaskTranscript(parentAbs, publicTaskId)
    : parentAbs;
  if (!abs) {
    emit({ type: "init", available: false, live: false, events: [] });
    emit({ type: "end" });
    return res.end();
  }
  let offset = 0;
  let journalLines = [];
  let relatedById = new Map();
  const safeRelated = () => {
    if (!parentAbs || !sessionId) return [];
    return relatedTaskEvents(journalLines, {
      streamUrlFor: (task) => relatedTaskStreamUrl(parentAbs, sessionId, task)
    });
  };
  try {
    const first = await readJsonlLines(abs, 0);
    offset = first.offset;
    journalLines = first.lines.slice();
    const { events, title } = parseTranscriptLines(first.lines);
    const related = safeRelated();
    relatedById = new Map(related.map((event) => [event.id, JSON.stringify(event)]));
    emit({ type: "init", available: true, live: true, title, events: [...events, ...related] });
  } catch {
    emit({ type: "init", available: false, live: false, events: [] });
    emit({ type: "end" });
    return res.end();
  }
  let closed = false;
  const stop = () => { closed = true; clearInterval(keep); clearInterval(poll); };
  const keep = setInterval(() => { if (!closed) { try { res.write(": keep-alive\n\n"); } catch { stop(); } } }, 15000);
  const poll = setInterval(async () => {
    if (closed) return;
    try {
      const next = await readJsonlLines(abs, offset);
      if (next.lines.length) {
        offset = next.offset;
        journalLines.push(...next.lines);
        const { events, title } = parseTranscriptLines(next.lines);
        // Related tasks are snapshot-derived because a tool_use, its launch result
        // and its completion notification can arrive in different polls. Emit only
        // descriptors whose latest-wins value changed.
        const related = safeRelated();
        const changed = [];
        const nextRelated = new Map();
        for (const event of related) {
          const encoded = JSON.stringify(event);
          nextRelated.set(event.id, encoded);
          if (relatedById.get(event.id) !== encoded) changed.push(event);
        }
        relatedById = nextRelated;
        if (events.length || changed.length) emit({ type: "events", title, events: [...events, ...changed] });
      }
    } catch { /* transient read error; retry next tick */ }
  }, 800);
  req.on("close", stop);
  res.on("close", stop);
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
  const ext = path.extname(filePath).toLowerCase();
  if (!existsSync(filePath)) {
    // SPA fallback is for NAVIGATIONS only (extension-less routes). An asset-like
    // path with an extension (e.g. /sw.js, /manifest.json, /icons/icon-192.png)
    // that is missing must 404 — serving index.html for it as text/html would
    // break service-worker registration, manifest parsing, and icon loads.
    if (!ext) {
      const indexFallback = path.join(distDir, "index.html");
      if (existsSync(indexFallback)) {
        const data = readFileSync(indexFallback);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(data);
        return;
      }
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("web-channel: not found (dist/ built? run `node ui/build.mjs` in the Fitting directory).");
    return;
  }
  const ctMap = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".map": "application/json"
  };
  // The web app manifest is served with its precise type so Chrome/Android accept
  // it (application/json also works, but this is the spec-correct MIME).
  const contentType = path.basename(filePath) === "manifest.json"
    ? "application/manifest+json"
    : (ctMap[ext] ?? "application/octet-stream");
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
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


// ---- notifications: in-app + Web Push -------------------------------------
// Web Push is the only way to reach a phone in the background without shipping
// through the App Store or Play. iOS 16.4+ supports it for web apps ADDED TO
// THE HOME SCREEN; a plain Safari tab cannot even ask for permission.

// The browser needs the VAPID PUBLIC key to subscribe. Public by definition -
// it is embedded in the resulting endpoint - so this is not a secret leak.
function handlePushKey(res) {
  const vapid = vapidFromEnv();
  if (!vapid) return jsonRes(res, 503, { error: "push not configured", reason: "no VAPID keys in env" });
  return jsonRes(res, 200, { publicKey: vapid.publicKey });
}

async function handlePushSubscribe(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  if (!body?.subscription) return jsonRes(res, 400, { error: "subscription required" });
  try {
    const rows = saveSubscription(body.subscription, process.env, { label: body.label ?? null });
    return jsonRes(res, 200, { ok: true, subscriptions: rows.length });
  } catch (err) {
    return jsonRes(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handlePushUnsubscribe(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return jsonRes(res, 400, { error: "endpoint required" });
  return jsonRes(res, 200, { ok: true, removed: removeSubscription(endpoint) });
}

/**
 * The channel notify contract: POST /notify {title, text, actions[], link}.
 * Every channel Fitting is meant to expose this shape so one fan-out can reach
 * all of them without a hardcoded transport map.
 *
 * Delivers twice on purpose, because they cover different states:
 *  - Web Push reaches a phone whose screen is off (the point of the exercise);
 *  - the in-app SSE event decorates the UI when it is already open, where a
 *    system notification would be redundant and is often suppressed anyway.
 */
async function handleNotify(req, res, opts) {
  const body = await readJsonBody(req).catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "Garrison";
  if (!text) return jsonRes(res, 400, { error: "text required" });
  // Actions render as real buttons where the transport supports them; the
  // service worker caps at two, which is a browser limit, not ours.
  const actions = Array.isArray(body?.actions)
    ? body.actions
        .filter((a) => a && typeof a.label === "string")
        .slice(0, 2)
        .map((a) => ({ action: String(a.action || a.url || a.label), title: a.label, url: a.url ?? null }))
    : [];
  const link = typeof body?.link === "string" ? body.link : null;
  const payload = JSON.stringify({ title, body: text, actions, link, tag: body?.tag ?? null });

  // In-app rendering is NOT a second server path: the push is delivered to the
  // service worker, which shows the notification AND postMessage()s any open
  // page so the UI can render a toast. One delivery, two presentations.
  const vapid = vapidFromEnv();
  const subs = readSubscriptions();
  if (!vapid || subs.length === 0) {
    return jsonRes(res, 200, {
      ok: true,
      pushed: 0,
      reason: !vapid ? "no VAPID keys" : "no push subscriptions"
    });
  }

  let pushed = 0;
  let pruned = 0;
  for (const subscription of subs) {
    try {
      const out = await sendPush({ subscription, payload, vapid });
      if (out.ok) pushed += 1;
      // A push service that says 404/410 will never accept this endpoint again;
      // keeping it means retrying a dead device forever.
      else if (out.gone) { removeSubscription(subscription.endpoint); pruned += 1; }
    } catch {}
  }
  return jsonRes(res, 200, { ok: true, pushed, pruned, subscriptions: subs.length });
}

  const requestHandler = async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health" || pathname === "/api/health") return handleHealth(req, res, liveOpts);
      // Host-aware URL/file rendering + rich transcript (issues #1/#3/#4). Root
      // paths (not /api/*) so they inherit this origin's tailscale serve mapping.
      if (pathname === "/api/push/key" && method === "GET") return handlePushKey(res);
      if (pathname === "/api/push/subscribe" && method === "POST") return handlePushSubscribe(req, res);
      if (pathname === "/api/push/subscribe" && method === "DELETE") return handlePushUnsubscribe(req, res);
      if ((pathname === "/notify" || pathname === "/api/notify") && method === "POST") return handleNotify(req, res, liveOpts);
      if (pathname === "/host-map" && method === "GET") return handleHostMap(res);
      if (pathname === "/file" && method === "GET") return handleFile(req, res);
      if (pathname === "/api/session-stream" && method === "GET") return handleSessionStream(req, res);
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
      if (pathname === "/api/voice/health" && method === "GET") return handleVoiceHealth(res);
      if (pathname === "/api/voice" && method === "GET") return handleVoiceInfo(res);
      if (pathname === "/api/voice/stt" && method === "POST") return handleVoiceProxy(req, res, "/stt");
      if (pathname === "/api/voice/tts" && method === "POST") return handleVoiceProxy(req, res, "/tts");
      if (pathname === "/api/stream" && method === "GET") return handleStream(req, res, liveOpts);
      if (pathname === "/api/chat/answer" && method === "POST") return handleChatAnswer(req, res, liveOpts);
      if (pathname === "/api/chat/interrupt" && method === "POST") return handleChatInterrupt(req, res, liveOpts);
      if (pathname === "/api/chat" && method === "POST") return handleChat(req, res, liveOpts);
      if (pathname === "/api/route-options" && method === "GET") return handleRouteOptions(req, res, liveOpts);
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
      if (pathname === "/api/attachments" && method === "POST") return handleAttachments(req, res, liveOpts);
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

  // Streaming voice: pure passthrough WS relay browser ⇄ voice Fitting.
  // /api/voice/stream → the Fitting's STT /stream; /api/voice/tts-stream → its
  // read-aloud /tts-stream. No parsing — all Deepgram logic stays in the voice
  // Fitting; the key never reaches the browser. The page connects with wss when
  // this server is TLS, and we forward the query (sample_rate, etc.) verbatim.
  const VOICE_WS_ROUTES = {
    "/api/voice/stream": "/stream",
    "/api/voice/tts-stream": "/tts-stream"
  };
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const parsed = url.parse(request.url || "/", true);
    const subpath = VOICE_WS_ROUTES[parsed.pathname || ""];
    if (!subpath) {
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
    wss.handleUpgrade(request, socket, head, (client) => relayVoiceStream(client, info.url, parsed.search || "", subpath));
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

// Conversations engine - the host-agnostic request router.
//
// Talks to the Operative through the http-gateway:
//   - POST /api/chat            -> proxies gateway POST /chat/stream (SSE)
//   - GET  /api/stream          -> proxies gateway GET  /channels/web/stream (SSE)
//   - POST /api/chat/interrupt  -> proxies gateway POST /chat/interrupt (Stop)
//   - POST /api/threads/:id/permissions/:requestId -> generation-bound SDK decision
//   - GET  /api/route-options   -> gateway GET /route/options + the board's /projects
// plus the durable per-thread input FIFO, live SSE streams, Web Push, the
// voice / remote-shell relays and the mesh thread index.
//
// Two hosts mount this module at the SAME relative paths:
//   - the Garrison shell (src/app/api/[[...path]]/route.ts + src/app/talk),
//     where Conversations is a shell route and every request is same-origin;
//   - fittings/seed/web-channel-default, the legacy own-port host (server.mjs
//     in this package), kept until the operator retires it.
// Every gateway/board call is fronted same-origin like that because the browser
// is almost never on this box and must never be handed a machine-local URL.
//
// The module holds process-wide state (input workers, live subscriptions,
// caches), so a process must load it ONCE - the shell mounts a single catch-all
// route for that reason.

import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { meshThreads } from "./mesh-threads.mjs";
import { gatewayMessageForwarder, handleConversationRequest } from "@garrison/claude-pty";
import { loadSidebar, saveSidebar } from "./sidebar-state.mjs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import {
  listThreads,
  getThread,
  getThreadSnapshot,
  ensureThread,
  appendMessages,
  appendSessionEvent,
  deleteThread,
  renameThread,
  setThreadSession,
  setThreadRouting,
  setThreadRouteSession,
  threadExistsSync,
  sanitizeRouteMeta,
  sanitizeRouting,
  sanitizeSpawnSignature,
  sanitizeRouteSession,
  sanitizeFailureInfo,
  sanitizeSessionEvent,
  admitThreadInput,
  claimNextThreadInput,
  bindThreadInputGeneration,
  markThreadInputStopping,
  settleThreadInput,
  reconcileInterruptedThreadInputs,
  clearThreadInputRecoveryBlock,
  getThreadInput,
  threadHasPendingInputs,
  startInputLive,
  markInputActive,
  activeInputId,
  appendInputLiveFrame,
  subscribeInputLive,
  finishInputLive,
  markRunning,
  appendLiveFrame,
  subscribeLive,
  clearRunning,
  runningSince,
  runningThreadIds,
  conversationRunningSince
} from "./threads.mjs";
import { SseFrameDecoder, formatSseFrame } from "./live-event-stream.mjs";
import { getTailnetServeMap } from "./tailnet-serve.mjs";
import {
  readJsonlLines,
  parseTranscriptLines,
  recoverTranscriptSessionEvents,
  reconcileTranscriptSessionEvents,
  extractRelatedTaskRecords,
  relatedTaskEvents
} from "./session-transcript.mjs";
import { sendPush } from "./webpush.mjs";
import { readSubscriptions, saveSubscription, removeSubscription, vapidFromEnv } from "./push-store.mjs";

// Mirrors garrisonDir() in src/lib/claude-home.ts: GARRISON_HOME (when set)
// IS the .garrison root, else ~/.garrison. Sandboxed runs (spike drivers) set
// it so their spawned instances never touch the live install's status files;
// voice discovery below reads the same root, so a sandboxed voice
// instance is still found by a sandboxed web-channel.
export function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

export const STATUS_ROOT = path.join(garrisonDir(), "ui-fittings");
const REMOTE_SHELL_STATUS_FILE = path.join(STATUS_ROOT, "remote-shell-runtime.json");

const CHANNEL_ID = "web";

export function jsonRes(res, status, body) {
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

// The voice provider is whichever fitting provides `kind: voice` in the active
// composition; the host tells the router its id (see the `voice` option on
// createTalkRouter) and the router reads that fitting's status file. No id is
// baked in here: the provider is a composition choice, not a router constant.
// Resolved at CALL time (not from the frozen STATUS_ROOT const) so a test that
// points GARRISON_HOME at a sandbox after import still reads the sandbox.
const FITTING_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function readVoiceInfo(fittingId) {
  if (typeof fittingId !== "string" || !FITTING_ID_RE.test(fittingId)) return null;
  const statusFile = path.join(garrisonDir(), "ui-fittings", `${fittingId}.json`);
  if (!existsSync(statusFile)) return null;
  try {
    const info = JSON.parse(readFileSync(statusFile, "utf8"));
    return info?.url ? info : null;
  } catch {
    return null;
  }
}

// The host's voice options: `fittingId()` names the provider fitting (null when
// the composition stations none), `token()` yields the capture token that gates
// the provider's /stt and /tts (null when the vault is locked or the secret is
// unset). Both may be sync or async and are asked on EVERY request, so a vault
// unlock or a provider swap is seen without a restart. A host that passes no
// voice option gets "no voice provider" everywhere and never a throw.
async function voiceFittingId(voice) {
  try {
    const id = await voice?.fittingId?.();
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

async function voiceToken(voice) {
  try {
    const token = await voice?.token?.();
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

// Why token() came back empty. A host that can name the exact reason (the shell
// reads its node's secret source: local vault or mesh authority) passes
// `tokenReason()`, which returns one of the VOICE_* reason strings below; one
// that can only tell locked from unsealed passes `vaultLocked()`; one that can
// tell nothing (the legacy env-fed host) leaves both out and a missing token
// reads as the vault being locked, the historical meaning. Asked only AFTER
// token() failed, so an auto-unlock the token read just performed is already
// reflected in the answer.
const VOICE_TOKEN_REASONS = new Set([
  "voice locked",
  "capture token not sealed",
  "capture token not granted to this node",
  "secret authority unreachable"
]);

async function voiceTokenReason(voice) {
  try {
    if (typeof voice?.tokenReason === "function") {
      const reason = await voice.tokenReason();
      return VOICE_TOKEN_REASONS.has(reason) ? reason : VOICE_LOCKED;
    }
    const locked = await voice?.vaultLocked?.();
    if (locked === undefined) return VOICE_LOCKED;
    return locked ? VOICE_LOCKED : VOICE_TOKEN_UNSET;
  } catch {
    return VOICE_LOCKED;
  }
}

// Reasons the voice surface is unavailable, in the order they are checked. The
// UI shows these verbatim, so they are the operator-facing strings.
export const VOICE_NO_PROVIDER = "no voice provider";
export const VOICE_NOT_RUNNING = "voice provider not running";
export const VOICE_LOCKED = "voice locked";
export const VOICE_TOKEN_UNSET = "capture token not sealed";
// Mesh nodes (D31): the token lives in the secret authority, which can refuse
// this node the key or be unreachable - neither is a locked local vault.
export const VOICE_TOKEN_DENIED = "capture token not granted to this node";
export const VOICE_SECRETS_UNREACHABLE = "secret authority unreachable";
export const VOICE_REST_DISABLED = "voice rest disabled";
export const VOICE_UNREACHABLE = "voice unreachable";

// How long one /stt or /tts hop may take end to end. A recording transcribes
// in a few seconds and a 600-character clip renders in under ten; a provider
// that hangs past this must not pin the browser's request forever.
const VOICE_PROXY_TIMEOUT_MS = 20000;

// ── Remote-shell relay ──────────────────────────────────────────────────────
// The remote-shell runtime fitting owns the ssh/tmux/devtunnel state on its own
// port; the web channel relays a narrow slice of it SAME-ORIGIN so the browser
// never needs a cross-port URL (tailnet HARD RULE): the /io terminal WS and the
// session/transport reads + start/input controls the terminal pane needs.

export function readRemoteShellInfo() {
  if (!existsSync(REMOTE_SHELL_STATUS_FILE)) return null;
  try {
    const info = JSON.parse(readFileSync(REMOTE_SHELL_STATUS_FILE, "utf8"));
    return info?.url ? info : null;
  } catch {
    return null;
  }
}

// Subpaths the browser may reach through the relay. DELETE (forget session) and
// anything unlisted stay on the fitting's own surface.
const REMOTE_SHELL_PROXY_RE =
  /^\/(transports|projects|sessions|sessions\/[A-Za-z0-9-]+(\/(input|keys|turn|detach|screen|turns\/[A-Za-z0-9-]+))?)$/;
// DELETE relays only for the one shape that supports it: a session teardown.
const REMOTE_SHELL_DELETE_RE = /^\/sessions\/[A-Za-z0-9-]+$/;

async function handleRemoteShellProxy(req, res, subpath, query) {
  const info = readRemoteShellInfo();
  if (!info?.url) return jsonRes(res, 503, { error: "remote-shell fitting not available" });
  const methodOk =
    req.method === "GET" || req.method === "POST" ||
    (req.method === "DELETE" && REMOTE_SHELL_DELETE_RE.test(subpath));
  if (!REMOTE_SHELL_PROXY_RE.test(subpath) || !methodOk) {
    return jsonRes(res, 404, { error: "not relayed" });
  }
  let body = null;
  if (req.method === "POST") {
    try { body = await readRawBody(req, 256 * 1024); } catch (err) { return jsonRes(res, 400, { error: err.message }); }
  }
  try {
    const target = new URL(subpath + (query ? `?${query}` : ""), info.url);
    const upstream = await fetch(target, {
      method: req.method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ?? undefined,
      // Long-poll turn settlement rides this relay; everything else is quick.
      signal: AbortSignal.timeout(subpath.includes("/turns/") ? 125_000 : 20_000)
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(text);
  } catch (err) {
    jsonRes(res, 502, { error: `remote-shell upstream: ${err.message}` });
  }
}

// Short-TTL snapshot of the fitting's sessions so the thread list can mark a
// remote-shell thread running from the HOOK-DRIVEN state (covers instructions
// typed straight into the TUI, which never become web-channel inputs).
//
// Keyed per SESSION, not per transport: one machine hosts an agent per project
// folder now, and a transport-keyed map handed every shell on that box whichever
// session happened to be last in the array - so a thread showed "Working"
// because a different project's agent was busy.
let remoteShellSnapshot = { at: 0, sessions: [] };
async function remoteShellSessions() {
  if (Date.now() - remoteShellSnapshot.at < 3000) return remoteShellSnapshot.sessions;
  let sessions = [];
  const info = readRemoteShellInfo();
  if (info?.url) {
    try {
      const res = await fetch(`${info.url}/sessions`, { signal: AbortSignal.timeout(1500) });
      const data = await res.json();
      if (Array.isArray(data?.sessions)) sessions = data.sessions;
    } catch { /* fitting down — threads just lose the live badge */ }
  }
  remoteShellSnapshot = { at: Date.now(), sessions };
  return sessions;
}

function laterOf(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** The session a thread's binding names: the one with that tmux name, or the
 *  transport's STANDING session when the binding names none (every thread
 *  written before multi-session). */
export function matchRemoteShellSession(binding, sessions) {
  if (!binding) return null;
  const mine = sessions.filter((s) => s.transport === binding.transport);
  if (binding.tmuxSession) return mine.find((s) => s.tmuxSession === binding.tmuxSession) ?? null;
  return mine.find((s) => s.standing) ?? null;
}

// Voice availability. The web UI hides its mic / speaker
// controls when this reports unavailable. Names the provider fitting, never
// its machine-local url: the page reaches the provider only through this
// same-origin proxy (CLAUDE.md, "the user's browser is almost never on the
// Garrison machine").
async function handleVoiceInfo(res, voice) {
  const fittingId = await voiceFittingId(voice);
  if (!fittingId) {
    jsonRes(res, 200, { available: false, reason: VOICE_NO_PROVIDER });
    return;
  }
  const info = readVoiceInfo(fittingId);
  if (!info?.url) {
    jsonRes(res, 200, { available: false, reason: VOICE_NOT_RUNNING, fitting: fittingId });
    return;
  }
  const ok = await pingHealth(info.url, 600);
  jsonRes(res, 200, ok
    ? { available: true, fitting: fittingId }
    : { available: false, reason: VOICE_UNREACHABLE, fitting: fittingId });
}

// GET /api/voice/health -> { available, keyConfigured, tts, backend,
// maxTextChars, fitting } or { available: false, reason, fitting? }. The
// provider's /health carries a `voice` block ({stt, tts, ttsBackend,
// restEnabled, maxTextChars}): `available` and `keyConfigured` both mirror
// `voice.stt` (the mic needs a transcriber), `tts` says whether a reply can be
// read aloud, `backend` names the synthesiser and `maxTextChars` is the /tts
// per-request budget the client chunks against. A locked vault or an unsealed
// token means the proxy cannot authenticate to the provider, and a provider
// whose REST lane is off would refuse every hop, so all three are reported
// unavailable with a reason rather than lit and then failing on the first
// clip. Never throws to the client.
async function handleVoiceHealth(res, voice) {
  const fittingId = await voiceFittingId(voice);
  if (!fittingId) {
    jsonRes(res, 200, { available: false, reason: VOICE_NO_PROVIDER });
    return;
  }
  const info = readVoiceInfo(fittingId);
  if (!info?.url) {
    jsonRes(res, 200, { available: false, reason: VOICE_NOT_RUNNING, fitting: fittingId });
    return;
  }
  const voiceUrl = String(info.url).replace(/\/$/, "");
  if (!(await voiceToken(voice))) {
    jsonRes(res, 200, { available: false, reason: await voiceTokenReason(voice), fitting: fittingId });
    return;
  }
  try {
    const probe = await fetch(`${voiceUrl}/health`, { signal: AbortSignal.timeout(2500) });
    if (!probe.ok) {
      jsonRes(res, 200, { available: false, reason: VOICE_UNREACHABLE, fitting: fittingId });
      return;
    }
    const h = await probe.json().catch(() => ({}));
    const block = h && typeof h.voice === "object" && h.voice ? h.voice : {};
    if (block.restEnabled === false) {
      jsonRes(res, 200, { available: false, reason: VOICE_REST_DISABLED, fitting: fittingId });
      return;
    }
    const stt = Boolean(block.stt);
    const maxTextChars = Number.isInteger(block.maxTextChars) && block.maxTextChars > 0 ? block.maxTextChars : null;
    jsonRes(res, 200, {
      available: stt,
      keyConfigured: stt,
      tts: Boolean(block.tts),
      backend: block.ttsBackend ?? null,
      maxTextChars,
      fitting: fittingId
    });
  } catch {
    jsonRes(res, 200, { available: false, reason: VOICE_UNREACHABLE, fitting: fittingId });
  }
}

// Binary proxy to the voice provider. Used for both /stt (audio in -> JSON) and
// /tts (JSON in -> audio out). pipeUpstreamSse/readJsonBody can't carry binary
// bodies, so this buffers the request and pipes the upstream response straight
// back, preserving the upstream Content-Type (audio/* or application/json).
// Same-origin so the browser needs no CORS. The provider gates both endpoints
// with the capture token: the host supplies it (vault-read per request) and it
// travels as `Authorization: Bearer` on the upstream hop only - the page never
// sees it. A missing provider or token is OUR 503 with a named reason, so the
// provider's own 403 ("no token sealed") is never mistaken for a forbidden
// user; an upstream 401/403 that does come back means the token we hold does
// not match the one the provider sealed, which the operator must see as-is.
// The hop is bounded (VOICE_PROXY_TIMEOUT_MS -> 504) and follows the browser:
// a page that navigates away mid-clip tears the upstream request down with it.
async function handleVoiceProxy(req, res, subpath, voice) {
  const fittingId = await voiceFittingId(voice);
  if (!fittingId) {
    jsonRes(res, 503, { error: VOICE_NO_PROVIDER });
    return;
  }
  const info = readVoiceInfo(fittingId);
  if (!info?.url) {
    jsonRes(res, 503, { error: VOICE_NOT_RUNNING });
    return;
  }
  const token = await voiceToken(voice);
  if (!token) {
    jsonRes(res, 503, { error: await voiceTokenReason(voice) });
    return;
  }
  let body;
  try {
    body = await readRawBody(req);
  } catch (err) {
    if (err?.code === "PAYLOAD_TOO_LARGE") {
      // The rest of the oversized body is being drained, not read; answer and
      // let the connection go so the client is not left streaming into a void.
      res.setHeader("Connection", "close");
      jsonRes(res, 413, { error: err.message });
      return;
    }
    jsonRes(res, 400, { error: `bad body: ${err.message}` });
    return;
  }
  const target = new URL(subpath, info.url);
  // /stt takes `?language=` (a BCP-47 hint for the transcriber); it is the one
  // query parameter the provider's REST lane reads, so it is the one that
  // crosses. Anything else the page appends stops here.
  const language = new URL(req.url ?? "/", "http://placeholder").searchParams.get("language");
  if (subpath === "/stt" && language) target.searchParams.set("language", language);
  let timedOut = false;
  const upstream = http.request(
    {
      method: "POST",
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      timeout: VOICE_PROXY_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": req.headers["content-type"] || "application/octet-stream",
        "Content-Length": body.length
      }
    },
    (up) => {
      res.statusCode = up.statusCode || 502;
      if (up.headers["content-type"]) res.setHeader("Content-Type", up.headers["content-type"]);
      res.setHeader("Cache-Control", "no-store");
      up.on("error", () => { try { res.destroy(); } catch {} });
      up.pipe(res);
    }
  );
  upstream.on("timeout", () => {
    timedOut = true;
    upstream.destroy(new Error(`no reply within ${VOICE_PROXY_TIMEOUT_MS}ms`));
  });
  upstream.on("error", (err) => {
    if (res.headersSent) { try { res.destroy(); } catch {} return; }
    try { jsonRes(res, timedOut ? 504 : 502, { error: `voice upstream: ${err.message}` }); } catch {}
  });
  // `res` closing before it finished means the browser went away (req itself
  // reports "close" as soon as its body is consumed, so it cannot carry this).
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  upstream.end(body);
}

// A capture session id as the provider mints them (SessionId.generate on the
// phone, the same alphabet on the service): anything else never reaches the
// upstream path, so the relay cannot be steered at another route.
const VOICE_SESSION_ID_RE = /^[A-Za-z0-9_-]{10,40}$/;

// GET /api/voice/sessions/<id>/events -> the provider's live transcript stream
// for one capture session (interims, finals, then {done:true}), relayed as-is.
// This is how the capture page shows what the pendant is hearing: the phone
// streams audio to the provider directly (I2, the webview is never in the data
// path) and the page reads the words back through the shell, same origin, no
// provider port and no token on the phone. The provider's own SSE route trusts
// loopback and the tailnet; the token rides only when the host holds one.
async function handleVoiceSessionEvents(req, res, sessionId, voice) {
  if (!VOICE_SESSION_ID_RE.test(sessionId)) {
    jsonRes(res, 400, { error: "bad session id" });
    return;
  }
  const fittingId = await voiceFittingId(voice);
  if (!fittingId) {
    jsonRes(res, 503, { error: VOICE_NO_PROVIDER });
    return;
  }
  const info = readVoiceInfo(fittingId);
  if (!info?.url) {
    jsonRes(res, 503, { error: VOICE_NOT_RUNNING });
    return;
  }
  const token = await voiceToken(voice);
  const target = new URL(`/sessions/${sessionId}/events`, info.url);
  const headers = { Accept: "text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  pipeUpstreamSse(req, res, {
    method: "GET",
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers
  });
}

function readRawBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error(`payload too large (over ${limit} bytes)`);
        err.code = "PAYLOAD_TOO_LARGE";
        // Stop collecting but keep the socket: destroying it here would take
        // the 413 down with it. The handler answers and closes the connection.
        req.removeAllListeners("data");
        req.resume();
        reject(err);
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
    const durableReply = typeof reply === "string" && reply.trim()
      ? reply
      : "_The operative returned an empty reply. Try sending again._";
    // The whole turn, not just its text: the resolved attribution rides in the
    // message so the badges survive a reload and the 10s thread poll's remount
    // (contract §10), and so the per-turn sessionId can open THIS turn's transcript
    // rather than the thread-level last-write-wins one (§12). Persist the same
    // explicit empty-reply fallback the live transport renders; otherwise a valid
    // `done` with no prose becomes a lone unanswered user after reload.
    queueThreadWrite(() => appendMessages(threadId, [{
      role: "assistant",
      text: durableReply,
      route: attributionFromFrame({ ...(preRoute ?? {}), ...payload }) ?? undefined
    }]));
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
    if (name === "session_event") {
      // Canonical activity is durable independently of the lossy assistant-text
      // projection. Keep this in the SAME serialized chain as route/session/reply
      // writes so a later done cannot overwrite an event written from an earlier
      // frame. Malformed payloads are refused by the store without affecting the
      // verbatim SSE tee above.
      if (threadId) queueThreadWrite(() => appendSessionEvent(threadId, payload));
      return;
    }
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
      // killed upstream. Publish the same failure to both the attached client and
      // the replay journal before settling; otherwise the durable note exists but
      // a no-text/tool-only turn can keep the host's history poll suppressed. The
      // latch means a normal end after `done` (or a forwarded error) is a no-op.
      const reason = "the gateway stream ended without a done event";
      if (!persisted) emitLocalError(reason);
      persistFailed(reason);
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

// Build the gateway /chat/stream body from a channel request. `message` is the
// exact admitted user input and `channel` is always pinned to "web". Context
// stored with a thread belongs to the browser/brief surface; it is deliberately
// not a gateway field and must never become an invisible user-message prefix.
export function buildGatewayChatBody({
  message,
  classification,
  sessionId,
  inputId,
  routing,
  turnSeq,
  autonomous,
  agentSdkResume,
  agentSdkNewGeneration,
  routeSession,
} = {}) {
  const body = { message, channel: CHANNEL_ID };
  // D19: the conversation's thread id, forwarded as the gateway's session key so a
  // multi-turn thread attaches to ONE card instead of registering a duplicate per
  // turn. Absent → the gateway falls back to the channel name.
  if (typeof sessionId === "string" && sessionId.trim()) body.sessionId = sessionId.trim();
  // Trusted durable admission coordinate. The browser never writes this gateway
  // field directly; the queue worker adds its store-owned id so a restart can
  // recover a claim whose open frame was not persisted yet.
  if (typeof inputId === "string" && inputId.trim() && inputId.trim().length <= 512) {
    body.inputId = inputId.trim();
  }
  // Forward an explicit routing hint (the interactive Discuss path sends
  // { taskType, tier: "T0-trivial" } to keep extended thinking OFF — thinking on a
  // "design a process" prompt trips Anthropic's usage-policy classifier). The gateway
  // validates it (routeHintsFromBody); a malformed hint is simply ignored there.
  if (classification && typeof classification === "object") body.classification = classification;
  if (autonomous === true) body.autonomous = true;
  // The turn's effective pins (contract §3: body.routing -> routeHintsFromBody ->
  // applyTurnOverride). Emitted only when something is actually pinned - an unpinned
  // turn's body must stay byte-identical to the pre-run-context shape.
  if (routing && typeof routing === "object" && !Array.isArray(routing) && Object.keys(routing).length > 0) {
    body.routing = routing;
  }
  // Monotonic per-send counter (contract §5). The gateway echoes it on both `route`
  // frames so the client can DROP a frame belonging to an older turn.
  if (Number.isInteger(turnSeq) && turnSeq >= 0) body.turnSeq = turnSeq;
  // Server-derived only: the browser cannot nominate an SDK journal. The gateway
  // independently validates this complete prior attribution against the route it
  // resolves for the new turn before native resume is allowed.
  if (agentSdkResume && typeof agentSdkResume === "object" && !Array.isArray(agentSdkResume)) {
    body.agentSdkResume = agentSdkResume;
  }
  // Also server-derived: a durable restart barrier proves that any same-thread
  // warm SDK Query may contain an unconfirmed turn, even when its gateway claim
  // released before our exact ownership probe. Force a clean generation until a
  // later completed SDK attribution establishes a resumable journal.
  if (agentSdkNewGeneration === true) body.agentSdkNewGeneration = true;
  // Server-owned sticky spawn identity. The browser can select pins, but it can
  // neither forge the current logical-session epoch nor nominate an SDK journal.
  if (routeSession && typeof routeSession === "object" && !Array.isArray(routeSession)) {
    body.routeSession = routeSession;
  }
  return body;
}

/** Build the only SDK resume candidate the Web server may send. The latest
 * thread-level session id must be grounded in a completed assistant attribution
 * carrying the exact signed v2 SDK spawn assembly. A partial/legacy route,
 * external assistant notice, or stale earlier journal cannot nominate a resume
 * and therefore starts at an explicit clean boundary. */
export function agentSdkResumeFromThread(thread) {
  const sessionId = typeof thread?.claudeSessionId === "string" ? thread.claudeSessionId.trim() : "";
  if (!sessionId) return null;
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // A process-restart failure is a durable journal boundary. The abandoned SDK
    // process may have accepted the input (and even emitted partial output) before
    // Web lost ownership, so resuming a session from before this marker could
    // duplicate or silently inherit that uncertain turn. A later successful SDK
    // assistant message appears after the barrier and becomes resumable normally.
    if (message?.agentSdkResumeBarrier === true) return null;
    const route = message?.role === "assistant" && message.route && typeof message.route === "object"
      ? message.route
      : null;
    if (!route || route.runtime !== "agent-sdk" || route.sessionId !== sessionId) continue;
    // `route.model` is the model that actually answered and may be a provider
    // refusal fallback. Native-resume compatibility is instead the Query's
    // pre-runtime spawn configuration, retained in the effort-free signature.
    // This keeps the fallback visible without turning an intra-request retry into
    // a false cold-session boundary on the next input.
    const signature = sanitizeSpawnSignature(route.spawnSignature);
    // A journal is safe to resume only under the exact system prompt, tools, MCP,
    // permission mode, cwd and settings that spawned it. Those inputs are bound
    // into the opaque v2 assembly digest; legacy route metadata is insufficient.
    if (signature?.version !== 2 || signature.runtime !== "agent-sdk") return null;
    const resumeRoute = signature;
    const resumeTarget = typeof resumeRoute.target === "string" && resumeRoute.target
      ? resumeRoute.target
      : typeof resumeRoute.route === "string" && resumeRoute.route
        ? resumeRoute.route
        : null;
    if (
      !resumeTarget ||
      typeof resumeRoute.provider !== "string" || !resumeRoute.provider ||
      typeof resumeRoute.model !== "string" || !resumeRoute.model
    ) {
      return null;
    }
    return {
      sessionId,
      route: resumeTarget,
      runtime: "agent-sdk",
      provider: resumeRoute.provider,
      model: resumeRoute.model,
      effort: typeof route.effort === "string" && route.effort ? route.effort : null,
      account: typeof resumeRoute.account === "string" && resumeRoute.account ? resumeRoute.account : null,
      accountSource: typeof resumeRoute.accountSource === "string" && resumeRoute.accountSource ? resumeRoute.accountSource : null,
      projectPath: typeof resumeRoute.projectPath === "string" && resumeRoute.projectPath ? resumeRoute.projectPath : null,
      spawnSignature: signature,
    };
  }
  return null;
}

/** A released gateway claim can leave a warm same-thread SDK Query behind. When
 * the newest restart barrier is later than every completed SDK attribution, the
 * next queued input must explicitly evict that Query and start clean. Once a new
 * completed SDK turn is persisted after the barrier, normal resume selection is
 * safe again. */
export function agentSdkNewGenerationFromThread(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.agentSdkResumeBarrier === true) return true;
    const route = message?.role === "assistant" && message.route && typeof message.route === "object"
      ? message.route
      : null;
    if (
      route?.runtime === "agent-sdk" &&
      typeof route.route === "string" && route.route &&
      typeof route.provider === "string" && route.provider &&
      typeof route.model === "string" && route.model &&
      typeof route.sessionId === "string" && route.sessionId
    ) {
      return false;
    }
  }
  return false;
}

// ── Board discovery ──────────────────────────────────────────────────────────
// Board discovery remains a UI/route-options concern. It is intentionally not
// consulted while building a chat turn: board availability and card contents may
// not change the user message sent to the gateway.
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

// ── Durable Web input FIFO ──────────────────────────────────────────────────
// Browser requests are admissions, not runtime ownership. The server persists a
// per-thread FIFO and promotes exactly one input at a time. `inputId` is the Web
// admission coordinate; the gateway supplies a separate opaque `generationId`
// in its first `open` frame. Every live frame carries both once known.
const inputWorkers = new Map();
const DEFAULT_GATEWAY_OPEN_TIMEOUT_MS = 30_000;
// Production recovery is a server-lifetime worker: the delay is bounded, not the
// outage duration. Tests may set a finite attempt count to exercise the parked
// state without waiting for another process restart.
const DEFAULT_RESTART_RECOVERY_ATTEMPTS = Number.POSITIVE_INFINITY;
const DEFAULT_RESTART_RECOVERY_DELAY_MS = 250;

async function postGatewayRecoveryJson(opts, pathname, body, signal) {
  try {
    const timeoutSignal = AbortSignal.timeout(3_000);
    const requestSignal = signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(new URL(pathname, opts.gatewayUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  } catch (err) {
    return { status: 0, body: { error: String(err?.message ?? err) } };
  }
}

async function reconcileRecoveredInputViaGateway(opts, {
  threadId,
  inputId,
  generationId: expectedGenerationId,
  signal,
}) {
  const lookup = await postGatewayRecoveryJson(opts, "/chat/generation", { threadId, inputId }, signal);
  if (lookup.status === 404 && lookup.body?.code === "input_generation_unavailable") {
    return { cleared: true };
  }
  const foundGenerationId = typeof lookup.body?.generationId === "string" ? lookup.body.generationId.trim() : "";
  if (
    lookup.status !== 200 ||
    lookup.body?.threadId !== threadId ||
    lookup.body?.inputId !== inputId ||
    !foundGenerationId ||
    (typeof expectedGenerationId === "string" && expectedGenerationId !== foundGenerationId)
  ) {
    return { cleared: false };
  }
  // Restart recovery is stronger than a user Stop: the gateway must also abandon
  // any cached SDK Query/journal that may contain this unconfirmed input. The
  // endpoint is exact-input scoped, and retains its claim through runtime teardown.
  // Leave the marker in place regardless of this response; only a later exact
  // lookup's authoritative 404 makes the successor claimable.
  await postGatewayRecoveryJson(opts, "/chat/recover", { threadId, inputId }, signal);
  return { cleared: false };
}

function waitForRecoveryDelay(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolve prior-process gateway ownership before a queued successor is allowed
 * to claim the same thread. The exact trusted inputId seam covers both a pre-open
 * starting input and a generation-bound input; without an authoritative clear it
 * stays visibly queued instead of being sacrificed to a gateway 409. */
export async function reconcileStartupInputOwnership(startupInputs, opts, { signal, onCleared } = {}) {
  const configuredAttempts = Number(opts.restartRecoveryAttempts ?? opts.restartInterruptAttempts);
  const configuredDelay = Number(opts.restartRecoveryDelayMs ?? opts.restartInterruptDelayMs);
  const attempts = Number.isInteger(configuredAttempts) && configuredAttempts > 0
    ? configuredAttempts
    : DEFAULT_RESTART_RECOVERY_ATTEMPTS;
  const baseDelayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0
    ? configuredDelay
    : DEFAULT_RESTART_RECOVERY_DELAY_MS;
  const schedulable = new Set();
  await Promise.all(startupInputs.map(async (entry) => {
    const remaining = new Map(
      (entry.recoveryInputs ?? entry.failedInputs ?? []).map((input) => [input.inputId, input])
    );
    let delayMs = baseDelayMs;
    for (let attempt = 0; attempt < attempts && remaining.size > 0 && !signal?.aborted; attempt += 1) {
      for (const input of [...remaining.values()]) {
        let exactCleared = false;
        try {
          const reconcileInput = typeof opts.reconcileStartingInput === "function" && !input.generationId
            ? opts.reconcileStartingInput
            : (coordinate) => reconcileRecoveredInputViaGateway(opts, coordinate);
          const result = await reconcileInput({
            threadId: entry.threadId,
            inputId: input.inputId,
            generationId: input.generationId,
            gatewayUrl: opts.gatewayUrl,
            signal,
          });
          exactCleared = result === true || result?.cleared === true;
        } catch (err) {
          if (!signal?.aborted) {
            console.error(`[web-channel] input reconciliation failed for ${entry.threadId}: ${err.message}`);
          }
        }
        if (!exactCleared || signal?.aborted) continue;
        let durablyCleared = false;
        try {
          durablyCleared = await clearThreadInputRecoveryBlock(entry.threadId, input.inputId);
        } catch (err) {
          // A transient store outage must not kill the server-lifetime recovery
          // worker after the gateway has cleared. Retain the marker in memory and
          // retry the same idempotent lookup/write on the bounded backoff.
          if (!signal?.aborted) {
            console.error(`[web-channel] could not persist input recovery for ${entry.threadId}: ${err.message}`);
          }
        }
        if (durablyCleared) remaining.delete(input.inputId);
      }
      if (remaining.size > 0 && attempt + 1 < attempts) {
        if (!(await waitForRecoveryDelay(delayMs, signal))) return;
        delayMs = Math.min(Math.max(1, delayMs * 2), 5_000);
      }
    }
    if (remaining.size === 0 && !signal?.aborted) {
      // Schedule by thread, not by the startup queue snapshot. Admissions remain
      // allowed (and visibly queued) while ownership is parked; one may arrive
      // after startup and its first worker will correctly stop at the marker.
      // Re-triggering here lets that newer queued tail run exactly once too.
      schedulable.add(entry.threadId);
      onCleared?.(entry.threadId);
    } else if (remaining.size > 0 && !signal?.aborted) {
      console.error(
        `[web-channel] prior input ownership for ${entry.threadId} did not clear after ${attempts} attempts; ` +
        "queued inputs remain parked"
      );
    }
  }));
  return schedulable;
}

async function retryAuthoritativeWrites(writes, label) {
  let pending = [...writes];
  let delayMs = 100;
  while (pending.length > 0) {
    const retry = [];
    for (const work of pending) {
      try {
        await work();
      } catch (err) {
        retry.push(work);
        console.error(`[web-channel] authoritative persistence retry failed for ${label}: ${err.message}`);
      }
    }
    pending = retry;
    if (pending.length > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      });
      delayMs = Math.min(delayMs * 2, 5_000);
    }
  }
}

function workerKey(opts, threadId) {
  return `${opts.gatewayUrl}\n${threadId}`;
}

function inputLifecycle(input, extra = {}) {
  return {
    inputId: input.inputId,
    clientRequestId: input.clientRequestId,
    state: input.state,
    ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.generationId ? { generationId: input.generationId } : {}),
    ...(Number.isInteger(input.position) ? { position: input.position } : {}),
    ...extra,
  };
}

function publishInputLifecycle(input, extra = {}) {
  appendInputLiveFrame(input.inputId, { event: "input", data: inputLifecycle(input, extra) });
}

function parseFrameObject(data) {
  try {
    const parsed = data ? JSON.parse(data) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stampInputFrame(name, data, inputId, generationId) {
  const parsed = parseFrameObject(data);
  if (!parsed) return { event: name, data };
  const stamped = {
    ...parsed,
    inputId,
    ...(generationId ? { generationId } : {}),
  };
  if (name === "session_event") stamped.turnId = inputId;
  return { event: name, data: JSON.stringify(stamped), payload: stamped };
}

const FAILURE_TEXT_CAP = 1_000;
const TERMINAL_STATES = new Set(["completed", "error", "cancelled"]);

function safeFailureText(value, fallback = "The turn did not complete.") {
  const text = typeof value === "string" ? value : "";
  const clean = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\S*/gi, "the local service")
    .trim();
  return (clean || fallback).slice(0, FAILURE_TEXT_CAP);
}

function failureKindForStatus(status) {
  if (status === 401) return "authentication";
  if (status === 402) return "billing";
  if (status === 403) return "authorization";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "transport";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  return "invalid_request";
}

function normalizeFailure(raw, fallback = {}) {
  const candidate = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw.failure && typeof raw.failure === "object" && !Array.isArray(raw.failure) ? raw.failure : raw)
    : {};
  const httpStatus = Number.isInteger(candidate.httpStatus)
    ? candidate.httpStatus
    : Number.isInteger(fallback.httpStatus)
      ? fallback.httpStatus
      : null;
  const value = {
    code: typeof candidate.code === "string" && candidate.code.trim()
      ? candidate.code.trim()
      : String(fallback.code ?? (httpStatus ? `upstream_http_${httpStatus}` : "turn_failed")),
    kind: typeof candidate.kind === "string" && candidate.kind.trim()
      ? candidate.kind.trim()
      : String(fallback.kind ?? (httpStatus ? failureKindForStatus(httpStatus) : "unknown")),
    source: typeof candidate.source === "string" && candidate.source.trim()
      ? candidate.source.trim()
      : String(fallback.source ?? "web"),
    text: safeFailureText(candidate.text ?? candidate.error ?? fallback.text),
    retryable: typeof candidate.retryable === "boolean"
      ? candidate.retryable
      : Boolean(fallback.retryable ?? (httpStatus === null || httpStatus === 408 || httpStatus === 409 || httpStatus === 429 || httpStatus >= 500)),
    ...(httpStatus !== null ? { httpStatus } : {}),
    ...(typeof candidate.requestId === "string" && candidate.requestId.trim()
      ? { requestId: candidate.requestId.trim() }
      : typeof fallback.requestId === "string" && fallback.requestId.trim()
        ? { requestId: fallback.requestId.trim() }
        : {}),
    ...(typeof candidate.retryAt === "number" && Number.isFinite(candidate.retryAt)
      ? { retryAt: candidate.retryAt }
      : typeof fallback.retryAt === "number" && Number.isFinite(fallback.retryAt)
        ? { retryAt: fallback.retryAt }
        : {}),
  };
  return sanitizeFailureInfo(value) ?? {
    code: "turn_failed",
    kind: "unknown",
    source: "web",
    text: safeFailureText(fallback.text),
    retryable: false,
  };
}

function localTerminalEvent({ inputId, generationId, failure, previous, now = Date.now() }) {
  const coordinate = generationId ?? inputId;
  const id = `terminal:${JSON.stringify([coordinate])}`;
  const previousMatches = previous?.id === id ? previous : null;
  return {
    id,
    role: "assistant",
    ts: previousMatches?.ts ?? now,
    turnId: inputId,
    ...(generationId ? { generationId } : {}),
    order: previousMatches?.order ?? Number.MAX_SAFE_INTEGER,
    revision: (previousMatches?.revision ?? 0) + 1,
    blocks: [
      { type: "error", ...failure },
      {
        type: "turn_end",
        status: "error",
        subtype: failure.code,
        reason: failure.code,
        stopReason: null,
        terminalReason: null,
      },
    ],
  };
}

function localSuccessTerminalEvent({ inputId, generationId, status, result, previous, now = Date.now() }) {
  const coordinate = generationId ?? inputId;
  const id = `terminal:${JSON.stringify([coordinate])}`;
  const previousMatches = previous?.id === id ? previous : null;
  return {
    id,
    role: "assistant",
    ts: previousMatches?.ts ?? now,
    turnId: inputId,
    ...(generationId ? { generationId } : {}),
    order: previousMatches?.order ?? Number.MAX_SAFE_INTEGER,
    revision: (previousMatches?.revision ?? 0) + 1,
    blocks: [{
      type: "turn_end",
      status,
      subtype: status === "cancelled" ? "cancelled" : "success",
      reason: status === "cancelled" ? "user_interrupt" : "completed",
      stopReason: status === "cancelled" ? "user" : null,
      terminalReason: status === "cancelled" ? null : "completed",
      ...(typeof result === "string" && result ? { result: result.slice(0, 20_000) } : {}),
    }],
  };
}

async function readBoundedResponseBody(response, cap = 64 * 1024) {
  let text = "";
  for await (const chunk of response) {
    if (text.length >= cap) continue;
    text += Buffer.from(chunk).toString("utf8", 0, Math.max(0, cap - text.length));
  }
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* bounded prose fallback below */ }
  return { text, payload };
}

async function runQueuedInput(threadId, input, opts) {
  const target = new URL("/chat/stream", opts.gatewayUrl);
  const durableThread = await getThread(threadId);
  const payload = JSON.stringify(buildGatewayChatBody({
    message: input.message,
    classification: input.classification,
    sessionId: threadId,
    inputId: input.inputId,
    routing: input.routing,
    turnSeq: input.turnSeq,
    autonomous: input.autonomous,
    agentSdkResume: agentSdkResumeFromThread(durableThread),
    agentSdkNewGeneration: agentSdkNewGenerationFromThread(durableThread),
    routeSession: durableThread?.routeSession ?? null,
  }));

  let generationId = null;
  let protocolFailed = false;
  let cancelOpenWatchdog = () => {};
  let preRoute = null;
  let terminal = null;
  let terminalFailure = null;
  let canonicalTerminal = null;
  let conflictingTerminal = null;
  let acceptedRouteSession = sanitizeRouteSession(durableThread?.routeSession);
  let persistence = Promise.resolve();
  const failedWrites = [];
  const queueThreadWrite = (work) => {
    persistence = persistence.then(work).catch((err) => {
      failedWrites.push(work);
      console.error(`[web-channel] failed to persist input ${input.inputId} in thread ${threadId}: ${err.message}`);
    });
    return persistence;
  };
  const queueSession = (frame) => {
    const sessionId = frame?.session_id ?? frame?.sessionId;
    if (sessionId) queueThreadWrite(() => setThreadSession(threadId, String(sessionId)));
  };
  const queueRouteSession = (frame) => {
    const routeSession = sanitizeRouteSession({ epoch: frame?.sessionEpoch, signature: frame?.spawnSignature });
    if (!routeSession) return false;
    if (acceptedRouteSession) {
      if (routeSession.epoch < acceptedRouteSession.epoch) return false;
      if (
        routeSession.epoch === acceptedRouteSession.epoch &&
        JSON.stringify(routeSession.signature) !== JSON.stringify(acceptedRouteSession.signature)
      ) return false;
      if (JSON.stringify(routeSession) === JSON.stringify(acceptedRouteSession)) return true;
    }
    acceptedRouteSession = routeSession;
    queueThreadWrite(async () => {
      const stored = await setThreadRouteSession(threadId, routeSession);
      if (JSON.stringify(stored) !== JSON.stringify(routeSession)) {
        throw new Error("gateway route session conflicted with durable thread state");
      }
      return stored;
    });
    return true;
  };
  const terminalBlockFrom = (event) => Array.isArray(event?.blocks)
    ? event.blocks.find((block) => block?.type === "turn_end" && TERMINAL_STATES.has(block.status)) ?? null
    : null;
  const failureBlockFrom = (event) => Array.isArray(event?.blocks)
    ? event.blocks.find((block) => block?.type === "error") ?? null
    : null;
  const persistExactTerminal = async (candidate) => {
    const cleanCandidate = sanitizeSessionEvent(candidate);
    if (!cleanCandidate) return null;
    await persistence;
    if (failedWrites.length > 0) {
      await retryAuthoritativeWrites(
        failedWrites.splice(0),
        `pre-terminal writes for input ${input.inputId} in thread ${threadId}`,
      );
    }
    let stored = null;
    try {
      stored = await appendSessionEvent(threadId, cleanCandidate);
    } catch (err) {
      await retryAuthoritativeWrites([async () => {
        stored = await appendSessionEvent(threadId, cleanCandidate);
        if (!stored) throw new Error("canonical terminal event was not accepted");
      }], `canonical terminal ${input.inputId} in thread ${threadId}`);
    }
    if (stored && JSON.stringify(stored) === JSON.stringify(cleanCandidate)) return stored;
    if (stored?.id === cleanCandidate.id && terminalBlockFrom(stored)) conflictingTerminal = stored;
    return null;
  };
  const persistAssistantOutcome = (frame, text) => {
    const route = attributionFromFrame({ ...(preRoute ?? {}), ...frame, pending: null }) ?? undefined;
    queueThreadWrite(() => appendMessages(threadId, [{
      role: "assistant",
      text,
      turnId: input.inputId,
      route,
    }], { idempotencyKey: `input-reply:${input.inputId}` }));
    queueSession(frame);
  };
  const persistDone = async (frame) => {
    if (terminal) return;
    let canonicalStatus = terminalBlockFrom(canonicalTerminal)?.status ?? null;
    const declaresTerminalStatus = Object.hasOwn(frame ?? {}, "terminalStatus");
    const reportedStatus = TERMINAL_STATES.has(frame?.terminalStatus) ? frame.terminalStatus : null;
    // Older fitting stubs and third-party gateways have no typed terminal field.
    // Adapt that legacy shape once at this boundary by creating the same canonical
    // event; a gateway that claims the M6 contract (`terminalStatus`) must already
    // have emitted the matching event and still fails closed when it did not.
    if (!canonicalStatus && !declaresTerminalStatus) {
      canonicalStatus = frame?.stopped_by_user === true || frame?.stoppedByUser === true ? "cancelled" : "completed";
      canonicalTerminal = localSuccessTerminalEvent({
        inputId: input.inputId,
        generationId,
        status: canonicalStatus,
        result: typeof frame?.reply === "string" ? frame.reply : "",
      });
      const storedTerminal = await persistExactTerminal(canonicalTerminal);
      if (!storedTerminal) {
        failProtocol("gateway generation conflicted with an existing durable terminal event");
        return;
      }
      canonicalTerminal = storedTerminal;
    }
    if (!canonicalStatus || (declaresTerminalStatus && reportedStatus !== canonicalStatus)) {
      failProtocol(
        canonicalStatus
          ? "The gateway reported a terminal outcome that contradicted its canonical event."
          : "The gateway completed without a canonical terminal event.",
        "terminal_contract_invalid",
      );
      return;
    }
    const canonicalResult = terminalBlockFrom(canonicalTerminal)?.result;
    if (
      canonicalStatus === "completed" &&
      typeof canonicalResult === "string" &&
      frame?.reply !== canonicalResult
    ) {
      failProtocol(
        "The gateway reply contradicted the result in its canonical terminal event.",
        "terminal_contract_invalid",
      );
      return;
    }
    if (canonicalStatus === "completed") {
      terminal = "settled";
      const reply = typeof frame?.reply === "string" ? frame.reply : "";
      persistAssistantOutcome(frame, reply);
      return;
    }
    if (canonicalStatus === "cancelled") {
      terminal = "stopped";
      persistAssistantOutcome(frame, typeof frame?.reply === "string" ? frame.reply : "");
      return;
    }
    const failure = normalizeFailure(failureBlockFrom(canonicalTerminal) ?? frame, {
      code: "provider_execution_failed",
      kind: "execution",
      source: "result",
      text: "The provider could not complete this response.",
      retryable: false,
    });
    terminal = "failed";
    terminalFailure = failure;
    persistAssistantOutcome({ ...frame, stoppedReason: failure.text }, "");
  };
  const persistFailed = (rawFailure) => {
    if (terminal) return;
    // Once a canonical error terminal exists it is the durable authority. A
    // later lifecycle frame may carry a compatibility projection, but it cannot
    // change the code/details recorded on the receipt.
    const canonicalFailure = !conflictingTerminal && canonicalTerminal?.turnId === input.inputId && terminalBlockFrom(canonicalTerminal)?.status === "error"
      ? failureBlockFrom(canonicalTerminal)
      : null;
    const failure = normalizeFailure(canonicalFailure ?? rawFailure, {
      code: "turn_failed",
      kind: "unknown",
      source: "web",
      text: "The turn did not complete.",
      retryable: false,
    });
    terminal = "failed";
    terminalFailure = failure;
    if (conflictingTerminal || terminalBlockFrom(canonicalTerminal)?.status !== "error" || !failureBlockFrom(canonicalTerminal)) {
      canonicalTerminal = localTerminalEvent({
        inputId: input.inputId,
        generationId,
        failure,
        previous: conflictingTerminal ?? canonicalTerminal,
      });
      conflictingTerminal = null;
      queueThreadWrite(() => appendSessionEvent(threadId, canonicalTerminal));
    }
    persistAssistantOutcome({ ...(preRoute ?? {}), stoppedReason: failure.text }, "");
  };
  const failProtocol = (reason, code = "gateway_stream_protocol_error") => {
    if (protocolFailed || terminal) return;
    protocolFailed = true;
    const failure = normalizeFailure(null, {
      code,
      kind: "protocol",
      source: "web",
      text: reason,
      retryable: false,
    });
    const stampedError = stampInputFrame("error", JSON.stringify({ error: failure.text, failure, ...failure }), input.inputId, generationId);
    appendInputLiveFrame(input.inputId, stampedError);
    persistFailed(failure);
  };

  let frameChain = Promise.resolve();
  const queueStreamFailure = (failure) => {
    frameChain = frameChain.then(() => {
      // A socket can report a late error after its complete terminal bytes were
      // already decoded. Terminal ordering is authoritative: never append a
      // contradictory live error after success/cancellation/error has latched.
      if (terminal) return;
      const frame = stampInputFrame(
        "error",
        JSON.stringify({ error: failure.text, failure, ...failure }),
        input.inputId,
        generationId,
      );
      appendInputLiveFrame(input.inputId, frame);
      persistFailed(failure);
    });
  };
  const handleFrame = async ({ event: name, data }) => {
    const raw = parseFrameObject(data);
    if (name === "open") {
      const candidate = typeof raw?.generationId === "string" ? raw.generationId.trim() : "";
      if (!candidate) {
        failProtocol("gateway open frame did not include a generationId");
        return;
      }
      if (generationId) {
        if (candidate !== generationId) {
          failProtocol("gateway emitted a conflicting generationId after open");
        }
        return;
      }
      if (protocolFailed || terminal) return;
      const running = await bindThreadInputGeneration(threadId, input.inputId, candidate);
      if (!running) {
        failProtocol("gateway generation did not match the promoted input");
        return;
      }
      generationId = candidate;
      cancelOpenWatchdog();
      publishInputLifecycle(running);
    } else if (!generationId) {
      failProtocol(`gateway emitted ${name || "data"} before its open frame`);
      return;
    }

    if (protocolFailed || terminal) return;

    if (canonicalTerminal) {
      const isTerminalRevision = name === "session_event" && Array.isArray(raw?.blocks) &&
        raw.blocks.some((block) => block?.type === "turn_end");
      const canonicalFailure = terminalBlockFrom(canonicalTerminal)?.status === "error"
        ? sanitizeFailureInfo(failureBlockFrom(canonicalTerminal))
        : null;
      const projectedFailure = name === "error"
        ? sanitizeFailureInfo(raw?.failure ?? raw)
        : null;
      const isMatchingErrorProjection = Boolean(
        canonicalFailure && projectedFailure &&
        JSON.stringify(projectedFailure) === JSON.stringify(canonicalFailure)
      );
      if (name !== "done" && !isTerminalRevision && !isMatchingErrorProjection) {
        failProtocol(`gateway emitted ${name || "data"} after its canonical terminal event`);
        return;
      }
    }

    if (["session_event", "route", "done", "error"].includes(name) && !raw) {
      failProtocol(`gateway emitted ${name} without a valid JSON object payload`);
      return;
    }
    if (name === "done" && typeof raw.reply !== "string" && !Object.hasOwn(raw, "terminalStatus")) {
      failProtocol("gateway emitted a done frame without a reply or terminal status");
      return;
    }

    const stamped = stampInputFrame(name, data, input.inputId, generationId);
    const frame = stamped.payload ?? raw ?? {};
    let cleanSessionEvent = null;
    if (name === "session_event") {
      const expectedTerminalId = `terminal:${JSON.stringify([generationId])}`;
      if (Array.isArray(frame?.retracts) && frame.retracts.includes(expectedTerminalId)) {
        failProtocol("gateway attempted to retract the canonical terminal event");
        return;
      }
      cleanSessionEvent = sanitizeSessionEvent(frame);
      if (!cleanSessionEvent) {
        failProtocol("gateway emitted a malformed canonical session event");
        return;
      }
      const rawClaimsTerminal = Array.isArray(frame?.blocks) &&
        frame.blocks.some((block) => block?.type === "turn_end");
      if (cleanSessionEvent.id.startsWith("terminal:") && !rawClaimsTerminal) {
        failProtocol("gateway reused the reserved terminal event id for a nonterminal event");
        return;
      }
      if (rawClaimsTerminal) {
        const terminalBlocks = cleanSessionEvent?.blocks?.filter((block) => block?.type === "turn_end") ?? [];
        const errorBlocks = cleanSessionEvent?.blocks?.filter((block) => block?.type === "error") ?? [];
        const rawErrorBlocks = Array.isArray(frame?.blocks)
          ? frame.blocks.filter((block) => block?.type === "error")
          : [];
        const terminalStatus = terminalBlocks[0]?.status ?? null;
        const coherentFailure = terminalStatus === "error"
          ? errorBlocks.length === 1 && rawErrorBlocks.length === 1 && Boolean(sanitizeFailureInfo(rawErrorBlocks[0]))
          : errorBlocks.length === 0 && rawErrorBlocks.length === 0;
        if (
          cleanSessionEvent.role !== "assistant" ||
          cleanSessionEvent.id !== expectedTerminalId ||
          terminalBlocks.length !== 1 ||
          !coherentFailure
        ) {
          failProtocol("gateway emitted an invalid canonical terminal event");
          return;
        }

        // A canonical terminal is not visible or authoritative until the exact
        // sanitized candidate is durably accepted. This prevents a reused
        // generation/stale revision from settling against a different stored
        // terminal outcome.
        const storedTerminal = await persistExactTerminal(cleanSessionEvent);
        if (!storedTerminal) {
          failProtocol("gateway canonical terminal conflicted with the durable journal");
          return;
        }
        canonicalTerminal = storedTerminal;
        const failureBlock = failureBlockFrom(storedTerminal);
        if (failureBlock) terminalFailure = normalizeFailure(failureBlock);
        appendInputLiveFrame(input.inputId, {
          event: "session_event",
          data: JSON.stringify(storedTerminal),
        });
        return;
      }
    }
    if ((name === "route" || name === "done") &&
        (Object.hasOwn(frame, "sessionEpoch") || Object.hasOwn(frame, "spawnSignature")) &&
        !queueRouteSession(frame)) {
      failProtocol("gateway frame conflicted with the durable route session");
      return;
    }
    if (name === "done") {
      await persistDone(frame);
      if (!protocolFailed) appendInputLiveFrame(input.inputId, stamped);
      return;
    }
    appendInputLiveFrame(input.inputId, stamped);
    if (name === "session_event") {
      queueThreadWrite(() => appendSessionEvent(threadId, cleanSessionEvent));
    } else if (name === "route") {
      preRoute = { ...(preRoute ?? {}), ...frame };
      queueSession(frame);
    } else if (name === "error") {
      persistFailed(frame);
    }
  };
  const decoder = new SseFrameDecoder((frame) => {
    frameChain = frameChain.then(() => handleFrame(frame));
  });

  await new Promise((resolve) => {
    let finished = false;
    let upstreamResponse = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelOpenWatchdog();
      resolve();
    };
    const upstream = http.request({
      method: "POST",
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Accept: "text/event-stream",
      },
    }, (up) => {
      upstreamResponse = up;
      if (up.statusCode && up.statusCode >= 400) {
        void (async () => {
          const body = await readBoundedResponseBody(up);
          const failure = normalizeFailure(body.payload, {
            code: `gateway_http_${up.statusCode}`,
            kind: failureKindForStatus(up.statusCode),
            source: "gateway",
            text: body.text || `The gateway refused this input (${up.statusCode}).`,
            retryable: up.statusCode === 408 || up.statusCode === 409 || up.statusCode === 429 || up.statusCode >= 500,
            httpStatus: up.statusCode,
          });
          const frame = stampInputFrame("error", JSON.stringify({ error: failure.text, failure, ...failure }), input.inputId, generationId);
          appendInputLiveFrame(input.inputId, frame);
          persistFailed(failure);
          finish();
        })().catch(() => finish());
        return;
      }
      up.on("data", (chunk) => decoder.push(chunk));
      up.on("end", finish);
      up.on("error", (err) => {
        const failure = normalizeFailure(null, {
          code: "gateway_response_failed",
          kind: "transport",
          source: "web",
          text: "The gateway connection failed while reading the response.",
          retryable: true,
        });
        queueStreamFailure(failure);
        finish();
      });
    });
    upstream.on("error", (err) => {
      const failure = normalizeFailure(null, {
        code: "gateway_connection_failed",
        kind: "transport",
        source: "web",
        text: "The Web channel could not connect to the gateway.",
        retryable: true,
      });
      queueStreamFailure(failure);
      finish();
    });
    const configuredTimeout = Number(opts.gatewayOpenTimeoutMs);
    const openTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_GATEWAY_OPEN_TIMEOUT_MS;
    const watchdog = setTimeout(() => {
      if (generationId || terminal) return;
      const reason = `gateway did not open the input within ${openTimeoutMs}ms`;
      failProtocol(reason);
      upstreamResponse?.destroy(new Error(reason));
      upstream.destroy(new Error(reason));
      finish();
    }, openTimeoutMs);
    watchdog.unref?.();
    cancelOpenWatchdog = () => clearTimeout(watchdog);
    upstream.write(payload);
    upstream.end();
  });

  await frameChain;
  if (!terminal) {
    const failure = normalizeFailure(null, {
      code: "gateway_stream_ended",
      kind: "protocol",
      source: "web",
      text: "The gateway stream ended without a terminal frame.",
      retryable: true,
    });
    const frame = stampInputFrame("error", JSON.stringify({ error: failure.text, failure, ...failure }), input.inputId, generationId);
    appendInputLiveFrame(input.inputId, frame);
    persistFailed(failure);
  }
  await persistence;
  await retryAuthoritativeWrites(failedWrites, `input ${input.inputId} in thread ${threadId}`);
  // Local compatibility/error terminals use the same exact durable authority as
  // gateway-provided M6 terminals. If a reused generation collided with an older
  // terminal, advance that stable id with this input's failure rather than ever
  // settling from a candidate the journal refused.
  if (canonicalTerminal) {
    const cleanTerminal = sanitizeSessionEvent(canonicalTerminal);
    const storedTerminal = cleanTerminal ? await appendSessionEvent(threadId, cleanTerminal) : null;
    if (!cleanTerminal || !storedTerminal || JSON.stringify(storedTerminal) !== JSON.stringify(cleanTerminal)) {
      const failure = terminalFailure ?? normalizeFailure(null, {
        code: "terminal_generation_conflict",
        kind: "protocol",
        source: "web",
        text: "The gateway generation conflicted with an earlier durable terminal.",
        retryable: false,
      });
      terminal = "failed";
      terminalFailure = failure;
      canonicalTerminal = sanitizeSessionEvent(localTerminalEvent({
        inputId: input.inputId,
        generationId,
        failure,
        previous: storedTerminal,
      }));
      await retryAuthoritativeWrites([async () => {
        const stored = await appendSessionEvent(threadId, canonicalTerminal);
        if (!stored || JSON.stringify(stored) !== JSON.stringify(canonicalTerminal)) {
          throw new Error("replacement canonical terminal event was not accepted");
        }
      }], `replacement terminal ${input.inputId} in thread ${threadId}`);
      appendInputLiveFrame(input.inputId, {
        event: "session_event",
        data: JSON.stringify(canonicalTerminal),
      });
    }
  }
  let settled = null;
  await retryAuthoritativeWrites([async () => {
    settled = await settleThreadInput(threadId, input.inputId, terminal ?? "failed", {
      ...(generationId ? { generationId } : {}),
      ...(terminalFailure ? { reason: terminalFailure.text, failure: terminalFailure } : {}),
    });
    if (!settled) throw new Error("durable input identity no longer matched its terminal outcome");
  }], `settlement ${input.inputId} in thread ${threadId}`);
  publishInputLifecycle(settled);
  finishInputLive(threadId, input.inputId, terminal ?? "failed");
}

async function processThreadInputs(threadId, opts) {
  for (;;) {
    const input = await claimNextThreadInput(threadId);
    if (!input) return;
    let ownsLive = markInputActive(threadId, input.inputId, input.startedAt);
    if (!ownsLive) {
      const competingInputId = activeInputId(threadId);
      const competingInput = competingInputId
        ? await getThreadInput(threadId, competingInputId)
        : null;
      // The process-local registry can outlive a defensive/test-owned producer,
      // but it may never veto a durable claim forever. Clear only an owner that
      // has no matching pending input, then retry this exact claim once.
      if (competingInputId && (!competingInput || ["settled", "stopped", "failed"].includes(competingInput.state))) {
        finishInputLive(threadId, competingInputId, "stale-active-owner");
        ownsLive = markInputActive(threadId, input.inputId, input.startedAt);
      }
    }
    if (!ownsLive) {
      const failure = normalizeFailure(null, {
        code: "web_thread_input_conflict",
        kind: "protocol",
        source: "web",
        text: "The Web channel found conflicting ownership for this conversation input.",
        retryable: true,
      });
      appendInputLiveFrame(input.inputId, stampInputFrame(
        "error",
        JSON.stringify({ error: failure.text, failure, ...failure }),
        input.inputId,
        null,
      ));
      const terminalEvent = localTerminalEvent({ inputId: input.inputId, generationId: null, failure });
      await retryAuthoritativeWrites([
        () => appendSessionEvent(threadId, terminalEvent),
        () => appendMessages(threadId, [{
          role: "assistant",
          text: "",
          turnId: input.inputId,
          route: { stoppedReason: failure.text },
        }], { idempotencyKey: `input-reply:${input.inputId}` }),
      ], `ownership conflict ${input.inputId} in thread ${threadId}`);
      let failed = null;
      await retryAuthoritativeWrites([async () => {
        failed = await settleThreadInput(threadId, input.inputId, "failed", {
          reason: failure.text,
          failure,
        });
        if (!failed) throw new Error("durable input identity no longer matched its ownership failure");
      }], `ownership conflict settlement ${input.inputId} in thread ${threadId}`);
      publishInputLifecycle(failed);
      finishInputLive(threadId, input.inputId, "failed");
      return;
    }
    publishInputLifecycle(input);
    try {
      await runQueuedInput(threadId, input, opts);
    } catch (err) {
      const latestInput = await getThreadInput(threadId, input.inputId);
      const generationId = latestInput?.generationId ?? null;
      const failure = normalizeFailure(null, {
        code: "web_input_worker_failed",
        kind: "runtime",
        source: "web",
        text: "The Web channel could not finish processing this input.",
        retryable: true,
      });
      appendInputLiveFrame(input.inputId, stampInputFrame(
        "error",
        JSON.stringify({ error: failure.text, failure, ...failure }),
        input.inputId,
        generationId,
      ));
      const terminalEvent = localTerminalEvent({ inputId: input.inputId, generationId, failure });
      await retryAuthoritativeWrites([
        () => appendSessionEvent(threadId, terminalEvent),
        () => appendMessages(threadId, [{
          role: "assistant",
          text: "",
          turnId: input.inputId,
          route: { stoppedReason: failure.text },
        }], { idempotencyKey: `input-reply:${input.inputId}` })],
      `worker failure ${input.inputId} in thread ${threadId}`);
      // Never acknowledge/remove the only durable copy of an input unless there
      // is also a durable assistant outcome. Keep the exact worker/live owner
      // while storage is unavailable, then continue the FIFO after recovery.
      let failed = null;
      await retryAuthoritativeWrites([async () => {
        failed = await settleThreadInput(threadId, input.inputId, "failed", {
          ...(generationId ? { generationId } : {}),
          reason: failure.text,
          failure,
        });
        if (!failed) throw new Error("durable input identity no longer matched its worker failure");
      }], `worker failure settlement ${input.inputId} in thread ${threadId}`);
      publishInputLifecycle(failed);
      finishInputLive(threadId, input.inputId, "failed");
    }
  }
}

function scheduleThreadInputs(threadId, opts) {
  const key = workerKey(opts, threadId);
  if (inputWorkers.has(key)) return;
  const worker = processThreadInputs(threadId, opts).finally(() => {
    if (inputWorkers.get(key) === worker) inputWorkers.delete(key);
  });
  inputWorkers.set(key, worker);
}

async function admitWebInput(threadId, raw, opts, { legacy = false } = {}) {
  const missingThread = () => {
    const failure = normalizeFailure(null, {
      code: "web_thread_not_found",
      kind: "not_found",
      source: "web",
      text: "This conversation no longer exists.",
      retryable: false,
      httpStatus: 404,
    });
    return { status: 404, error: failure.text, failure };
  };
  const thread = await getThread(threadId) ?? (legacy ? await ensureThread({ id: threadId }) : null);
  if (!thread) return missingThread();
  const routing = mergeTurnRouting(thread.routing ?? null, raw?.routing);
  const clientRequestId = typeof raw?.clientRequestId === "string" && raw.clientRequestId.trim()
    ? raw.clientRequestId.trim()
    : (legacy ? `legacy:${Date.now()}:${Math.random().toString(36).slice(2)}` : "");
  let admitted;
  try {
    admitted = await admitThreadInput(threadId, {
      message: raw?.message,
      clientRequestId,
      routing,
      classification: raw?.classification,
      autonomous: raw?.autonomous,
      turnSeq: raw?.turnSeq,
    });
  } catch (err) {
    const queueFull = err?.code === "QUEUE_FULL";
    const status = queueFull ? 429 : 400;
    const failure = normalizeFailure(null, {
      code: queueFull ? "web_input_queue_full" : "web_input_rejected",
      // A bounded local FIFO is not provider rate limiting. Keeping it in the
      // generic limit bucket prevents the UI from inventing a provider reset.
      kind: queueFull ? "limit" : "invalid_request",
      source: "web",
      text: queueFull ? "This conversation queue is full. Wait for pending inputs to finish." : safeFailureText(err?.message, "The input was rejected."),
      retryable: queueFull,
      httpStatus: status,
    });
    return { status, error: failure.text, failure };
  }
  if (!admitted) return missingThread();
  const input = admitted.input;
  if (!admitted.duplicate) {
    startInputLive(input.inputId, input.acceptedAt);
    publishInputLifecycle(input);
    setImmediate(() => scheduleThreadInputs(threadId, opts));
  } else if (input.state === "queued") {
    startInputLive(input.inputId, input.acceptedAt);
    setImmediate(() => scheduleThreadInputs(threadId, opts));
  }
  return { status: 202, input, duplicate: admitted.duplicate };
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
  if (threadId) {
    // Compatibility wrapper: old clients still POST /api/chat and expect the SSE
    // on that response, but execution now goes through the same durable FIFO as
    // the receipt-first endpoint. Closing this response never cancels the worker.
    const admitted = await admitWebInput(threadId, { ...body, message }, opts, { legacy: true });
    if (admitted.error) return jsonRes(res, admitted.status, { error: admitted.error, failure: admitted.failure });
    if (!admitted.input || !["queued", "starting", "running", "stopping"].includes(admitted.input.state)) {
      return jsonRes(res, 409, { error: "input already settled", input: admitted.input ?? null });
    }
    return handleInputLive(req, res, admitted.input.inputId);
  }

  // Generated Web execution needs the durable input/thread/generation identity
  // used by the standing SDK lane. A threadless compatibility request would
  // otherwise share a target-keyed SDK Query across unrelated browser callers.
  // Fail before touching the gateway; the explicit /api/claude console remains
  // the separate, intentionally shared standing-operative surface.
  const failure = {
    source: "web",
    kind: "invalid_request",
    code: "web_thread_required",
    text: "Generated Web turns require a durable thread identity.",
    retryable: false,
    httpStatus: 400,
  };
  return jsonRes(res, 400, { error: failure.text, failure });
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
  if (activeInputId(raw.trim())) {
    return jsonRes(res, 409, {
      error: "an exact generationId is required for an active Web input",
      endpoint: `/api/threads/${encodeURIComponent(raw.trim())}/interrupt`,
    });
  }
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
  // have a turn in flight, not just the one that is open. A remote-shell thread
  // additionally spins on the fitting's HOOK-DRIVEN session state, so work
  // typed straight into the remote TUI still shows as live.
  const running = new Set(runningThreadIds());
  const rsh = await remoteShellSessions();
  const threads = (await listThreads()).map((t) => {
    const session = matchRemoteShellSession(t.remoteShell, rsh);
    // The agent's own lifecycle IS this thread's activity: a terminal-first
    // shell never writes a message, so without this its row would sit at the
    // bottom of the rail forever, however busy the agent is.
    const meta = session
      ? {
          ...t,
          remoteShell: {
            ...t.remoteShell,
            sessionId: session.id,
            state: session.state ?? null,
            lastEventAt: session.lastEventAt ?? null,
            link: session.link ?? null
          },
          updatedAt: laterOf(t.updatedAt, session.lastEventAt)
        }
      : t;
    if (running.has(t.id)) return { ...meta, runningSince: runningSince(t.id) };
    if (session?.state === "running") {
      return { ...meta, runningSince: session.lastEventAt ?? session.createdAt ?? new Date().toISOString() };
    }
    // A conversation thread's work is launcher-driven: its liveness lives in the
    // conversation store, not in this server's input lifecycle.
    const conversationSince = conversationRunningSince(t.conversationId ?? null);
    if (conversationSince) return { ...meta, runningSince: conversationSince };
    return meta;
  });
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
  const snapshot = await getThreadSnapshot(id);
  if (!snapshot) return jsonRes(res, 404, { error: "thread not found" });
  const sessionEvents = await recoverThreadSessionJournal(snapshot.thread);
  // The client rebuilds a reopened thread from persisted history, which is empty
  // for a turn still in flight. Without this it cannot tell "idle" from "working"
  // and the conversation looks dead until the reply lands.
  jsonRes(res, 200, {
    thread: {
      ...snapshot.thread,
      sessionEvents,
      pendingInputs: snapshot.pendingInputs,
      inputRevision: snapshot.inputRevision,
      runningSince: runningSince(id),
    },
  });
}

// Replay the buffered prefix of a running turn, then follow new frames until the
// producer settles. The URL is deliberately same-origin and contains only the
// opaque thread id; no gateway address or machine-local path reaches the browser.
function handleInputLive(req, res, inputId) {
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

  subscription = subscribeInputLive(inputId, { onFrame: writeFrame, onEnd: end });
  if (!subscription) return jsonRes(res, 404, { error: "input has no live stream" });

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

function handleThreadLive(req, res, id) {
  const inputId = activeInputId(id);
  if (!inputId) return jsonRes(res, 404, { error: "thread has no running turn" });
  return handleInputLive(req, res, inputId);
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

async function handleThreadInputsGet(res, id) {
  const snapshot = await getThreadSnapshot(id);
  if (!snapshot) return jsonRes(res, 404, { error: "thread not found" });
  jsonRes(res, 200, { inputs: snapshot.pendingInputs, inputRevision: snapshot.inputRevision });
}

async function handleThreadInputCreate(req, res, opts, id) {
  const reject = (status, code, text) => {
    const failure = normalizeFailure(null, {
      code,
      kind: status === 404 ? "not_found" : "invalid_request",
      source: "web",
      text,
      retryable: false,
      httpStatus: status,
    });
    return jsonRes(res, status, { error: failure.text, failure });
  };
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return reject(400, "web_input_json_invalid", "The input request was not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reject(400, "web_input_body_invalid", "The input request must be a JSON object.");
  }
  const allowed = new Set(["message", "clientRequestId", "routing", "classification", "autonomous", "turnSeq"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return reject(400, "web_input_fields_unsupported", "The input request contains unsupported fields.");
  }
  const admitted = await admitWebInput(id, body, opts);
  if (admitted.error) return jsonRes(res, admitted.status, { error: admitted.error, failure: admitted.failure });
  jsonRes(res, 202, { input: admitted.input, duplicate: admitted.duplicate });
}

async function handleThreadInputLive(req, res, id, inputId) {
  const input = await getThreadInput(id, inputId);
  if (!input) return jsonRes(res, 404, { error: "input not found" });
  if (!["queued", "starting", "running", "stopping"].includes(input.state)) {
    return jsonRes(res, 409, { error: "input is already settled", input });
  }
  return handleInputLive(req, res, inputId);
}

async function gatewayJsonRequest(opts, pathname, body) {
  try {
    const response = await fetch(new URL(pathname, opts.gatewayUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text || `gateway ${response.status}` }; }
    return { status: response.status, payload };
  } catch (err) {
    return { status: 502, payload: { error: `gateway: ${err.message}` } };
  }
}

async function handleThreadInterrupt(req, res, opts, id) {
  const thread = await getThread(id);
  if (!thread) return jsonRes(res, 404, { error: "thread not found" });
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return jsonRes(res, 400, { error: `invalid json: ${err.message}` });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "generationId")) {
    return jsonRes(res, 400, { error: "only generationId is accepted" });
  }
  const generationId = typeof body.generationId === "string" ? body.generationId.trim() : "";
  if (!generationId || generationId.length > 512) return jsonRes(res, 400, { error: "valid generationId required" });
  const inputId = activeInputId(id);
  const input = inputId ? await getThreadInput(id, inputId) : null;
  if (!input || !input.generationId) {
    return jsonRes(res, 409, { error: input ? "input is still starting" : "thread has no active input" });
  }
  if (input.generationId !== generationId || !["running", "stopping"].includes(input.state)) {
    return jsonRes(res, 409, { error: "generation does not own the active input" });
  }
  const gateway = await gatewayJsonRequest(opts, "/chat/interrupt", { threadId: id, generationId });
  if (gateway.status >= 200 && gateway.status < 300) {
    const stopping = await markThreadInputStopping(id, input.inputId, generationId);
    if (stopping) publishInputLifecycle(stopping);
  }
  jsonRes(res, gateway.status, gateway.payload);
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

const PERMISSION_DECISIONS = new Set(["allow_once", "allow_always", "deny"]);

// Resolve a durable permission prompt against its live gateway callback. The URL
// supplies the thread + request binding; accepting either coordinate in the body
// would let a caller accidentally (or deliberately) answer a different prompt.
async function handleThreadPermission(req, res, opts, id, requestId) {
  const thread = await getThread(id);
  if (!thread) return jsonRes(res, 404, { error: "thread not found" });
  if (typeof requestId !== "string" || !requestId || requestId !== requestId.trim() || requestId.length > 512) {
    return jsonRes(res, 400, { error: "valid request id required" });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return jsonRes(res, 400, { error: `invalid json: ${err.message}` });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonRes(res, 400, { error: "permission decision body must be an object" });
  }
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "decision" || keys[1] !== "generationId") {
    return jsonRes(res, 400, { error: "only generationId and decision are accepted" });
  }
  const generationId = typeof body.generationId === "string" ? body.generationId : "";
  if (!generationId || generationId !== generationId.trim() || generationId.length > 512) {
    return jsonRes(res, 400, { error: "valid generationId required" });
  }
  if (typeof body.decision !== "string" || !PERMISSION_DECISIONS.has(body.decision)) {
    return jsonRes(res, 400, { error: "decision must be allow_once, allow_always, or deny" });
  }
  return postGatewayJson(res, opts, "/chat/permission", {
    threadId: id,
    generationId,
    requestId,
    decision: body.decision,
  });
}

async function handleThreadDelete(res, id) {
  if (await threadHasPendingInputs(id)) return jsonRes(res, 409, { ok: false, error: "thread has pending inputs" });
  const ok = await deleteThread(id);
  jsonRes(res, ok ? 200 : 404, { ok });
}

async function handleThreadRename(req, res, id) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return jsonRes(res, 400, { error: `invalid json: ${err.message}` }); }
  const thread = await renameThread(id, body?.title);
  if (!thread) return jsonRes(res, 404, { error: "thread not found or empty title" });
  jsonRes(res, 200, { thread });
}

// Route /api/threads, /api/threads/:id, /api/threads/:id/live and mutations.
// Returns true
// when it handled the request.
function routeThreads(req, res, pathname, method, opts, log = console) {
  if (pathname === "/api/threads" && method === "GET") { settle(res, handleThreadsList(res), log); return true; }
  if (pathname === "/api/threads" && method === "POST") { settle(res, handleThreadCreate(req, res), log); return true; }
  if (pathname.startsWith("/api/threads/")) {
    const parts = pathname.slice("/api/threads/".length).split("/").filter(Boolean).map((p) => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
    const id = parts[0];
    if (id && parts.length === 1 && method === "GET") { settle(res, handleThreadGet(res, id), log); return true; }
    if (id && parts.length === 1 && method === "DELETE") { settle(res, handleThreadDelete(res, id), log); return true; }
    if (id && parts.length === 1 && method === "PATCH") { settle(res, handleThreadRename(req, res, id), log); return true; }
    if (id && parts.length === 2 && parts[1] === "live" && method === "GET") { handleThreadLive(req, res, id); return true; }
    if (id && parts.length === 2 && parts[1] === "inputs" && method === "GET") { settle(res, handleThreadInputsGet(res, id), log); return true; }
    if (id && parts.length === 2 && parts[1] === "inputs" && method === "POST") { settle(res, handleThreadInputCreate(req, res, opts, id), log); return true; }
    if (id && parts.length === 2 && parts[1] === "interrupt" && method === "POST") { settle(res, handleThreadInterrupt(req, res, opts, id), log); return true; }
    if (id && parts.length === 4 && parts[1] === "inputs" && parts[2] && parts[3] === "live" && method === "GET") {
      void handleThreadInputLive(req, res, id, parts[2]);
      return true;
    }
    if (id && parts.length === 2 && parts[1] === "messages" && method === "POST") { settle(res, handleThreadAppend(req, res, id), log); return true; }
    if (id && parts.length === 2 && parts[1] === "routing" && method === "GET") { settle(res, handleThreadRoutingGet(res, id), log); return true; }
    if (id && parts.length === 2 && parts[1] === "routing" && method === "PUT") { settle(res, handleThreadRoutingPut(req, res, id), log); return true; }
    if (id && parts.length === 3 && parts[1] === "permissions" && parts[2] && method === "POST") {
      void handleThreadPermission(req, res, opts, id, parts[2]);
      return true;
    }
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
export async function findTranscriptBySession(sessionId) {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const root = claudeProjectsRoot();
  let dirs = [];
  try { dirs = await readdir(root); } catch { return null; }
  let match = null;
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    if (!existsSync(candidate)) continue;
    // A copied journal with the same session id in another project directory is
    // ambiguous evidence. Refuse the recovery overlay instead of trusting
    // filesystem enumeration order; the durable Web event stream remains usable.
    if (match) return null;
    match = candidate;
  }
  return match;
}

const SESSION_RECOVERY_CACHE_CAP = 64;
const sessionRecoveryCache = new Map();

async function recoveredSessionFile(sessionId, transcriptPath) {
  let signature;
  try {
    const stat = statSync(transcriptPath);
    signature = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return [];
  }
  const cached = sessionRecoveryCache.get(transcriptPath);
  if (cached?.signature === signature) {
    sessionRecoveryCache.delete(transcriptPath);
    sessionRecoveryCache.set(transcriptPath, cached);
    return cached.events;
  }
  const { lines } = await readJsonlLines(transcriptPath, 0);
  const events = recoverTranscriptSessionEvents(lines, {
    sessionId,
    streamUrlFor: (task) => relatedTaskStreamUrl(transcriptPath, sessionId, task),
  });
  sessionRecoveryCache.delete(transcriptPath);
  sessionRecoveryCache.set(transcriptPath, { signature, events });
  while (sessionRecoveryCache.size > SESSION_RECOVERY_CACHE_CAP) {
    sessionRecoveryCache.delete(sessionRecoveryCache.keys().next().value);
  }
  return events;
}

export function bindRecoveredEventsToThread(thread, recovered) {
  const events = Array.isArray(recovered) ? recovered : [];
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const inputCoordinates = new Map();
  for (const input of [
    ...(Array.isArray(thread?.inputReceipts) ? thread.inputReceipts : []),
    ...(Array.isArray(thread?.pendingInputs) ? thread.pendingInputs : []),
  ]) {
    if (typeof input?.inputId !== "string" || !input.inputId) continue;
    const started = Date.parse(input.startedAt ?? "");
    const settled = Date.parse(input.settledAt ?? "");
    inputCoordinates.set(input.inputId, {
      start: Number.isFinite(started) ? started : null,
      end: Number.isFinite(settled) ? settled : null,
    });
  }
  const assistantEnds = new Map();
  for (const message of messages) {
    if (message?.role !== "assistant" || typeof message.turnId !== "string" || !message.turnId) continue;
    const at = Date.parse(message.ts ?? "");
    if (!Number.isFinite(at)) continue;
    assistantEnds.set(message.turnId, Math.max(assistantEnds.get(message.turnId) ?? -Infinity, at));
  }
  const turns = messages
    .filter((message) => message?.role === "user" && typeof message.turnId === "string" && message.turnId)
    .map((message, index) => {
      const coordinates = inputCoordinates.get(message.turnId);
      const messageAt = Date.parse(message.ts ?? "");
      return {
        turnId: message.turnId,
        start: coordinates?.start ?? (Number.isFinite(messageAt) ? messageAt : null),
        end: coordinates?.end ?? assistantEnds.get(message.turnId) ?? null,
        index,
      };
    });
  if (turns.length === 0) return events;

  // Admission time can predate the prior turn's completion for a queued input
  // in older M4 stores. Conversation order is authoritative: a successor's
  // effective interval cannot begin before the preceding turn ended.
  let previousEnd = null;
  for (const turn of turns) {
    if (previousEnd !== null && (turn.start === null || turn.start < previousEnd)) turn.start = previousEnd;
    if (turn.end !== null) previousEnd = previousEnd === null ? turn.end : Math.max(previousEnd, turn.end);
  }

  // Bind a recovered conversational turn as a unit. Mapping individual rows can
  // split a late-flushed result from its original tool when another Web input was
  // queued meanwhile; the transcript's synthetic turn id is the stable grouping
  // evidence even when the SDK rolls sessions during one Web turn.
  const groups = [];
  const byRecoveredTurn = new Map();
  events.forEach((event, index) => {
    const key = event?.turnId == null ? `event:${index}` : String(event.turnId);
    let group = byRecoveredTurn.get(key);
    if (!group) {
      group = { key, events: [], firstIndex: index, times: [] };
      byRecoveredTurn.set(key, group);
      groups.push(group);
    }
    group.events.push(event);
    if (typeof event?.ts === "number" && Number.isFinite(event.ts)) group.times.push(event.ts);
  });

  let fallbackCursor = 0;
  const owners = new Map();
  const knownStarts = turns.map((turn) => turn.start).filter((value) => value !== null);
  const earliestKnownStart = knownStarts.length ? Math.min(...knownStarts) : null;
  for (const group of groups) {
    const first = group.times.length ? Math.min(...group.times) : null;
    const last = group.times.length ? Math.max(...group.times) : null;
    let owner = null;
    let preserveSyntheticOwner = false;
    if (first !== null && last !== null) {
      if (earliestKnownStart !== null && last < earliestKnownStart) {
        // A migrated thread may have historical unkeyed exchanges before its
        // first generated input. No future input may claim that older journal;
        // retaining the transcript's synthetic coordinate is safer and lets the
        // standalone viewer keep the legacy turn separate.
        preserveSyntheticOwner = true;
      } else {
        const containing = turns.filter((turn) =>
          (turn.start === null || turn.start <= first) && (turn.end === null || last <= turn.end)
        );
        // Adjacent turns can settle/start in the same millisecond. For a singleton
        // event exactly on that shared edge, the latest-start interval owns it;
        // a multi-event group beginning before the edge still remains with A.
        owner = containing.at(-1) ?? null;
        if (!owner) {
          const before = turns.filter((turn) => turn.start !== null && turn.start <= first);
          owner = before.at(-1) ?? turns.reduce((closest, turn) => {
            if (turn.start === null) return closest;
            if (!closest || Math.abs(turn.start - first) < Math.abs(closest.start - first)) return turn;
            return closest;
          }, null);
        }
      }
    }
    if (!owner && !preserveSyntheticOwner) owner = turns[Math.min(fallbackCursor, turns.length - 1)];
    owners.set(group.key, owner);
    fallbackCursor = Math.min(fallbackCursor + 1, turns.length - 1);
  }
  return events.map((event, index) => {
    const key = event?.turnId == null ? `event:${index}` : String(event.turnId);
    const owner = owners.get(key);
    return owner ? { ...event, turnId: owner.turnId } : event;
  });
}

/** Join every durable SDK journal named by a Web thread with the low-latency
 * canonical event store. JSONL is recovery evidence, not a second authority: the
 * reconciler only fills absent rows or strict partial snapshots and retains typed
 * terminal/control events from the Web journal. */
export async function recoverThreadSessionJournal(thread) {
  const sessionIds = Array.isArray(thread?.sessionIds) ? thread.sessionIds : [];
  const sources = [];
  for (let ordinal = 0; ordinal < sessionIds.length; ordinal += 1) {
    const sessionId = sessionIds[ordinal];
    const transcriptPath = await findTranscriptBySession(sessionId);
    if (!transcriptPath) continue;
    sources.push({ sessionId, transcriptPath, ordinal });
  }
  // Touch cache residents before loading misses. With a journal chain one entry
  // larger than the bounded cache, naïvely walking oldest-first evicts the next
  // resident on every iteration and rereads the entire chain each poll.
  sources.sort((left, right) =>
    Number(sessionRecoveryCache.has(right.transcriptPath)) - Number(sessionRecoveryCache.has(left.transcriptPath))
  );
  const recoveredByOrdinal = new Map();
  for (const { sessionId, transcriptPath, ordinal } of sources) {
    try {
      recoveredByOrdinal.set(ordinal, await recoveredSessionFile(sessionId, transcriptPath));
    } catch {
      // A journal can be mid-rename/write or temporarily unavailable. The durable
      // Web event store remains sufficient; a later hydration retries recovery.
    }
  }
  // Cache traversal is a performance detail. Equal-timestamp events retain the
  // append-only sessionIds order on every hydration, independent of which one
  // happened to be resident in the bounded LRU this poll.
  const recovered = [...recoveredByOrdinal.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, events]) => events);
  return reconcileTranscriptSessionEvents(
    thread?.sessionEvents ?? [],
    bindRecoveredEventsToThread(thread, recovered)
  );
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

export function threadSessionJournalIsLive(thread, pendingInputs) {
  const pending = Array.isArray(pendingInputs) ? pendingInputs : [];
  if (pending.some((input) => input?.state !== "queued")) return true;
  if (pending.length === 0) return false;
  const recoveryBlocks = Array.isArray(thread?.inputRecoveryBlocks) ? thread.inputRecoveryBlocks : [];
  return recoveryBlocks.length === 0;
}

async function handleThreadSessionStream(req, res, threadId) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const emit = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
  const readSnapshot = async () => {
    const snapshot = await getThreadSnapshot(threadId);
    if (!snapshot) return null;
    return {
      title: snapshot.thread.title || "Activity",
      events: await recoverThreadSessionJournal(snapshot.thread),
      // A normal queued successor is schedulable and must keep the stream across
      // the tiny settle(A) -> claim(B) handoff. A restart-parked queue is different:
      // its durable ownership marker proves there is intentionally no producer.
      live: threadSessionJournalIsLive(snapshot.thread, snapshot.pendingInputs),
    };
  };
  const first = await readSnapshot();
  if (!first) {
    emit({ type: "init", available: false, live: false, events: [] });
    emit({ type: "end" });
    return res.end();
  }
  const available = first.live || first.events.length > 0;
  emit({ type: "init", available, live: first.live, title: first.title, events: first.events });
  if (!first.live) {
    emit({ type: "end" });
    return res.end();
  }

  let snapshotSignature = JSON.stringify(first.events);
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(keep);
    clearInterval(poll);
  };
  const keep = setInterval(() => {
    if (!closed) { try { res.write(": keep-alive\n\n"); } catch { stop(); } }
  }, 15_000);
  let polling = false;
  const poll = setInterval(async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const next = await readSnapshot();
      if (closed) return;
      if (!next) {
        emit({ type: "end" });
        stop();
        return res.end();
      }
      const nextSignature = JSON.stringify(next.events);
      if (nextSignature !== snapshotSignature) {
        snapshotSignature = nextSignature;
        // Reconciliation can discover an older JSONL row after a newer durable
        // row was already painted. A delta cannot express insertion/removal
        // order, so this thread-level stream sends the complete authoritative
        // array and the shared client replaces its local snapshot exactly.
        emit({ type: "snapshot", title: next.title, events: next.events });
      }
      if (!next.live) {
        emit({ type: "end" });
        stop();
        res.end();
      }
    } catch {
      // JSONL and thread writes are independently atomic. A transient read miss
      // is retried on the next poll; it must not turn a live journal unavailable.
    } finally {
      polling = false;
    }
  }, 800);
  req.on("close", stop);
  res.on("close", stop);
}

// SSE stream of a thread's (or an explicit session's) Claude transcript: the
// structured blocks (text / collapsible thinking / tool calls / inline images)
// the plain-text chat stream drops. Tails live; the client closes it.
async function handleSessionStream(req, res) {
  const parsed = url.parse(req.url || "", true);
  const threadId = typeof parsed.query.thread === "string" ? parsed.query.thread : null;
  let sessionId = typeof parsed.query.session === "string" ? parsed.query.session : null;
  const publicTaskId = typeof parsed.query.task === "string" ? parsed.query.task : null;
  if (threadId && !sessionId && !publicTaskId) {
    return handleThreadSessionStream(req, res, threadId);
  }
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

export function serveStatic(req, res, distDir) {
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

// Handlers run detached from the router's return (a live stream never ends), so
// a rejection must land on the response instead of the process: an unhandled
// rejection would take the whole host down, and on the shell host that is Next.
function settle(res, pending, log) {
  Promise.resolve(pending).catch((err) => {
    log.error("[talk] handler failed:", err);
    try {
      if (!res.headersSent && !res.writableEnded) jsonRes(res, 500, { error: String(err?.message ?? err) });
      else if (!res.writableEnded) res.end();
    } catch {}
  });
}

// The one entry point both hosts use. Returns true when the request was
// answered here, false when it is not ours (a page path on the shell host).
// `liveOpts.voice` ({fittingId(), token(), tokenReason?(), vaultLocked?()}) is how the host
// names the voice provider and hands over the capture token; without it every
// /api/voice/* answer is "no voice provider".
export function createTalkRouter(liveOpts, { distDir = null, log = console } = {}) {
  return async function handleTalkRequest(req, res) {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health" || pathname === "/api/health") { settle(res, handleHealth(req, res, liveOpts), log); return true; }
      // Host-aware URL/file rendering + rich transcript (issues #1/#3/#4). Root
      // paths (not /api/*) so they inherit this origin's tailscale serve mapping.
      if (pathname === "/api/push/key" && method === "GET") { settle(res, handlePushKey(res), log); return true; }
      if (pathname === "/api/push/subscribe" && method === "POST") { settle(res, handlePushSubscribe(req, res), log); return true; }
      if (pathname === "/api/push/subscribe" && method === "DELETE") { settle(res, handlePushUnsubscribe(req, res), log); return true; }
      if ((pathname === "/notify" || pathname === "/api/notify") && method === "POST") { settle(res, handleNotify(req, res, liveOpts), log); return true; }
      if ((pathname === "/host-map" || pathname === "/api/host-map") && method === "GET") { settle(res, handleHostMap(res), log); return true; }
      if ((pathname === "/file" || pathname === "/api/file") && method === "GET") { settle(res, handleFile(req, res), log); return true; }
      if (pathname === "/api/session-stream" && method === "GET") { settle(res, handleSessionStream(req, res), log); return true; }
      // Presence heartbeat relay (GARRISON-UNIFY-V1 S14, D34): the UI POSTs
      // same-origin; relay to the Power fitting via its status file. Power
      // absent → 204 silently (advisory).
      if ((pathname === "/power-heartbeat" || pathname === "/api/power-heartbeat") && method === "POST") {
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
        res.end();
        return true;
      }
      if (pathname.startsWith("/api/remote-shell/")) {
        settle(res, handleRemoteShellProxy(req, res, pathname.slice("/api/remote-shell".length), parsed.search?.slice(1) ?? ""), log); return true;
      }
      if (pathname === "/api/voice/health" && method === "GET") { settle(res, handleVoiceHealth(res, liveOpts.voice), log); return true; }
      if (pathname === "/api/voice" && method === "GET") { settle(res, handleVoiceInfo(res, liveOpts.voice), log); return true; }
      if (pathname === "/api/voice/stt" && method === "POST") { settle(res, handleVoiceProxy(req, res, "/stt", liveOpts.voice), log); return true; }
      if (pathname === "/api/voice/tts" && method === "POST") { settle(res, handleVoiceProxy(req, res, "/tts", liveOpts.voice), log); return true; }
      // The page is about to speak an answer (D56): the voice layer's echo guard
      // learns the text so a live broadcast mic does not transcribe it back.
      if (pathname === "/api/voice/spoken" && method === "POST") { settle(res, handleVoiceProxy(req, res, "/spoken", liveOpts.voice), log); return true; }
      {
        const m = method === "GET" ? /^\/api\/voice\/sessions\/([^/]+)\/events$/.exec(pathname) : null;
        if (m) { settle(res, handleVoiceSessionEvents(req, res, decodeURIComponent(m[1]), liveOpts.voice), log); return true; }
      }
      if (pathname === "/api/stream" && method === "GET") { settle(res, handleStream(req, res, liveOpts), log); return true; }
      if (pathname === "/api/chat/answer" && method === "POST") { settle(res, handleChatAnswer(req, res, liveOpts), log); return true; }
      if (pathname === "/api/chat/interrupt" && method === "POST") { settle(res, handleChatInterrupt(req, res, liveOpts), log); return true; }
      if (pathname === "/api/chat" && method === "POST") { settle(res, handleChat(req, res, liveOpts), log); return true; }
      if (pathname === "/api/route-options" && method === "GET") { settle(res, handleRouteOptions(req, res, liveOpts), log); return true; }
      if (pathname === "/api/sidebar" && method === "GET") {
        void loadSidebar()
          .then((body) => jsonRes(res, 200, body))
          .catch(() => jsonRes(res, 200, { groups: [], membership: {}, order: {}, read: {}, archived: [] }));
        return true;
      }
      if (pathname === "/api/sidebar" && method === "PUT") {
        void readJsonBody(req)
          .then((body) => saveSidebar(body))
          .then((clean) => jsonRes(res, 200, clean))
          .catch((err) => jsonRes(res, 400, { error: String(err?.message ?? err) }));
        return true;
      }
      if (pathname === "/api/mesh-threads" && method === "GET") {
        // Other nodes' conversations, from the state service's per-node thread
        // indexes. Empty on an unenrolled box; never an error surface.
        void meshThreads()
          .then((body) => jsonRes(res, 200, body))
          .catch(() => jsonRes(res, 200, { nodes: [] }));
        return true;
      }
      if (pathname === "/api/brief" && method === "GET") { settle(res, handleBriefGet(res, parsed.query.path), log); return true; }
      if (pathname === "/api/brief" && method === "PUT") { settle(res, handleBriefPut(req, res), log); return true; }
      if (pathname.startsWith("/api/threads") && routeThreads(req, res, pathname, method, liveOpts, log)) return true;
      if (pathname === "/api/claude/stream" && method === "GET") { settle(res, handleClaudeStream(req, res, liveOpts), log); return true; }
      if (pathname === "/api/claude/status" && method === "GET") { settle(res, handleClaudeProxy(req, res, liveOpts, "status", "GET"), log); return true; }
      if (pathname === "/api/claude/commands" && method === "GET") { settle(res, handleClaudeProxy(req, res, liveOpts, "commands", "GET"), log); return true; }
      if (pathname === "/api/claude/message" && method === "POST") { settle(res, handleClaudeProxy(req, res, liveOpts, "message", "POST"), log); return true; }
      if (pathname === "/api/claude/keys" && method === "POST") { settle(res, handleClaudeProxy(req, res, liveOpts, "keys", "POST"), log); return true; }
      if (pathname === "/api/claude/mode" && method === "POST") { settle(res, handleClaudeProxy(req, res, liveOpts, "mode", "POST"), log); return true; }
      if (pathname === "/api/claude/interrupt" && method === "POST") { settle(res, handleClaudeProxy(req, res, liveOpts, "interrupt", "POST"), log); return true; }
      if (pathname === "/api/claude/answer" && method === "POST") { settle(res, handleClaudeProxy(req, res, liveOpts, "answer", "POST"), log); return true; }
      if (pathname === "/api/attachments" && method === "POST") { settle(res, handleAttachments(req, res, liveOpts), log); return true; }
      // The conversation router (Conversations plan, C1). Mounted at the SAME
      // relative base here, on the kanban board and in the Next app, because a
      // conversation view only ever builds relative URLs - the browser is almost
      // never on this box.
      if (pathname.startsWith("/api/conversation")) {
        void handleConversationRequest(req, res, {
          // Who appended, in the ledger: the fitting host says web-channel,
          // the shell names itself.
          role: liveOpts.conversationRole ?? "web-channel",
          forwardMessage: gatewayMessageForwarder(liveOpts.gatewayUrl),
          // Tighter than the router's default because THIS mount is the one a
          // person types into: the composer's receipt is terminal on admission
          // (a message has no generation to follow), so the stream's echo of
          // their own message is the only thing that says it landed. The poll
          // itself is a stat of one file and re-parses only when it grew.
          pollMs: 300,
        }).catch((err) => jsonRes(res, 500, { error: String(err?.message ?? err) }));
        return true;
      }
      if (pathname.startsWith("/api/")) {
        jsonRes(res, 404, { error: "not found", path: pathname });
        return true;
      }
      // Anything else is the host's page surface: the fitting host serves its
      // static bundle, the shell host lets Next render (/talk is a shell route).
      if (distDir) {
        serveStatic(req, res, distDir);
        return true;
      }
      return false;
    } catch (err) {
      log.error("[talk] handler error:", err);
      jsonRes(res, 500, { error: err.message });
      return true;
    }
  };
}

// Startup ownership reconciliation, shared by both hosts: the durable inputs the
// previous process left in starting/running/stopping are settled before the
// first request, and the queued tail gets its live streams back.
export async function initTalkRuntime() {
  const startupInputs = await reconcileInterruptedThreadInputs();
  for (const entry of startupInputs) {
    for (const input of entry.failedInputs) {
      if (input?.inputId) finishInputLive(entry.threadId, input.inputId, "process-restart");
    }
    for (const input of entry.queuedInputs) {
      startInputLive(input.inputId, input.acceptedAt);
      publishInputLifecycle(input);
    }
  }
  return startupInputs;
}

// Second half of startup: once the host can serve, hand the recovered inputs
// back to the gateway and resume their workers as each one clears.
export function recoverStartupInputs(startupInputs, liveOpts, { signal, log = console } = {}) {
  return reconcileStartupInputOwnership(startupInputs, liveOpts, {
    signal,
    onCleared: (threadId) => scheduleThreadInputs(threadId, liveOpts),
  }).catch((err) => {
    if (!signal?.aborted) log.error(`[talk] startup input recovery worker failed: ${err.message}`);
  });
}

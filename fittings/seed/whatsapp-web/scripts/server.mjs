#!/usr/bin/env node
// whatsapp-web backend — personal WhatsApp channel (channels role, own-port).
//
// A Node own-port daemon that holds the persistent Baileys (WhatsApp Web
// protocol) session, a local message store, and a small internal HTTP API
// (loopback only) that the stateless connector.mjs CLI talks to. This file is
// deliberately split into two halves:
//
//   - a real Baileys ConnectionManager (buildConnectionManager / startServer),
//     which is the only place that ever touches the actual WhatsApp socket;
//   - a pure HTTP layer (createApp) that only depends on the ConnectionManager
//     INTERFACE ({ status, connect, requestPairingCode, sendText }), so tests
//     can exercise the whole HTTP contract — including the send-pacing queue,
//     the store, and contact resolution — against a fake connection manager
//     without ever importing @whiskeysockets/baileys or opening a socket.
//
// Pairing is code-based (the brief: the host is headless, over SSH — no QR).
// The daemon NEVER auto-connects to WhatsApp unless a session already exists
// on disk (creds.json under session_dir/auth) OR a human explicitly requests
// a pairing code via POST /pair (see scripts/pair.mjs + instructions.md).
// Nothing in this Fitting calls /pair on its own.
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { ContactIndex } from "../lib/contacts.mjs";
import { assertValidJid, isValidJid } from "../lib/jid.mjs";
import { Outbox } from "../lib/outbox.mjs";
import { SendQueue } from "../lib/pacing.mjs";
import { MessageStore } from "../lib/store.mjs";

// Mirrors garrisonDir() in src/lib/claude-home.ts.
function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

const STATUS_ROOT = path.join(garrisonDir(), "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "whatsapp-web.json");
const FITTING_ID = "whatsapp-web";
// Parked outbound sends waiting out their cancel window. Beside the status
// file, not inside session_dir: it is Garrison state, not WhatsApp state, and
// it must survive a re-pair.
const OUTBOX_FILE = path.join(garrisonDir(), FITTING_ID, "outbox.json");

// Composition config arrives NAMESPACED: GARRISON_<ID>_<KEY> (see
// ownPortConfigEnv in src/lib/own-port-lifecycle.ts). whatsapp-web + `port` ->
// GARRISON_WHATSAPPWEB_PORT.
const cfg = (key) => process.env[`GARRISON_WHATSAPPWEB_${key}`];

function expandTilde(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function parseArgs(argv = []) {
  const out = {
    port: Number(cfg("PORT") || 7080),
    host: cfg("BIND_HOST") || "127.0.0.1",
    sessionDir: expandTilde(cfg("SESSION_DIR") || path.join(os.homedir(), ".config", "garrison", "whatsapp-web")),
    // Canonical own-port convention (see web-channel-default): the runner
    // always injects GARRISON_GATEWAY_URL / _HOST / _PORT for own-port
    // Fittings; a bare fallback covers a hand-run process.
    gatewayUrl:
      process.env.GARRISON_GATEWAY_URL ||
      `http://${process.env.GARRISON_GATEWAY_HOST || "127.0.0.1"}:${process.env.GARRISON_GATEWAY_PORT || "4777"}`,
    minSendDelayMs: Number(cfg("MIN_SEND_DELAY_MS") || 1200),
    maxSendDelayMs: Number(cfg("MAX_SEND_DELAY_MS") || 3500)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--session-dir") out.sessionDir = argv[++i];
    else if (a === "--gateway-url") out.gatewayUrl = argv[++i];
  }
  return out;
}

export function isLoopbackAddr(addr) {
  if (!addr) return false;
  return addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Tiny status + pairing page, no build step: polls /health and renders
// paired/connected/phone so the user can see the connection state from a
// browser tab (the sidebar's own-port "Views" link embeds this at the
// daemon's root) instead of needing a terminal. While not paired it also
// offers a phone-number + pairing-code form over the existing POST /pair
// route — the only mutation this page can ever trigger. There is
// deliberately no send_text control anywhere on this page: sending stays
// reachable only via connector.mjs in a live conversation with the
// Operative, never from this UI and never from an automation.
const STATUS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>whatsapp-web</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 16px; opacity: .7; }
  .rows { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; max-width: 360px; }
  .k { opacity: .6; }
  .v { font-variant-numeric: tabular-nums; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot-ok { background: #2ea043; }
  .dot-warn { background: #d4a72c; }
  .dot-off { background: #8b949e; }
  .err { color: #d4a72c; margin-top: 16px; font-size: 12px; }
  .pair { margin-top: 24px; max-width: 360px; }
  .pair.hidden { display: none; }
  .pair h2 { font-size: 13px; font-weight: 600; margin: 0 0 10px; opacity: .7; }
  .pair ol { margin: 12px 0 0; padding-left: 18px; opacity: .85; }
  .pair ol li { margin: 4px 0; }
  .pair input { font: inherit; padding: 6px 8px; width: 100%; box-sizing: border-box; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Canvas; color: CanvasText; }
  .pair button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Canvas; color: CanvasText; cursor: pointer; margin-top: 8px; }
  .pair button:disabled { opacity: .5; cursor: default; }
  .pair-code { font-size: 22px; font-weight: 700; letter-spacing: .08em; margin: 10px 0; font-variant-numeric: tabular-nums; }
  .pair-msg { font-size: 12px; opacity: .75; margin-top: 8px; min-height: 1.2em; }
  .pair-expiry { font-size: 12px; opacity: .6; }
  .qr { margin-top: 20px; padding-top: 16px; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  .qr button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Canvas; color: CanvasText; cursor: pointer; }
  .qr button:disabled { opacity: .5; cursor: default; }
  .qr img { display: block; margin: 12px 0; background: #fff; padding: 8px; border-radius: 8px; }
  .qr ol { margin: 8px 0 0; padding-left: 18px; opacity: .85; }
  .qr ol li { margin: 4px 0; }
</style>
</head>
<body>
<h1>whatsapp-web — connection status</h1>
<div class="rows" id="rows">Loading…</div>
<div class="err" id="err" hidden></div>

<div class="pair hidden" id="pair">
  <h2>Pair this account</h2>
  <div id="pairForm">
    <input id="phone" type="tel" placeholder="+351912345678" autocomplete="tel" />
    <button id="pairBtn" type="button">Pair</button>
    <div class="pair-msg" id="pairMsg"></div>
  </div>
  <div id="pairResult" hidden>
    <div class="pair-code" id="pairCode"></div>
    <div class="pair-expiry" id="pairExpiry"></div>
    <ol>
      <li>Open <b>WhatsApp</b> on your phone -> Settings (or the three-dot menu) -> <b>Linked Devices</b>.</li>
      <li>Tap <b>Link a Device</b>.</li>
      <li>Tap <b>Link with phone number instead</b>.</li>
      <li>Enter the code above. It expires in about 60 seconds.</li>
    </ol>
    <button id="retryBtn" type="button">Request a new code</button>
  </div>

  <div class="qr" id="qrBlock">
    <button id="qrBtn" type="button">Pair with a QR code instead</button>
    <div id="qrBox" hidden>
      <img id="qrImg" width="260" height="260" alt="WhatsApp pairing QR code" />
      <ol>
        <li>Open <b>WhatsApp</b> on your phone -> <b>Linked Devices</b>.</li>
        <li>Tap <b>Link a Device</b> and point the camera at the code above.</li>
        <li>It refreshes by itself every few seconds - no need to press anything.</li>
      </ol>
    </div>
  </div>
</div>

<script>
var lastPhone = "";

async function tick() {
  const rowsEl = document.getElementById("rows");
  const errEl = document.getElementById("err");
  const pairEl = document.getElementById("pair");
  try {
    const res = await fetch("/health", { cache: "no-store" });
    const s = await res.json();
    errEl.hidden = true;
    const dot = s.connected ? "dot-ok" : (s.connecting ? "dot-warn" : "dot-off");
    const state = s.connected ? "connected" : (s.connecting ? "connecting…" : (s.paired ? "paired, not connected" : "not paired"));
    rowsEl.innerHTML =
      '<span class="k">status</span><span class="v"><span class="dot ' + dot + '"></span>' + state + '</span>' +
      '<span class="k">paired</span><span class="v">' + Boolean(s.paired) + '</span>' +
      '<span class="k">connected</span><span class="v">' + Boolean(s.connected) + '</span>' +
      '<span class="k">phone</span><span class="v">' + (s.phone || '—') + '</span>' +
      '<span class="k">port</span><span class="v">' + s.port + '</span>' +
      '<span class="k">pid</span><span class="v">' + s.pid + '</span>' +
      (s.lastDisconnect
        ? '<span class="k">last close</span><span class="v">' +
          (s.lastDisconnect.statusCode || '?') + ' ' +
          (s.lastDisconnect.message || '') +
          (s.lastDisconnect.reason ? ' ' + s.lastDisconnect.reason : '') +
          '</span>'
        : '');
    pairEl.classList.toggle("hidden", Boolean(s.paired));
  } catch (e) {
    errEl.hidden = false;
    errEl.textContent = "Can't reach the daemon: " + e.message;
  }
}

async function requestCode() {
  const phoneEl = document.getElementById("phone");
  const btn = document.getElementById("pairBtn");
  const msgEl = document.getElementById("pairMsg");
  const phone = (lastPhone = phoneEl.value.trim());
  if (!phone) {
    msgEl.textContent = "Enter a phone number first.";
    return;
  }
  btn.disabled = true;
  msgEl.textContent = "Requesting a code…";
  try {
    const res = await fetch("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: phone })
    });
    const json = await res.json();
    if (!res.ok || !json.code) {
      msgEl.textContent = "Error: " + (json.error || res.status);
      return;
    }
    document.getElementById("pairForm").hidden = true;
    document.getElementById("pairResult").hidden = false;
    document.getElementById("pairCode").textContent = json.code;
    document.getElementById("pairExpiry").textContent = "Expires in ~60s — request a new one below if it lapses.";
  } catch (e) {
    msgEl.textContent = "Request failed: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

var qrTimer = null;

async function startQr() {
  const btn = document.getElementById("qrBtn");
  const msgEl = document.getElementById("pairMsg");
  btn.disabled = true;
  try {
    const res = await fetch("/pair/qr", { method: "POST" });
    const json = await res.json();
    if (!res.ok) {
      msgEl.textContent = "QR error: " + (json.error || res.status);
      return;
    }
    document.getElementById("qrBox").hidden = false;
    refreshQr();
    if (!qrTimer) qrTimer = setInterval(refreshQr, 5000);
  } catch (e) {
    msgEl.textContent = "QR request failed: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

function refreshQr() {
  document.getElementById("qrImg").src = "/qr?t=" + Date.now();
}

document.getElementById("qrBtn").addEventListener("click", startQr);
document.getElementById("pairBtn").addEventListener("click", requestCode);
document.getElementById("retryBtn").addEventListener("click", function () {
  document.getElementById("pairForm").hidden = false;
  document.getElementById("pairResult").hidden = true;
  document.getElementById("phone").value = lastPhone;
});

tick();
setInterval(tick, 3000);
</script>
</body>
</html>
`;

// Rendered server-side so the status page stays dependency-free and works
// inside the Garrison iframe, where an external script would be blocked.
async function renderQrSvg(text) {
  const { default: QRCode } = await import("qrcode");
  return QRCode.toString(text, {
    type: "svg",
    margin: 1,
    width: 320,
    errorCorrectionLevel: "L"
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 200_000) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function extractMessageText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

function maskJid(jid) {
  if (typeof jid !== "string") return null;
  const at = jid.indexOf("@");
  if (at <= 2) return jid;
  return `${jid.slice(0, 2)}***${jid.slice(at)}`;
}

// Baileys hangs the raw stream:error node off error.data. It is usually a
// small node whose attrs carry the real code (403 with a device_removed
// type, 405 for a refused client, and so on). Flatten just enough of it to
// be readable on one log line, and never throw while doing so.
function describeDisconnectData(data) {
  if (!data) return null;
  try {
    if (typeof data === "string") return data.slice(0, 200);
    const attrs = data.attrs ?? data.content?.[0]?.attrs ?? null;
    if (attrs) return JSON.stringify(attrs).slice(0, 200);
    return JSON.stringify(data).slice(0, 200);
  } catch {
    return null;
  }
}

// A tiny in-process pub/sub for message activity. The own-port daemon publishes
// one event per stored WhatsApp message (inbound AND outbound); SSE subscribers
// on GET /events receive them live. Deliberately minimal — no history, no
// replay: a late subscriber only sees messages from the moment it connects,
// which is exactly what a "a message just landed" HUD pulse wants (a replay
// would re-fire the animation for every old message on every reconnect).
export function createMessageBus() {
  const subscribers = new Set();
  return {
    publish(event) {
      for (const fn of subscribers) {
        // One misbehaving subscriber must never block delivery to the rest,
        // nor bubble out into the Baileys event handler that called publish().
        try { fn(event); } catch { /* ignore */ }
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    get size() { return subscribers.size; }
  };
}

// proto.WebMessageInfo.Status: ERROR 0, PENDING 1, SERVER_ACK 2, DELIVERY_ACK
// 3, READ 4, PLAYED 5. We fire the "sent" pulse at SERVER_ACK — the moment
// WhatsApp's own server acknowledges the message (the single grey tick), which
// is the real "it went out" confirmation. DELIVERY_ACK (3) would be stricter,
// but it depends on the RECIPIENT's phone being online and may never arrive, so
// keying on it would make the pulse silently miss perfectly successful sends.
// Bump to 3 here if the owner ever wants strict delivery instead. The event
// still carries ackStatus so the UI can distinguish later.
export const WA_SENT_ACK_STATUS = 2;

// Tracks outbound messages between the moment they're stored (messages.upsert,
// fromMe) and the moment WhatsApp acks them (messages.update). The HUD's "sent"
// pulse fires on the ack, not on the store, so a send that never leaves the
// device never claims to have been sent. Delete-before-publish in takeAcked
// gives dedupe for free: SERVER_ACK -> DELIVERY_ACK -> READ all arrive for the
// same id, but only the first finds an entry. Bounded by age and size so a
// long-lived daemon that sends to unreachable recipients can't leak the map.
export function createOutboundAckTracker({
  maxEntries = 300,
  maxAgeMs = 15 * 60_000,
  now = () => Date.now()
} = {}) {
  const pending = new Map();
  function prune() {
    const t = now();
    for (const [id, entry] of pending) {
      if (t - entry.at > maxAgeMs) pending.delete(id);
    }
    // Map preserves insertion order, so the first key is the oldest.
    while (pending.size > maxEntries) {
      pending.delete(pending.keys().next().value);
    }
  }
  return {
    trackPending(entry) {
      const id = entry?.id;
      if (!id) return;
      const { id: _id, ...payload } = entry;
      pending.set(id, { at: now(), payload });
      prune();
    },
    takeAcked(id) {
      if (!id) return null;
      const entry = pending.get(id);
      if (!entry) return null;
      pending.delete(id);
      return entry.payload;
    },
    get size() { return pending.size; }
  };
}

// Resolves a contact's profile photo URL over the live socket, with a TTL cache
// so a burst of messages from one chat hits WhatsApp once. Timeouts, missing
// photos and privacy-hidden photos all resolve to null (a short negative TTL so
// they don't hammer the API) — the UI falls back to initials. NEVER throws: a
// photo is a nice-to-have on a pulse, never a reason to drop the pulse.
export function createAvatarResolver({
  getProfilePictureUrl,
  timeoutMs = 1500,
  ttlMs = 6 * 3_600_000,
  negativeTtlMs = 10 * 60_000,
  maxEntries = 512,
  now = () => Date.now()
} = {}) {
  const cache = new Map();
  function prune() {
    while (cache.size > maxEntries) {
      cache.delete(cache.keys().next().value);
    }
  }
  async function lookup(jid) {
    if (!jid || typeof getProfilePictureUrl !== "function") return null;
    const t = now();
    const hit = cache.get(jid);
    if (hit && hit.exp > t) return hit.url;
    let url = null;
    let timer = null;
    try {
      url = await Promise.race([
        // "preview" is the small thumbnail — faster than the full "image".
        Promise.resolve().then(() => getProfilePictureUrl(jid, "preview")),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })
      ]);
    } catch {
      url = null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (typeof url !== "string" || !url) url = null;
    cache.set(jid, { url, exp: t + (url ? ttlMs : negativeTtlMs) });
    prune();
    return url;
  }
  return { lookup, get size() { return cache.size; } };
}

// No-op bus so buildConnectionManager()/createApp() stay constructible in
// isolation (the HTTP-layer tests build them without wiring a bus).
const NULL_BUS = { publish() {}, subscribe() { return () => {}; }, get size() { return 0; } };

// ---------------------------------------------------------------------------
// Connection manager — the ONLY code in this file that touches Baileys. Real
// deps are injected by startServer(); tests build a fake object satisfying
// this same interface and never import this function at all.
// ---------------------------------------------------------------------------
export function buildConnectionManager({
  sessionDir,
  gatewayUrl,
  store,
  contactIndex,
  sendQueue,
  messageBus = NULL_BUS,
  log = () => {},
  fetchImpl = fetch,
  // Injectable so a hand test COULD exercise this against a fake Baileys
  // module without a real socket — not used by the HTTP-layer tests, which
  // fake the whole ConnectionManager instead.
  baileysModuleLoader = () => import("@whiskeysockets/baileys")
}) {
  const authDir = path.join(sessionDir, "auth");
  const state = {
    sock: null,
    connecting: false,
    connected: false,
    paired: false,
    phone: null,
    // QR pairing: the current code string, held in MEMORY only (never
    // written to disk beside the creds) and dropped the moment the socket
    // opens or dies. Baileys mints a fresh one every ~20s while an unpaired
    // socket waits, so a stale one must never be served.
    qr: null,
    qrAt: null,
    // WhatsApp's own stated reason for the last close - see the close branch.
    lastDisconnect: null
  };

  // Outbound "sent" pulses fire on the ack (messages.update), not on the store
  // (messages.upsert). This bridges the two events by message id. One tracker
  // per manager so it survives socket reconnects.
  const ackTracker = createOutboundAckTracker();
  // Reads the photo off whatever socket is currently live; the cache persists
  // across reconnects, so a resync doesn't re-fetch every avatar.
  const avatars = createAvatarResolver({
    getProfilePictureUrl: (jid, kind) => state.sock?.profilePictureUrl?.(jid, kind)
  });

  function credsPath() {
    return path.join(authDir, "creds.json");
  }

  function hasSavedSession() {
    return existsSync(credsPath());
  }

  async function forwardInbound(chatJid, body) {
    if (!body) return;
    try {
      await fetchImpl(`${gatewayUrl}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: body, source: "whatsapp-web", chat: chatJid })
      });
    } catch (err) {
      log(`forward to gateway failed: ${err.message}`);
    }
  }

  function wireEvents(sock, saveCreds) {
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        state.qr = qr;
        state.qrAt = Date.now();
        log("qr refreshed");
      }
      if (connection === "open") {
        state.connected = true;
        state.connecting = false;
        state.paired = true;
        state.qr = null;
        state.qrAt = null;
        state.lastDisconnect = null;
        log("connection open");
        // Self-heal an empty address book. messaging-history.set only fires at
        // pairing, so an account paired earlier (or before this Fitting learned
        // to listen for it) would never resolve a single name. Asking for the
        // app-state collections replays contacts and chats through the
        // listeners wired above. Guarded: only when we have nothing, so a
        // healthy index never pays for a full resync.
        if (contactIndex.size === 0 && typeof sock.resyncAppState === "function") {
          log("contact index empty - requesting an app-state resync");
          Promise.resolve()
            .then(() =>
              sock.resyncAppState(
                ["critical_unblock_low", "regular_high", "regular_low", "regular"],
                true
              )
            )
            .then(() => log("app-state resync done: contact index now " + contactIndex.size + " entries"))
            .catch((err) => log("app-state resync failed: " + err.message));
        }
      } else if (connection === "connecting") {
        state.connecting = true;
      } else if (connection === "close") {
        state.connected = false;
        state.connecting = false;
        // DisconnectReason.loggedOut === 401; avoid importing the enum just
        // for this comparison so the manager stays easy to construct in
        // isolation.
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === 401;
        state.qr = null;
        state.qrAt = null;
        // Record WHY WhatsApp closed us. Without this the log only ever said
        // "Connection Failure", which reads identically for a rate-limited
        // pairing attempt, a refused client version and a real logout - the
        // exact ambiguity that made a failed pairing impossible to diagnose.
        state.lastDisconnect = {
          at: new Date().toISOString(),
          statusCode: statusCode ?? null,
          message:
            lastDisconnect?.error?.output?.payload?.message ??
            lastDisconnect?.error?.message ??
            null,
          reason: describeDisconnectData(lastDisconnect?.error?.data)
        };
        log(
          "connection closed: statusCode=" +
            (state.lastDisconnect.statusCode ?? "?") +
            " message=" +
            (state.lastDisconnect.message ?? "?") +
            " reason=" +
            (state.lastDisconnect.reason ?? "?")
        );
        if (loggedOut) {
          log("session logged out; not reconnecting");
          state.paired = false;
          state.sock = null;
        } else {
          log("reconnecting");
          connect().catch((err) => log(`reconnect failed: ${err.message}`));
        }
      }
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const m of messages || []) {
        const body = extractMessageText(m.message);
        if (!body) continue;
        const chatJid = m.key?.remoteJid;
        const fromMe = Boolean(m.key?.fromMe);
        const sender = fromMe ? "me" : m.key?.participant || chatJid;
        // Anyone who writes to you becomes resolvable by name, even if they
        // never showed up in the synced address book. pushName is the display
        // name WhatsApp attaches to the inbound message itself.
        if (!fromMe && m.pushName) {
          contactIndex.upsert(m.key?.participant || chatJid, m.pushName);
        }
        const record = {
          id: m.key?.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          chatJid,
          chatName: contactIndex.byJid.get(chatJid)?.name,
          fromMe,
          sender,
          body,
          timestamp: Number(m.messageTimestamp) ? Number(m.messageTimestamp) * 1000 : Date.now(),
          type: "text"
        };
        // Persist synchronously and BEFORE any await — storage must never wait
        // on a profile-photo lookup.
        store.append(record);
        const pulse = {
          chatJid: chatJid ?? null,
          chatName: record.chatName ?? null,
          preview: body.slice(0, 140),
          timestamp: record.timestamp
        };
        if (fromMe) {
          // Do NOT pulse yet. A stored outbound message hasn't necessarily left
          // the device; the "sent" pulse waits for WhatsApp's ack in
          // messages.update (below), keyed by this id.
          ackTracker.trackPending({ id: record.id, ...pulse });
        } else {
          // Inbound is confirmed the moment it lands: pulse "received" now,
          // enriched with the sender's avatar. The photo lookup is async, so
          // fire it detached — it must never block the event loop or delay the
          // gateway forward.
          void (async () => {
            const avatarUrl = await avatars.lookup(chatJid);
            messageBus.publish({ type: "message", direction: "in", avatarUrl, ...pulse });
          })();
          void forwardInbound(chatJid, body);
        }
      }
    });

    // Delivery acks for our own sent messages. WhatsApp reports a rising status
    // (SERVER_ACK -> DELIVERY_ACK -> READ); we fire the "sent" pulse on the
    // first that clears WA_SENT_ACK_STATUS and takeAcked() dedupes the rest.
    sock.ev.on("messages.update", (updates) => {
      for (const u of updates || []) {
        if (!u?.key?.fromMe) continue;
        // Baileys nests status under `update`; read defensively across versions.
        const status = u.update?.status ?? u.update?.update?.status;
        if (typeof status !== "number" || status < WA_SENT_ACK_STATUS) continue;
        const pulse = ackTracker.takeAcked(u.key.id);
        if (!pulse) continue; // unknown id, or already fired for an earlier ack
        void (async () => {
          const avatarUrl = await avatars.lookup(pulse.chatJid);
          messageBus.publish({ type: "message", direction: "out", avatarUrl, ackStatus: status, ...pulse });
        })();
      }
    });

    const indexContacts = (contacts) => {
      for (const c of contacts || []) {
        const name = c.name || c.notify || c.verifiedName;
        if (c.id && name) contactIndex.upsert(c.id, name);
      }
    };
    sock.ev.on("contacts.upsert", indexContacts);
    sock.ev.on("contacts.update", indexContacts);
    sock.ev.on("chats.upsert", (chats) => {
      for (const c of chats || []) {
        if (c.id && c.name) contactIndex.upsert(c.id, c.name);
      }
    });

    // THE address book source. Baileys replays the phone's contacts and chat
    // list in `messaging-history.set` batches right after pairing and on every
    // resync; contacts.upsert alone barely fires, which is why a freshly
    // paired account used to resolve nothing at all.
    sock.ev.on("messaging-history.set", (payload) => {
      const { contacts, chats } = payload || {};
      indexContacts(contacts);
      for (const c of chats || []) {
        if (c.id && (c.name || c.subject)) contactIndex.upsert(c.id, c.name || c.subject);
      }
      log("history sync: contact index now " + contactIndex.size + " entries");
    });
  }

  async function connect() {
    if (state.connecting || state.connected) return;
    state.connecting = true;
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = await baileysModuleLoader();
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: authState,
      printQRInTerminal: false,
      browser: ["Garrison", "Chrome", "1.0"]
    });
    state.sock = sock;
    state.paired = Boolean(authState.creds?.registered);
    wireEvents(sock, saveCreds);
    return sock;
  }

  return {
    // Auto-reconnect ONLY when a session already exists — never opens a
    // socket, and never requests a pairing code, on a fresh/unpaired install.
    async init() {
      if (hasSavedSession()) {
        log("saved session found; reconnecting");
        await connect();
      } else {
        log("no saved session; idle until POST /pair is called explicitly");
      }
    },

    // Explicit, human-triggered pairing. Never called automatically.
    async requestPairingCode(phoneNumber) {
      if (state.paired) {
        throw new Error("already paired — remove the session to re-pair, or just use the existing session");
      }
      const digits = String(phoneNumber || "").replace(/[^0-9]/g, "");
      if (digits.length < 8) {
        throw new Error("phoneNumber must be full international digits, e.g. 351912345678 (no +, no spaces)");
      }
      if (!state.sock) await connect();
      const code = await state.sock.requestPairingCode(digits);
      return code;
    },

    // QR pairing. Opens a socket WITHOUT asking for a pairing code, which is
    // what makes Baileys emit `qr` events at all. Deliberately a separate
    // entry point from requestPairingCode: the two are alternative first
    // steps on a fresh socket, not a sequence.
    async startQrPairing() {
      if (state.paired) {
        throw new Error("already paired - remove the session to re-pair");
      }
      if (!state.sock) await connect();
      return { started: true };
    },

    currentQr() {
      if (!state.qr) return null;
      return { qr: state.qr, ageMs: Date.now() - state.qrAt };
    },

    async sendText(jid, body) {
      assertValidJid(jid);
      if (!state.sock || !state.connected) {
        const err = new Error("whatsapp-web is not connected yet — pair the account first (see instructions.md)");
        err.awaiting_connector = true;
        throw err;
      }
      const sock = state.sock;
      const result = await sendQueue.enqueue(async () => sock.sendMessage(jid, { text: body }));
      return { id: result?.key?.id ?? null };
    },

    status() {
      return {
        paired: state.paired,
        connected: state.connected,
        connecting: state.connecting,
        phone: maskJid(state.sock?.user?.id ?? null),
        qrAvailable: Boolean(state.qr),
        qrAgeMs: state.qrAt ? Date.now() - state.qrAt : null,
        lastDisconnect: state.lastDisconnect
      };
    },

    async close() {
      try {
        state.sock?.end?.(undefined);
      } catch {
        // already closed
      }
    }
  };
}

// ---------------------------------------------------------------------------
// HTTP layer — pure, only depends on the ConnectionManager interface. This is
// what tests exercise directly (with a fake connectionManager), and what
// startServer() wires the real one into.
// ---------------------------------------------------------------------------
/**
 * What a parked send actually does when its window elapses. Separate from
 * startServer so the invariant below is testable without a socket.
 */
export function createOutboxSender(connectionManager) {
  return async (entry) => {
    // Re-applied from the RECORDED context, never from this process's env: the
    // daemon does not carry GARRISON_AUTOMATION_ENGINE, so reading env here
    // would silently clear the refusal the connector applied at enqueue.
    if (entry.context === "automation") {
      throw new Error("refused at send time: queued by the Automations engine, which may never send a WhatsApp message");
    }
    // sendText, not the raw socket: the connection check, the jid assertion and
    // the human-pacing SendQueue all belong to the moment of the real send, not
    // to the moment it was parked.
    return connectionManager.sendText(entry.payload.jid, entry.payload.body);
  };
}

export function createApp({ connectionManager, store, contactIndex, messageBus = NULL_BUS, outbox = null, port, host, log = () => {} }) {
  // What a queued entry looks like from outside: enough to decide whether to
  // cancel it, never the whole record (the payload is a private message).
  const publicEntry = (entry) => ({
    id: entry.id,
    action: entry.action,
    to: entry.payload?.jid ?? null,
    preview: String(entry.payload?.body ?? "").slice(0, 300),
    summary: entry.summary,
    context: entry.context,
    status: entry.status,
    queuedAt: entry.queuedAt,
    executeAt: entry.executeAt
  });

  return async function handleRequest(req, res) {
    try {
      if (!isLoopbackAddr(req.socket?.remoteAddress)) {
        return jsonRes(res, 403, { ok: false, error: "loopback only" });
      }
      const parsed = url.parse(req.url || "", true);

      if (req.method === "GET" && parsed.pathname === "/health") {
        return jsonRes(res, 200, {
          ok: true,
          port,
          host,
          pid: process.pid,
          contacts: contactIndex.size,
          ...connectionManager.status()
        });
      }

      if (req.method === "GET" && parsed.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(STATUS_PAGE_HTML);
      }

      if (req.method === "GET" && parsed.pathname === "/contacts") {
        const n = Number(parsed.query.n || 500);
        return jsonRes(res, 200, { contacts: contactIndex.list(n), total: contactIndex.size });
      }

      if (req.method === "GET" && parsed.pathname === "/resolve") {
        const name = String(parsed.query.name || "");
        return jsonRes(res, 200, { candidates: contactIndex.resolve(name) });
      }

      if (req.method === "GET" && parsed.pathname === "/events") {
        // Live message stream (SSE). One `message` event per stored message,
        // inbound or outbound. No replay — see createMessageBus.
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        // Greet immediately so a buffering proxy flushes the headers and the
        // client's onopen fires before the first real message.
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        const unsubscribe = messageBus.subscribe((event) => {
          try { res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
        });
        // Heartbeat comment frame keeps intermediaries from idle-closing a
        // quiet stream; unref so it never holds the process open on shutdown.
        const heartbeat = setInterval(() => {
          try { res.write(": ping\n\n"); } catch { /* client gone */ }
        }, 25_000);
        if (typeof heartbeat.unref === "function") heartbeat.unref();
        const cleanup = () => { unsubscribe(); clearInterval(heartbeat); };
        req.on("close", cleanup);
        res.on("close", cleanup);
        return;
      }

      if (req.method === "GET" && parsed.pathname === "/recent") {
        const n = Number(parsed.query.n || 20);
        return jsonRes(res, 200, { messages: store.recentMessages(n) });
      }

      if (req.method === "GET" && parsed.pathname === "/last") {
        const chat = String(parsed.query.chat || "");
        if (!chat) return jsonRes(res, 400, { ok: false, error: "chat is required" });
        if (isValidJid(chat)) {
          return jsonRes(res, 200, { message: store.lastForChat(chat) });
        }
        const candidates = contactIndex.resolve(chat);
        if (candidates.length === 1) {
          return jsonRes(res, 200, { message: store.lastForChat(candidates[0].jid) });
        }
        if (candidates.length === 0) {
          return jsonRes(res, 200, { message: null });
        }
        // Ambiguous name — same non-guessing discipline as resolve_contact.
        return jsonRes(res, 200, { candidates });
      }

      if (req.method === "POST" && parsed.pathname === "/pair") {
        const body = await readJsonBody(req);
        const code = await connectionManager.requestPairingCode(body.phoneNumber);
        return jsonRes(res, 200, { code });
      }

      if (req.method === "POST" && parsed.pathname === "/pair/qr") {
        await connectionManager.startQrPairing();
        return jsonRes(res, 200, { ok: true });
      }

      if (req.method === "GET" && parsed.pathname === "/qr") {
        const cur = connectionManager.currentQr();
        if (!cur) {
          return jsonRes(res, 404, { ok: false, error: "no qr yet - POST /pair/qr first" });
        }
        const svg = await renderQrSvg(cur.qr);
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        return res.end(svg);
      }

      if (req.method === "POST" && parsed.pathname === "/send") {
        const body = await readJsonBody(req);
        const result = await connectionManager.sendText(body.jid, body.body);
        return jsonRes(res, 200, { ok: true, ...result });
      }

      // ── the delay buffer ───────────────────────────────────────────────
      // /send is the immediate path (a human in a UI). Everything an agent
      // triggers arrives here instead: parked for a cancel window, drained by
      // this daemon's timer. See ../lib/outbox.mjs.
      if (parsed.pathname === "/outbox" || parsed.pathname?.startsWith("/outbox/")) {
        if (!outbox) return jsonRes(res, 503, { ok: false, error: "outbox not configured" });

        if (req.method === "GET" && parsed.pathname === "/outbox") {
          return jsonRes(res, 200, { ok: true, pending: outbox.pending().map(publicEntry) });
        }

        if (req.method === "POST" && parsed.pathname === "/outbox") {
          const body = await readJsonBody(req);
          if (body.action !== "send_text") {
            return jsonRes(res, 400, { ok: false, error: `outbox does not carry action ${JSON.stringify(String(body.action ?? ""))}` });
          }
          assertValidJid(body.payload?.jid);
          if (!String(body.payload?.body ?? "").trim()) {
            return jsonRes(res, 400, { ok: false, error: "payload.body is required" });
          }
          // Fail fast on a connection this send could never use: an agent
          // deserves the honest "not paired" now, not a 60s wait for one.
          if (!connectionManager.status().connected) {
            return jsonRes(res, 409, {
              ok: false,
              error: "whatsapp-web is not connected yet — pair the account first (see instructions.md)",
              awaiting_connector: true
            });
          }
          const entry = outbox.enqueue({
            action: "send_text",
            payload: { jid: body.payload.jid, body: body.payload.body },
            summary: typeof body.summary === "string" ? body.summary : `WhatsApp to ${body.payload.jid}`,
            context: body.context === "human" || body.context === "automation" ? body.context : "agent"
          });
          log(`outbox: parked ${entry.id} (${entry.action} to ${maskJid(entry.payload.jid)}) until ${entry.executeAt}`);
          return jsonRes(res, 200, {
            ok: true,
            ...publicEntry(entry),
            delaySeconds: Math.round(outbox.delayMs / 1000),
            cancelHint: `curl -sX POST http://127.0.0.1:${port}/outbox/${entry.id}/cancel`
          });
        }

        const cancelMatch = req.method === "POST" ? /^\/outbox\/([^/]+)\/cancel$/.exec(parsed.pathname) : null;
        if (cancelMatch) {
          const outcome = outbox.cancel(decodeURIComponent(cancelMatch[1]));
          // Idempotent, and honest after the fact: a window that already
          // elapsed answers "sent", never a cancellation that did not happen.
          return jsonRes(res, outcome.ok ? 200 : outcome.status === "unknown" ? 404 : 409, {
            ...outcome,
            entry: outcome.entry ? publicEntry(outcome.entry) : null
          });
        }

        return jsonRes(res, 404, { ok: false, error: "not found" });
      }

      return jsonRes(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      log(`request error: ${err.message}`);
      const status = err.awaiting_connector ? 409 : 400;
      jsonRes(res, status, { ok: false, error: err.message, awaiting_connector: Boolean(err.awaiting_connector) });
    }
  };
}

async function writeStatusFile(ctx) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(
    STATUS_FILE,
    JSON.stringify(
      {
        fittingId: FITTING_ID,
        port: ctx.port,
        url: `http://${ctx.host === "0.0.0.0" ? "localhost" : ctx.host}:${ctx.port}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}

async function clearStatusFile() {
  try {
    await unlink(STATUS_FILE);
  } catch {
    // already gone
  }
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const port = opts.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`[whatsapp-web] invalid port ${opts.port}`);
  }
  const log = (...args) => console.error("[whatsapp-web]", ...args);

  const store = new MessageStore(opts.sessionDir);
  const contactIndex = new ContactIndex(path.join(opts.sessionDir, "contacts.json"));
  const cachedContacts = contactIndex.load();
  const sendQueue = new SendQueue({ minDelayMs: opts.minSendDelayMs, maxDelayMs: opts.maxSendDelayMs });
  const messageBus = createMessageBus();
  const connectionManager = buildConnectionManager({
    sessionDir: opts.sessionDir,
    gatewayUrl: opts.gatewayUrl,
    store,
    contactIndex,
    sendQueue,
    messageBus,
    log
  });

  // The delay buffer. Every agent-triggered send is parked here first; this
  // daemon is the only process long-lived enough to hold the window.
  const outbox = new Outbox({ file: OUTBOX_FILE, log, send: createOutboxSender(connectionManager) });

  const server = http.createServer(
    createApp({ connectionManager, store, contactIndex, messageBus, outbox, port, host: opts.host, log })
  );

  await new Promise((resolve, reject) => {
    // The configured port is CANONICAL: refuse to start rather than drift onto a
    // free one. Shifting would leave this instance answering on an address
    // nothing was told about, and quietly serve traffic meant for the profile
    // that actually owns the port. Same contract as every own-port fitting.
    const onListenError = (err) => {
      if (err?.code === "EADDRINUSE") {
        log(`port ${port} in use; refusing to start on a shifted port (the configured port is canonical)`);
        process.exit(1);
      }
      reject(err);
    };
    server.once("error", onListenError);
    server.listen(port, opts.host, () => {
      server.removeListener("error", onListenError);
      resolve();
    });
  });

  await writeStatusFile({ port, host: opts.host });
  log(`listening on http://${opts.host}:${port} (session: ${opts.sessionDir})`);
  log(`contact index: ${cachedContacts} entries restored from cache`);

  // Auto-reconnect only; never pairs on its own (see buildConnectionManager.init).
  await connectionManager.init().catch((err) => log(`init failed: ${err.message}`));

  // A restart inside someone's cancel window must not swallow their message:
  // re-arm what is still parked (overdue entries fire now). Anything caught
  // mid-send by the crash is failed, never retried — see Outbox.rearm.
  const rearmed = outbox.rearm();
  if (rearmed.length) log(`outbox: re-armed ${rearmed.length} parked send(s)`);

  const shutdown = async (signal) => {
    log(`received ${signal}, shutting down`);
    await connectionManager.close().catch(() => {});
    await clearStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return { server, connectionManager, store, contactIndex };
}

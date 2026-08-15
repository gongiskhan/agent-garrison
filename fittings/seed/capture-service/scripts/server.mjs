// Capture service — own-port server.
//
// M1 surface: websocket session ingress (lib/ingress.mjs) behind the master
// `enabled` flag, device registration, session read API, /health, status page.
// The Deepgram lane (M2), wake bus (M3), APNs (M5) and the speech sink (M5b)
// land behind their own default-off flags.
//
// Route conventions (omi-channel precedent):
//   403  implemented but disabled by its kill-switch flag (or missing secret)
//   501  not yet implemented (milestone pending)
//   404  on /ack and /notify UNTIL the sink milestones land — the kanban
//        fan-out treats 404 as "this fitting is not a sink", so the fitting
//        stays invisible to acks/notifications rather than swallowing them.
//
// Log privacy (invariant I5): no transcript text, no media bytes, no tokens
// in logs or counters — ids, seqs, counts and reasons only.

import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FITTING_ID, loadConfig } from "../lib/config.mjs";
import { CaptureStore, Counters, atomicWriteJSON, mergedCounters, readJSON } from "../lib/store.mjs";
import { CaptureIngress, bearerToken, tokenMatches } from "../lib/ingress.mjs";
import { TranscriptionLane } from "../lib/deepgram-live.mjs";
import { WakeBus } from "../lib/wake.mjs";
import { EchoGuard } from "../lib/echo-guard.mjs";
import { BoardClient } from "../lib/board-client.mjs";
import { MemoryWriter } from "../lib/memory-writer.mjs";
import { CompanionNotifier, isLoopbackUrl, priorityForTag } from "../lib/notify.mjs";
import { AckSink } from "../lib/ack-sink.mjs";
import { emitSessionEvent } from "../lib/events.mjs";
import { inferenceRunFn, operativeRunFn } from "../lib/gateway-client.mjs";

// Source identity handed to the byte-identical wake module (invariant I2:
// everything this channel persists carries source "companion-ios").
export const COMPANION_WAKE_SOURCE = {
  id: "companion-ios",
  label: "Companion",
  originPrefix: "companion",
  originChannel: { channel: "companion", threadId: "companion-reports" },
  sessionProvenanceKey: "companion_session_id",
  logPrefix: "capture-service"
};

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

async function readStatusFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeStatusFile(cfg) {
  const file = cfg.statusFile;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        fittingId: FITTING_ID,
        port: cfg.port,
        url: `http://${cfg.bindHost === "0.0.0.0" ? "localhost" : cfg.bindHost}:${cfg.port}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}

async function clearStatusFile(file) {
  try {
    await unlink(file);
  } catch {}
}

function flagSummary(cfg) {
  return {
    ingress: cfg.enabled,
    transcribe: cfg.transcribeEnabled,
    wake: cfg.wakeEnabled,
    notify: cfg.notifyEnabled,
    speak: cfg.speakEnabled
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

// Read a bounded request body. On overflow it stops buffering but KEEPS
// DRAINING the socket so the caller can answer a clean 413 — destroying the
// socket would surface as a transport error on the client instead
// (ios-thing readBody pattern).
function readBody(req, cap = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (overflow) return;
      if (size > cap) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(overflow ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const PAGE_CSS = `body{font-family:system-ui,sans-serif;margin:2rem;color:#222;max-width:52rem}
table{border-collapse:collapse;margin:1rem 0}td,th{border:1px solid #ccc;padding:.3rem .8rem;text-align:left}
h1{font-size:1.3rem}h2{font-size:1rem}a{color:#0a58ca}
.seg{margin:.35rem 0;line-height:1.4}.seg .who{color:#777;font-size:.85em;margin-right:.5em}
.seg.interim{color:#999;font-style:italic}.live{color:#0a7d33}.endedtag{color:#777}`;

function listSessions(store) {
  return readdirSync(store.dirs.sessions)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => readJSON(path.join(store.dirs.sessions, f)))
    .filter(Boolean);
}

function statusPage(cfg, counters, store) {
  const flags = flagSummary(cfg);
  const flagRows = Object.entries(flags)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v ? "on" : "off"}</td></tr>`)
    .join("");
  const counterRows = Object.entries(counters)
    .filter(([, v]) => typeof v === "number")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`)
    .join("");
  const sessionRows = listSessions(store)
    .slice(0, 50)
    .map(
      (s) =>
        `<tr><td><a href="/sessions/${escapeHtml(s.id)}">${escapeHtml(s.id)}</a></td>` +
        `<td>${escapeHtml(s.mode)}</td>` +
        `<td>${s.status === "live" ? '<span class="live">live</span>' : `<span class="endedtag">${escapeHtml(s.ended?.reason ?? "ended")}</span>`}</td>` +
        `<td>${escapeHtml(s.started_at ?? "")}</td>` +
        `<td>${s.transcript_words ?? 0}</td></tr>`
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>capture-service</title>
<style>${PAGE_CSS}</style></head>
<body><h1>capture-service</h1>
<p>iOS companion capture channel. Secrets are never shown here.</p>
<h2>Sessions</h2><table><tr><th>id</th><th>mode</th><th>status</th><th>started</th><th>words</th></tr>
${sessionRows || "<tr><td colspan=5>none yet</td></tr>"}</table>
<h2>Pipes</h2><table>${flagRows}</table>
<h2>Counters</h2><table>${counterRows || "<tr><td colspan=2>none yet</td></tr>"}</table>
</body></html>`;
}

// The live transcript view: stored finals render server-side; a live session
// streams interim + final segments over SSE. This page (and its SSE feed) is
// the operator's own-port view surface — reachable only on loopback/tailnet,
// unauthenticated like every other own-port fitting UI; the programmatic
// /capture/* API keeps its Bearer token.
function sessionPage(store, id) {
  const record = readJSON(path.join(store.dirs.sessions, `${id}.json`));
  if (!record) return null;
  const transcript = record.transcript_ref
    ? readJSON(path.join(store.root, record.transcript_ref))
    : null;
  const segments = (transcript?.segments ?? [])
    .map(
      (s) =>
        `<div class="seg"><span class="who">${s.is_user ? "you" : `speaker ${escapeHtml(s.speaker ?? "?")}`}</span>${escapeHtml(s.text)}</div>`
    )
    .join("");
  const liveBadge =
    record.status === "live"
      ? '<span class="live">live</span>'
      : `<span class="endedtag">${escapeHtml(record.ended?.reason ?? "ended")}</span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(id)} — capture-service</title>
<style>${PAGE_CSS}</style></head>
<body><h1><a href="/">capture-service</a> / ${escapeHtml(id)}</h1>
<p>${escapeHtml(record.mode)} · ${liveBadge} · consent ${escapeHtml(record.consent)} · device ${escapeHtml(record.device_name)}</p>
<div id="transcript">${segments || '<p id="empty">No transcript stored.</p>'}</div>
<script>
(function () {
  var live = ${JSON.stringify(record.status === "live")};
  if (!live) return;
  var box = document.getElementById("transcript");
  var empty = document.getElementById("empty");
  var interim = null;
  var es = new EventSource("/sessions/" + ${JSON.stringify(id)} + "/events");
  es.onmessage = function (ev) {
    var msg = JSON.parse(ev.data);
    if (msg.done) { es.close(); location.reload(); return; }
    if (empty) { empty.remove(); empty = null; }
    var el = document.createElement("div");
    el.className = "seg" + (msg.final ? "" : " interim");
    var who = document.createElement("span");
    who.className = "who";
    who.textContent = msg.is_user ? "you" : "speaker " + (msg.speaker == null ? "?" : msg.speaker);
    el.appendChild(who);
    el.appendChild(document.createTextNode(msg.text));
    if (interim) interim.remove();
    interim = msg.final ? null : el;
    box.appendChild(el);
    window.scrollTo(0, document.body.scrollHeight);
  };
})();
</script>
</body></html>`;
}

const SESSION_PATH_RE = /^\/capture\/sessions\/([A-Za-z0-9_-]{10,40})$/;
const APNS_TOKEN_RE = /^[0-9a-fA-F]{32,200}$/;

// HTTP-side auth ladder, mirroring the websocket upgrade: flag off answers
// 403 before anything else, then missing secret, then the token compare.
function authorizeHttp(cfg, req, counters) {
  if (!cfg.enabled) {
    counters.bump("rejected_disabled");
    return { ok: false, status: 403, reason: "capture ingress disabled" };
  }
  if (!cfg.secrets.captureToken) {
    counters.bump("rejected_no_secret");
    return { ok: false, status: 403, reason: "CAPTURE_TOKEN not sealed" };
  }
  if (!tokenMatches(bearerToken(req), cfg.secrets.captureToken)) {
    counters.bump("rejected_auth");
    return { ok: false, status: 401, reason: "bad token" };
  }
  return { ok: true };
}

export function makeRequestHandler(ctx) {
  const { cfg, store, counters } = ctx;
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    try {
      if (req.method === "GET" && (p === "/health" || p === "/api/health")) {
        return json(res, 200, {
          ok: true,
          fittingId: FITTING_ID,
          port: cfg.port,
          pid: process.pid,
          flags: flagSummary(cfg),
          secrets: {
            deepgramApiKey: Boolean(cfg.secrets.deepgramApiKey),
            captureToken: Boolean(cfg.secrets.captureToken),
            apnsTeamId: Boolean(cfg.secrets.apnsTeamId),
            apnsKeyId: Boolean(cfg.secrets.apnsKeyId),
            apnsP8: Boolean(cfg.secrets.apnsP8)
          },
          gatewayConfigured: Boolean(cfg.gatewayUrl),
          liveSessions: ctx.ingress ? ctx.ingress.sessions.size : 0,
          counters: mergedCounters(store.root)
        });
      }

      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(statusPage(cfg, mergedCounters(store.root), store));
        return;
      }

      // ---- Transcript view (own-port surface; loopback/tailnet trust) ----
      const viewMatch = req.method === "GET" ? /^\/sessions\/([A-Za-z0-9_-]{10,40})(\/events)?$/.exec(p) : null;
      if (viewMatch) {
        const [, id, wantsEvents] = viewMatch;
        if (!wantsEvents) {
          const html = sessionPage(store, id);
          if (!html) return json(res, 404, { error: "no such session" });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        // SSE: replay the finals accumulated so far, then stream live
        // interim + final segments until the session ends.
        const record = readJSON(path.join(store.dirs.sessions, `${id}.json`));
        if (!record) return json(res, 404, { error: "no such session" });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        const sendEvent = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        for (const segment of ctx.transcriber?.liveSegments(id) ?? []) sendEvent(segment);
        if (record.status !== "live") {
          sendEvent({ done: true });
          res.end();
          return;
        }
        const unsubscribe = ctx.transcriber?.subscribe(id, (segment) => sendEvent(segment));
        const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);
        heartbeat.unref?.();
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe?.();
        });
        if (!unsubscribe) {
          // Live session but no transcription lane: nothing will ever arrive.
          sendEvent({ done: true });
          res.end();
        }
        return;
      }

      // ---- Device registration (spec §4): POST /capture/devices ----
      if (req.method === "POST" && p === "/capture/devices") {
        const auth = authorizeHttp(cfg, req, counters);
        if (!auth.ok) return json(res, auth.status, { error: auth.reason });
        const body = await readBody(req);
        if (body === null) return json(res, 413, { error: "body too large" });
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }
        const token = String(parsed?.apns_token ?? "").trim();
        if (!APNS_TOKEN_RE.test(token)) {
          return json(res, 400, { error: "apns_token must be hex" });
        }
        const deviceName = String(parsed?.device_name ?? "iPhone").trim().slice(0, 64) || "iPhone";
        const registry = readJSON(store.devicesFile, { tokens: [] });
        const existing = registry.tokens.find((t) => t.token === token);
        if (existing) {
          existing.device_name = deviceName;
          counters.bump("devices_deduped");
        } else {
          registry.tokens.push({ token, device_name: deviceName, registered_at: new Date().toISOString() });
          counters.bump("devices_registered");
        }
        atomicWriteJSON(store.devicesFile, registry);
        return json(res, 200, { ok: true, count: registry.tokens.length });
      }

      // ---- Session read API (the replay client and the M2 view read these) ----
      if (req.method === "GET" && p === "/capture/sessions") {
        const auth = authorizeHttp(cfg, req, counters);
        if (!auth.ok) return json(res, auth.status, { error: auth.reason });
        const sessions = listSessions(store)
          .map((s) => ({
            id: s.id,
            mode: s.mode,
            device_name: s.device_name,
            consent: s.consent,
            started_at: s.started_at,
            status: s.status,
            audio_seq: s.audio_seq,
            video_seq: s.video_seq,
            ended: s.ended
          }));
        return json(res, 200, { sessions });
      }

      const sessionMatch = req.method === "GET" ? SESSION_PATH_RE.exec(p) : null;
      if (sessionMatch) {
        const auth = authorizeHttp(cfg, req, counters);
        if (!auth.ok) return json(res, auth.status, { error: auth.reason });
        const record = readJSON(path.join(store.dirs.sessions, `${sessionMatch[1]}.json`));
        if (!record) return json(res, 404, { error: "no such session" });
        return json(res, 200, { session: record });
      }

      // ---- Notification sink (the kanban fanOutNotification contract and
      // the triage CompanionRelayNotifier both speak this shape). Implementing
      // it is the ENTIRE opt-in: the fan-out discovers sinks by probing every
      // running own-port fitting and treating 404 as "not for you". Loopback
      // or tailnet callers only (never funneled). The notifier owns the flag,
      // cap, registry and degrade chain — a relay must never re-check flags
      // it cannot know.
      if (req.method === "POST" && p === "/notify") {
        const body = await readBody(req);
        if (body === null) return json(res, 413, { error: "body too large" });
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }
        const text = String(parsed?.text ?? "").trim();
        if (!text) return json(res, 400, { error: "text is required" });
        const idempotencyKey = typeof parsed.idempotencyKey === "string" ? parsed.idempotencyKey : null;
        if (ctx.notifier.alreadyDelivered(idempotencyKey)) {
          counters.bump("notify_deduplicated");
          return json(res, 200, [{ means: "companion-push", ok: true, deduplicated: true }]);
        }
        let link = typeof parsed.link === "string" ? parsed.link : null;
        if (link && isLoopbackUrl(link)) {
          counters.bump("notify_loopback_link_stripped");
          link = null;
        }
        const tag = typeof parsed.tag === "string" ? parsed.tag : "relay";
        const receipts = await ctx.notifier.deliver({
          title: String(parsed.title ?? "Garrison").slice(0, 120),
          body: link && !text.includes(link) ? `${text}\n${link}` : text,
          link,
          tag,
          // A relayed confirmation/ask answers something the user did, so it
          // draws on the interactive budget too — otherwise the fan-out's
          // routine chatter silences it exactly as it did on 2026-08-15.
          priority: priorityForTag(tag)
        });
        if (receipts.some((r) => r.ok)) ctx.notifier.markDelivered(idempotencyKey);
        return json(res, 200, receipts);
      }

      // Websocket endpoint reached over plain HTTP.
      if (p === "/capture/stream") {
        return json(res, 400, { error: "websocket upgrade required" });
      }

      // Anything else under /capture/ is a later milestone.
      if (p.startsWith("/capture/")) {
        counters.bump("requests_unimplemented");
        return json(res, 501, { error: "not implemented yet" });
      }

      // ---- The spoken-ack sink (kanban fanOutAck contract). Implementing
      // this route makes the fitting an ack sink the moment it runs; /ack and
      // /notify stay deliberately separate ("a sink that speaks must never
      // accidentally speak a full notification"). Echo registration happens
      // FIRST, inside the sink (§2.5).
      if (req.method === "POST" && p === "/ack") {
        const body = await readBody(req);
        if (body === null) return json(res, 413, { error: "body too large" });
        let ack;
        try {
          ack = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }
        if (ack?.skipped) return json(res, 200, { ok: true, ignored: "skipped ack" });
        const result = await ctx.ackSink.handleAck(ack);
        return json(res, result.status, result.body);
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      console.error(`[capture-service] handler error: ${err?.stack || err}`);
      return json(res, 500, { error: "internal error" });
    }
  };
}

export async function startServer(cfg = loadConfig()) {
  // Port discipline: never overwrite a status file whose pid is a LIVE other
  // process — a second spawn must fail loudly instead of silently stealing
  // the tracking slot and orphaning the first instance.
  const existing = await readStatusFile(cfg.statusFile);
  if (existing && Number.isInteger(existing.pid) && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(
      `[capture-service] refusing to start: ${cfg.statusFile} tracks a live instance ` +
        `(pid ${existing.pid}, ${existing.url ?? `port ${existing.port}`}) - stop it first`
    );
    process.exit(1);
  }

  // `live` is what handlers read; port is corrected to the actually-bound one
  // after listen (tests pass port 0 for an ephemeral bind).
  const live = { ...cfg };
  const store = new CaptureStore(live.stateDir);
  const counters = new Counters(store.root, "server");
  const notifier = new CompanionNotifier({ cfg: live, store, counters, env: cfg.env ?? process.env });

  // ONE echo guard per process, consulted in the segment path BEFORE the wake
  // gate (spec §2.5 defence 3): a returning spoken ack is not conversation and
  // must not become pre-wake "evidence". Registration arrives via POST /ack
  // at M5b; until then the window is simply empty.
  const echoGuard = new EchoGuard({ counters });

  // The two model lanes (never collapse them): a pinned cheap classifier the
  // speaker waits on, and the full operative turn nobody waits on.
  const wakeBus = new WakeBus({
    cfg: live,
    store,
    counters,
    runFn: live.gatewayUrl ? inferenceRunFn(live.gatewayUrl, { target: live.classifyTarget || null }) : null,
    operativeFn:
      live.gatewayUrl && live.delegateEnabled
        ? operativeRunFn(live.gatewayUrl, { timeoutMs: live.delegateTimeoutMs })
        : null,
    board: new BoardClient({ env: cfg.env ?? process.env }),
    memoryWriter: new MemoryWriter({ prefix: "companion", label: "Companion", env: cfg.env ?? process.env }),
    notifier,
    source: COMPANION_WAKE_SOURCE
  });

  const transcriber = new TranscriptionLane({
    cfg: live,
    counters,
    // Echo suppression at the single ingestion point: a suppressed segment
    // (the app's own spoken ack returning through the mic) never reaches the
    // stored transcript, the live view, or the wake gate (§2.5 defence 3).
    suppressFilter: (sessionId, segment) => echoGuard.shouldSuppress(segment.text),
    // Final segments only: interims are unstable text, and the settled-close
    // logic keys on the punctuation smart_format puts on finals.
    onSegment: (sessionId, segment) => {
      if (!segment.final) return;
      if (live.wakeEnabled) wakeBus.handleSegments({ sessionId, segments: [segment] });
    }
  });
  const ingress = new CaptureIngress({
    cfg: live,
    store,
    counters,
    transcriber,
    // M4: every ended session with a transcript becomes ONE pending
    // capture_event for the shared triage tick (dedupe by session id).
    onSessionEnd: (record) => emitSessionEvent({ record, store, counters, cfg: live })
  });
  const ackSink = new AckSink({ cfg: live, store, counters, echoGuard, ingress, notifier });
  ingress.onSpokenReceipt = (msg) => ackSink.handleSpokenReceipt(msg);
  const server = createServer(
    makeRequestHandler({ cfg: live, store, counters, ingress, transcriber, wakeBus, echoGuard, notifier, ackSink })
  );
  server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[capture-service] port ${cfg.port} in use; refusing to start on a shifted port (the configured port is canonical)`
      );
      process.exit(1);
    }
    console.error(`[capture-service] server error: ${err?.stack || err}`);
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(cfg.port, cfg.bindHost, resolve));
  live.port = server.address().port;
  await writeStatusFile(live);
  console.log(
    `[capture-service] listening on http://${live.bindHost}:${live.port} ` +
      `(home ${live.home}; flags ${JSON.stringify(flagSummary(live))})`
  );
  if (!cfg.gatewayUrl) {
    console.log("[capture-service] no gateway URL in env; gateway-dependent pipes will skip with a reason");
  }

  const shutdown = async (signal) => {
    console.log(`[capture-service] ${signal} received; shutting down`);
    ingress.close();
    transcriber.close();
    await clearStatusFile(live.statusFile);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { server, cfg: live, store, counters, ingress, transcriber, wakeBus, echoGuard, notifier };
}

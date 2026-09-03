// Capture service — own-port server.
//
// M1 surface: websocket session ingress (lib/ingress.mjs) behind the master
// `enabled` flag, device registration, session read API, /health, status page.
// The Deepgram lane (M2), wake bus (M3), APNs (M5) and the speech sink (M5b)
// land behind their own default-off flags.
//
// Voice REST surface (2026-09, one voice layer): POST /stt (a recorded clip in,
// a transcript out) and POST /tts (text in, an mp3 clip out) sit top-level
// beside /speak/<id>.mp3, behind the same Bearer ladder as /capture/*. The
// browser (through the shell's /api/voice proxy), the phone's clip fallback
// and the automations connector (scripts/connector.mjs) all come through
// here, so they share one backend choice and one clip cache with the ack lane.
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
import { readdirSync, statSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FITTING_ID, loadConfig } from "../lib/config.mjs";
import { CaptureStore, Counters, atomicWriteJSON, mergedCounters, readJSON, ulid } from "../lib/store.mjs";
import { CaptureIngress, TEXT_SESSION_ID_RE, TEXT_SOURCES, bearerToken, tokenMatches } from "../lib/ingress.mjs";
import { TranscriptionLane } from "../lib/deepgram-live.mjs";
import { ActiveConversation, OMI_WAKE_SOURCE, WakeBus, wakeRegex } from "../lib/wake.mjs";
import { FeedbackBus } from "../lib/feedback.mjs";
import { EchoGuard } from "../lib/echo-guard.mjs";
import { BoardClient } from "../lib/board-client.mjs";
import { MemoryWriter } from "../lib/memory-writer.mjs";
import { CompanionNotifier, appPathFor, isLoopbackUrl, priorityForTag } from "../lib/notify.mjs";
import { postConversationDigest, postConversationTurn } from "../lib/digest.mjs";
import { AckSink } from "../lib/ack-sink.mjs";
import { MAX_TEXT_CHARS, ZecaVoice } from "../lib/tts.mjs";
import { UpstreamError, transcribeClip } from "../lib/deepgram-rest.mjs";
import { Cues } from "../lib/cues.mjs";
import { ConfirmBus } from "../lib/confirm-bus.mjs";
import { CortexCli } from "../lib/cortex-cli.mjs";
import { ScreenContextIndex } from "../lib/screen-context.mjs";
import { makeConnectorFn } from "../lib/connector-call.mjs";
import { LanguageMemory } from "../lib/language-memory.mjs";
import { emitSessionEvent } from "../lib/events.mjs";
import { discussRunFn, inferenceRunFn, operativeRunFn } from "../lib/gateway-client.mjs";

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

// Pendant Direct (ADR D7): the BLE pendant relayed through the Companion is
// its own capture origin end to end - source "pendant" on wake events, origin
// "pendant" on cards, pendant_session_id in provenance.
export const PENDANT_WAKE_SOURCE = {
  id: "pendant",
  label: "Pendant",
  originPrefix: "pendant",
  originChannel: { channel: "pendant", threadId: "pendant-reports" },
  sessionProvenanceKey: "pendant_session_id",
  logPrefix: "capture-service"
};

// Omi (D24): omi-channel forwards its realtime segments here over
// POST /capture/ingest/text and keeps no wake bus of its own, so the omi
// identity the retired copy of wake.mjs carried (source "omi", origin
// "omi:wake:<id>", omi_session_id in provenance) now lives on a third bus in
// THIS process. Only the log prefix changes: the lines are written by
// capture-service, so they say so.
export const OMI_TEXT_WAKE_SOURCE = { ...OMI_WAKE_SOURCE, logPrefix: "capture-service" };

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
    speak: cfg.speakEnabled,
    pendant: cfg.pendantEnabled,
    capturePolicy: cfg.capturePolicy
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

// The raw-bytes twin of readBody for the recorded clip on POST /stt: no
// decoding, an 8 MB cap (a minute of webm/opus is well under 1 MB), the same
// drain-then-413 discipline.
const STT_BODY_CAP = 8 * 1024 * 1024;

function readBinaryBody(req, cap = STT_BODY_CAP) {
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
    req.on("end", () => resolve(overflow ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 502 for a failed upstream call: the upstream status and a bounded excerpt
// of its text body travel; audio and keys never do (UpstreamError is built
// that way).
function upstreamFailure(res, counters, counterName, err) {
  counters.bump(counterName);
  if (err instanceof UpstreamError) {
    return json(res, 502, {
      error: `${err.backend} upstream failed`,
      backend: err.backend,
      status: err.status || null,
      detail: err.detail
    });
  }
  return json(res, 502, { error: "upstream failed", detail: String(err?.message ?? err).slice(0, 200) });
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
    .map(
      ([k, v]) =>
        `<tr><td>${escapeHtml(k)}</td><td>${typeof v === "boolean" ? (v ? "on" : "off") : escapeHtml(String(v))}</td></tr>`
    )
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
// `liveRecord` covers the wake_only pendant session (ADR D6): live in memory,
// deliberately never on disk - the view works while it runs and vanishes with
// it.
function sessionPage(store, id, liveRecord = null) {
  const record = readJSON(path.join(store.dirs.sessions, `${id}.json`)) ?? liveRecord;
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
  const { cfg, store, counters, voice } = ctx;
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    try {
      // Spoken clips. Unauthenticated like the other own-port surfaces, and
      // safe to be: the id is a content hash of text the phone was just told to
      // say, it is validated as hex before it touches a path, and guessing one
      // requires already knowing the sentence.
      const speakMatch = p.match(/^\/speak\/([0-9a-f]{8,64})\.mp3$/);
      if (req.method === "GET" && speakMatch) {
        const audio = voice?.readClip(speakMatch[1]) ?? null;
        if (!audio) return json(res, 404, { error: "no such clip" });
        counters.bump("tts_clips_served");
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "content-length": audio.length,
          // Content-addressed: the bytes for an id can never change.
          "cache-control": "public, max-age=31536000, immutable"
        });
        res.end(audio);
        return;
      }

      // ---- Voice REST: the clip lanes (D20). Top-level, Bearer-gated. ----
      // POST /stt: the recorded clip as raw bytes -> { transcript, confidence,
      // language, model }. 400 empty, 413 over the cap, 503 without a Deepgram
      // key, 502 with the upstream status when Deepgram refuses.
      if (req.method === "POST" && p === "/stt") {
        const auth = authorizeHttp(cfg, req, counters);
        if (!auth.ok) return json(res, auth.status, { error: auth.reason });
        const bytes = await readBinaryBody(req);
        if (bytes === null) return json(res, 413, { error: "audio body too large" });
        if (bytes.length === 0) return json(res, 400, { error: "empty audio body" });
        if (!cfg.secrets.deepgramApiKey) {
          counters.bump("stt_rest_unkeyed");
          return json(res, 503, { error: "DEEPGRAM_API_KEY not sealed" });
        }
        const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim() || "audio/webm";
        const language = (url.searchParams.get("language") ?? "").trim() || null;
        const startedAt = Date.now();
        try {
          const result = await transcribeClip({ cfg, bytes, contentType, language, fetchImpl: cfg.fetchImpl ?? null });
          counters.bump("stt_rest_transcribed");
          counters.observe("stt_rest_ms", Date.now() - startedAt);
          return json(res, 200, result);
        } catch (err) {
          return upstreamFailure(res, counters, "stt_rest_upstream_failed", err);
        }
      }

      // POST /tts: JSON { text, format?: "mp3", lang?: "pt" | "en" } -> the mp3
      // clip, produced through ZecaVoice.clipFor so the browser, the phone and
      // the connector share one cache and one backend. X-Voice-Backend names
      // the engine, X-Clip-Id the cache entry (also reachable as
      // /speak/<id>.mp3). 400 on an empty line or one over MAX_TEXT_CHARS
      // (the caller chunks), 503 when no backend can speak.
      if (req.method === "POST" && p === "/tts") {
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
        const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
        if (!text) return json(res, 400, { error: "text is required" });
        if (text.length > MAX_TEXT_CHARS) {
          return json(res, 400, { error: `text over ${MAX_TEXT_CHARS} characters; chunk it` });
        }
        if (parsed.format !== undefined && parsed.format !== "mp3") {
          return json(res, 400, { error: "format must be mp3" });
        }
        const lang = parsed.lang === "pt" || parsed.lang === "en" ? parsed.lang : null;
        const avail = voice.available();
        if (!avail.ok) {
          counters.bump("tts_rest_unavailable");
          return json(res, 503, { error: avail.reason });
        }
        let clip;
        try {
          clip = await voice.render(text, { lang });
        } catch (err) {
          return upstreamFailure(res, counters, "tts_rest_upstream_failed", err);
        }
        const audio = clip ? voice.readClip(clip.id) : null;
        if (!audio) return json(res, 503, { error: "no clip produced" });
        counters.bump("tts_rest_served");
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "content-length": audio.length,
          "x-voice-backend": clip.backend ?? avail.backend,
          "x-clip-id": clip.id,
          // Same bytes for the same id forever; the id is the cache key.
          "cache-control": "private, max-age=31536000, immutable"
        });
        res.end(audio);
        return;
      }

      // ---- Text ingest (D24): another service's transcript segments. ----
      // POST /capture/ingest/text { source: "omi", session_id, segments: [{text,
      // speaker?, is_user?, start?, end?}] } -> 202 { session, accepted }. Opens
      // or extends the socket-less text session "<source>:<session_id>", runs
      // every segment through the shared echo guard (Zeca's own voice coming
      // back through the Omi mic is not conversation), and hands what survives
      // to the omi wake bus as finals - never to the companion or pendant
      // buses, which key on their own capture sessions. Nothing is persisted:
      // the forwarding channel keeps the memory path (no media log, no
      // transcript, no capture_event), so a conversation is never ingested twice.
      if (req.method === "POST" && p === "/capture/ingest/text") {
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
        const source = typeof parsed?.source === "string" ? parsed.source.trim() : "";
        if (!TEXT_SOURCES.has(source)) {
          return json(res, 400, { error: `source must be one of: ${[...TEXT_SOURCES].join(", ")}` });
        }
        const externalId = typeof parsed?.session_id === "string" ? parsed.session_id.trim() : "";
        if (!TEXT_SESSION_ID_RE.test(externalId)) {
          return json(res, 400, { error: "session_id is required (1-80 chars of [A-Za-z0-9_.:-])" });
        }
        if (!Array.isArray(parsed?.segments)) return json(res, 400, { error: "segments must be an array" });
        counters.bump("text_ingest_calls");
        const { session } = ctx.ingress.openTextSession({ source, sessionId: externalId });
        const accepted = [];
        for (const seg of parsed.segments) {
          const text = typeof seg?.text === "string" ? seg.text.trim() : "";
          if (!text) continue;
          // The guard counts what it eats (realtime_echo_suppressed).
          if (ctx.echoGuard.shouldSuppress(text)) continue;
          accepted.push({
            text,
            final: true,
            speaker: seg.speaker ?? null,
            is_user: seg.is_user !== false,
            start: typeof seg.start === "number" ? seg.start : null,
            end: typeof seg.end === "number" ? seg.end : null
          });
        }
        if (accepted.length > 0) counters.bump("text_ingest_segments", accepted.length);
        ctx.ingress.noteTextSegments(session, accepted.length);
        if (accepted.length > 0 && cfg.wakeEnabled && ctx.omiWakeBus) {
          ctx.omiWakeBus.handleSegments({ sessionId: session.record.id, segments: accepted });
        }
        return json(res, 202, { session: session.record.id, accepted: accepted.length });
      }

      // ---- The active-conversation pin (D25). ----
      // POST { session_id } -> 200 { session_id, until } pins every bus's next
      // delegate onto that gateway session for one window; GET reads the pin
      // (nulls when none or expired); DELETE clears it. Process memory only.
      if (p === "/capture/conversation/active") {
        const auth = authorizeHttp(cfg, req, counters);
        if (!auth.ok) return json(res, auth.status, { error: auth.reason });
        const active = ctx.activeConversation;
        if (req.method === "GET") return json(res, 200, active.current());
        if (req.method === "DELETE") {
          active.clear();
          counters.bump("conversation_pin_cleared");
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          if (body === null) return json(res, 413, { error: "body too large" });
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            return json(res, 400, { error: "invalid JSON" });
          }
          const sessionId = typeof parsed?.session_id === "string" ? parsed.session_id.trim() : "";
          if (!sessionId || sessionId.length > 200) return json(res, 400, { error: "session_id is required" });
          counters.bump("conversation_pinned");
          return json(res, 200, active.pin(sessionId));
        }
        return json(res, 405, { error: "method not allowed" });
      }

      // The conversation, as data - what the app's Conversation screen renders.
      // One exchange per wake command: the user's words, what Zeca decided
      // (intent), what he said back (full text, untruncated - the push banner
      // is a preview, THIS is the record), how it was delivered, and every
      // follow-up round of a clarifying-question dialogue threaded under it.
      //
      // Same bearer as the capture stream: this is transcript-adjacent content
      // and never leaves without the token.
      if (req.method === "GET" && p === "/capture/exchanges") {
        const auth = authorizeHttp(cfg, req, counters);
        if (!auth.ok) return json(res, auth.status, { error: auth.reason });
        const dir = path.join(store.root, "wake-results");
        let names = [];
        try {
          names = readdirSync(dir);
        } catch {
          /* no exchanges yet */
        }
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const bases = names
          .filter((f) => /^[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(f))
          .map((f) => {
            try {
              return { id: f.slice(0, -5), mtime: statSync(path.join(dir, f)).mtimeMs };
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, limit);
        const exchanges = [];
        for (const { id } of bases) {
          const record = readJSON(path.join(dir, `${id}.json`));
          if (!record) continue;
          const followups = [];
          const answer = readJSON(path.join(dir, `${id}.delegate.json`));
          if (answer) followups.push({ round: 0, at: answer.at ?? null, request: answer.request ?? null, reply: answer.reply ?? "", ok: answer.ok !== false });
          for (const f of names) {
            const m = f.match(new RegExp(`^${id}\\.followup\\.(\\d+)\\.json$`));
            if (!m) continue;
            const doc = readJSON(path.join(dir, f));
            if (doc) followups.push({ round: Number(m[1]), at: doc.at ?? null, request: doc.request ?? null, reply: doc.reply ?? "", ok: doc.ok !== false });
          }
          followups.sort((a, b) => a.round - b.round);
          exchanges.push({
            id,
            at: record.at ?? null,
            command: record.command ?? "",
            intent: record.intent ?? null,
            confirmation: record.confirmation ?? null,
            lang: record.lang ?? null,
            cardId: record.cardId ?? null,
            cardUrl: record.cardUrl ?? null,
            delivery: record.delivery ?? null,
            followups
          });
        }
        counters.bump("exchanges_served");
        return json(res, 200, { exchanges });
      }

      if (req.method === "GET" && (p === "/health" || p === "/api/health")) {
        return json(res, 200, {
          ok: true,
          fittingId: FITTING_ID,
          port: cfg.port,
          pid: process.pid,
          flags: flagSummary(cfg),
          secrets: {
            deepgramApiKey: Boolean(cfg.secrets.deepgramApiKey),
            elevenLabsApiKey: Boolean(cfg.secrets.elevenLabsApiKey),
            captureToken: Boolean(cfg.secrets.captureToken),
            apnsTeamId: Boolean(cfg.secrets.apnsTeamId),
            apnsKeyId: Boolean(cfg.secrets.apnsKeyId),
            apnsP8: Boolean(cfg.secrets.apnsP8)
          },
          gatewayConfigured: Boolean(cfg.gatewayUrl),
          // The voice layer at a glance (D20): can /stt transcribe, can /tts
          // speak and through which engine, and is the REST surface reachable
          // at all (master flag on AND a capture token to present). The
          // top-level keyConfigured mirrors voice.stt for readers that still
          // apply `h.keyConfigured !== false`, so nobody lights a microphone
          // against a service with no Deepgram key.
          voice: {
            stt: Boolean(cfg.secrets.deepgramApiKey),
            tts: voice?.available().ok ?? false,
            ttsBackend: voice?.backend() ?? null,
            restEnabled: Boolean(cfg.enabled && cfg.secrets.captureToken),
            // The per-request /tts budget. Callers chunk against THIS number
            // rather than a constant of their own, so the cap can move here
            // without every client silently starting to 400.
            maxTextChars: MAX_TEXT_CHARS
          },
          keyConfigured: Boolean(cfg.secrets.deepgramApiKey),
          // Push and speech health at a glance. Both failed silently this week
          // in ways /health could not show: a device token accepted by APNs
          // while the phone showed nothing, and every spoken line going to a
          // dead socket that still read as OPEN. "How many devices, how old is
          // the token, which session would be spoken to" is the difference
          // between diagnosing that in a minute and guessing for days.
          push: (() => {
            try {
              const devices = ctx.notifier?.deviceTokens?.() ?? [];
              // The registry key is `tokens`, not `devices` - reading the wrong
              // one is what made an earlier probe report "0 devices" while APNs
              // was happily delivering to 1, and sent me chasing registration.
              const raw = readJSON(store.devicesFile, { tokens: [] });
              const newest = (raw.tokens ?? [])
                .map((d) => d?.registered_at ?? d?.registeredAt ?? null)
                .filter(Boolean)
                .sort()
                .pop();
              return {
                devices: devices.length,
                capsToday: {
                  routine: `${ctx.notifier?.sentToday?.("routine") ?? "?"}/${cfg.notifyMaxPerDay}`,
                  interactive: `${ctx.notifier?.sentToday?.("interactive") ?? "?"}/${cfg.notifyInteractiveMaxPerDay}`
                },
                newestTokenRegisteredAt: newest ?? null
              };
            } catch {
              return { devices: 0 };
            }
          })(),
          speakable: (() => {
            const sessions = [...(ctx.ingress?.sessions?.values?.() ?? [])];
            const speakable = sessions.filter(
              (x) => (x.record.mode === "audio" || x.record.mode === "pendant") && !x.record.ended
            );
            return {
              inMemorySessions: sessions.length,
              byMode: sessions.reduce((acc, x) => {
                acc[x.record.mode] = (acc[x.record.mode] ?? 0) + 1;
                return acc;
              }, {}),
              speakableNow: speakable.length,
              chosen: ctx.ackSink?.speakableSession?.()?.record?.id ?? null
            };
          })(),
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
        const liveRecord = ctx.ingress?.sessions.get(id)?.record ?? null;
        if (!wantsEvents) {
          const html = sessionPage(store, id, liveRecord);
          if (!html) return json(res, 404, { error: "no such session" });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        // SSE: replay the finals accumulated so far, then stream live
        // interim + final segments until the session ends.
        const record = readJSON(path.join(store.dirs.sessions, `${id}.json`)) ?? liveRecord;
        if (!record) return json(res, 404, { error: "no such session" });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        // Node holds the status line back until the first body write, and a
        // quiet live session's first write is the 15s keepalive - so without
        // this an EventSource (or a fetch awaiting headers) sat "connecting"
        // for 15 seconds on every session that had not spoken yet.
        res.flushHeaders();
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

      // ---- Page-side speech (D56). The Conversations page speaks the
      // operative's answer through the phone's own synthesizer while a
      // broadcast is on: that mic hears the speaker, so the text is registered
      // with the echo guard here before the page says it, exactly as the
      // in-app speak lane registers its acks. Token-gated like every ingress.
      if (req.method === "POST" && p === "/spoken") {
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
        const text = String(parsed?.text ?? "").trim();
        if (!text) return json(res, 400, { error: "text is required" });
        // The guard window is 30 s from registration; a page speaking a long
        // answer re-posts while it is still talking.
        ctx.echoGuard.register({ text });
        counters.bump("spoken_registered");
        return json(res, 202, { ok: true, chars: text.length });
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
          // The in-app route: explicit `path`, or the link's path when the link
          // is on this node's app. The iOS app opens it on tap.
          path: appPathFor({ path: parsed.path, link }, process.env),
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
  // The cue texts double as echo prefixes: a cue plays while the user is
  // already talking, and its echo sometimes lands fused onto the front of the
  // command's first segment where the exact-match echo lane cannot reach it.
  live.wakeEchoPrefixes = ["sim", "yes", "deixa comigo", "on it", "ok", "okay"];
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
  const runFn = live.gatewayUrl ? inferenceRunFn(live.gatewayUrl, { target: live.classifyTarget || null }) : null;
  const operativeFn =
    live.gatewayUrl && live.delegateEnabled
      ? operativeRunFn(live.gatewayUrl, { timeoutMs: live.delegateTimeoutMs })
      : null;
  const board = new BoardClient({ env: cfg.env ?? process.env });
  // The screen the user was looking at. Assigned once `ingress` exists (it is
  // constructed below), and reached through a thunk - the same forward
  // reference transcriber.onSegment already uses for ingress.sessions.
  // Speak first, push as the fallback - the answer to "the rest of the
  // messages are just push notifications". Every wake confirmation (query
  // answers, delegate acks and results, card-command outcomes, fallback notes)
  // is SPOKEN through the ack sink when a live session can hear it, and only
  // falls back to the APNs push when nothing can. When the spoken text asks a
  // question, the answer window opens (wake.mjs expectAnswer/armAnswerWindow)
  // so the wearer can reply without the wake word.
  //
  // Forward references on purpose: ackSink and the buses are constructed
  // below, and send() only ever runs after startup.
  let ackSinkRef = null;
  const answerBuses = [];
  // Confirmations spoken but never CONFIRMED spoken. A socket send is not
  // delivery - the app can be suspended with the socket looking open - so the
  // payload is kept until the receipt lands, and the receipt timeout turns it
  // into the push it originally skipped. Bounded: entries die with the receipt,
  // the timeout, or the sweep below.
  const awaitingReceipt = new Map(); // ackId -> { payload, at }
  const sweepAwaiting = () => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, entry] of awaitingReceipt) if (entry.at < cutoff) awaitingReceipt.delete(id);
  };
  const speakingNotifier = {
    send: async (payload) => {
      const { template, params = {} } = payload ?? {};
      const text = typeof params.text === "string" ? params.text.trim() : "";
      // The confirmation AND the operative's answer (D56 conversation_reply)
      // are spoken first: a live mic or pendant session hears them, the push
      // is the fallback. The broadcast lane never speaks here (no AEC coupling
      // to the app speaker, ADR §6); its answer is spoken by the page itself.
      const spokenFirst = template === "wake_confirmation" || template === "conversation_reply";
      if (spokenFirst && text && ackSinkRef?.speakableSession()) {
        const ackId = `wake-${ulid()}`;
        // Progress pings and "didn't catch that" are presence, not information:
        // spoken when someone is listening, never turned into a banner.
        const isProgress = params.progress === true || params.speakOnly === true;
        // A question opens the expectation BEFORE the speak leaves, so the
        // phone's {spoken} receipt can arm it - never the other way round, or
        // the receipt races the registration.
        if (!isProgress && text.endsWith("?") && params.sessionId) {
          for (const bus of answerBuses) {
            bus.expectAnswer(params.sessionId, ackId, {
              lang: params.lang ?? null,
              rounds: params.followupRounds ?? 0,
              eventId: params.eventId ?? null
            });
          }
        }
        try {
          const res = await ackSinkRef.handleAck({
            id: ackId,
            kind: "captured",
            severity: "info",
            templateId: template,
            text,
            ...(params.lang ? { lang: params.lang } : {})
          });
          if (res?.body?.delivered === "socket") {
            counters.bump(template === "conversation_reply" ? "wake_replies_spoken" : "wake_confirmations_spoken");
            // A progress line is presence, not information: if it was not
            // heard, there is nothing to recover - never push it.
            if (!isProgress) {
              sweepAwaiting();
              awaitingReceipt.set(ackId, { payload, at: Date.now() });
            }
            return [{ means: "companion-speech", ok: true, ackId }];
          }
        } catch (err) {
          console.error(`[capture-service] speak-first confirmation failed, pushing instead: ${err?.message ?? err}`);
        }
        // Not spoken: an unarmed answer expectation can never open, so it is
        // safe to leave behind; the push below is the delivery.
        if (isProgress) return [{ means: "companion-speech", ok: false, skipped: "progress line, nothing listening" }];
      }
      return notifier.send(payload);
    },
    cardUrl: (id) => notifier.cardUrl(id)
  };

  let screenContext = null;
  const screenContextFn = (q) => screenContext?.latest(q) ?? null;
  const screenFramesFn = (q) => screenContext?.recent(q) ?? null;

  // The REC button's broadcast is a microphone into ONE conversation: a wake
  // hit on a session that carries a conversation_id becomes a user turn there
  // (words after the wake word + the latest frames), never a classified
  // command. The ingress is constructed below; the index holds it.
  // Falls back to the persisted session record: a wake hit carried by the
  // transcription lane's final flush arrives after the ingress has already
  // dropped the live session, and that late word still belongs to the
  // conversation the broadcast was started from.
  const conversationFn = (sessionId) => {
    if (!sessionId) return null;
    const live = screenContext?.ingress?.sessions?.get(sessionId)?.record?.conversation_id;
    if (live) return live;
    const stored = readJSON(path.join(store.dirs.sessions, `${sessionId}.json`));
    return typeof stored?.conversation_id === "string" ? stored.conversation_id : null;
  };
  const conversationTurnFn = ({ conversationId, command, eventId, frames }) =>
    postConversationTurn({
      conversationId,
      command,
      eventId,
      frames,
      counters,
      env: cfg.env ?? process.env,
      fetchImpl: live.fetchImpl ?? fetch
    });

  // One active-conversation window for the process (D25): the pin is shared
  // by all three buses, each bus remembers its own last reply.
  const activeConversation = new ActiveConversation({ windowMs: live.activeConversationWindowMs });

  const wakeBus = new WakeBus({
    screenContextFn,
    screenFramesFn,
    conversationFn,
    conversationTurnFn,
    activeConversation,
    cfg: live,
    store,
    counters,
    runFn,
    operativeFn,
    board,
    memoryWriter: new MemoryWriter({ prefix: "companion", label: "Companion", env: cfg.env ?? process.env }),
    notifier: speakingNotifier,
    source: COMPANION_WAKE_SOURCE
  });

  // Pendant Direct: the feedback bus (ADR D7) plus a second WakeBus instance
  // carrying the pendant identity. Same deps, same store, same notifier (the
  // pendant's phone IS the companion phone); the lifecycle hook is inert on
  // the companion bus and live here.
  // Which language Zeca is speaking. Fed only by text aimed at Zeca (see
  // language-memory.mjs), consulted by the cues and by the wake bus.
  const languageMemory = new LanguageMemory({ stateDir: live.stateDir, cfg: live, counters });

  // The spoken-discussion lane: same gateway door, pinned to the composition's
  // real `discuss` duty cell.
  const discussFn = live.gatewayUrl
    ? discussRunFn(live.gatewayUrl, { timeoutMs: live.discussTurnTimeoutMs, level: live.discussLevel })
    : null;
  // Connector calls for spoken sends. NOT the automations invoker - see
  // connector-call.mjs for why that one cannot be used here.
  const connectorFn = makeConnectorFn({ env: cfg.env ?? process.env });
  const cortexFn = new CortexCli({ cfg: live, counters, env: cfg.env ?? process.env });

  const feedbackBus = new FeedbackBus({
    counters,
    // A CONFIRMED wake legitimately lasts as long as its capture can run. A
    // provisional one - opened by an interim guess - must not, or one bad
    // interim mutes the wearer for the whole capture window.
    wakeWindowTtlMs: live.wakeMaxCaptureMs + live.wakeSilenceCloseMs,
    wakeProvisionalTtlMs: live.wakeProvisionalTtlMs
  });
  const pendantWakeBus = new WakeBus({
    cfg: live,
    store,
    counters,
    runFn,
    operativeFn,
    board,
    memoryWriter: new MemoryWriter({ prefix: "pendant", label: "Pendant", env: cfg.env ?? process.env }),
    notifier: speakingNotifier,
    source: PENDANT_WAKE_SOURCE,
    language: () => languageMemory.current(),
    discussFn,
    connectorFn,
    cortexFn,
    screenContextFn,
    activeConversation,
    onLifecycle: (name, payload) => feedbackBus.emit(name, payload)
  });
  // The omi bus (D24): fed by POST /capture/ingest/text, never by the
  // transcription lane. Same deps as the companion bus and the same
  // speakingNotifier, so an Omi request is answered where every other reply
  // lands - spoken through the phone when a companion session can hear, else
  // pushed. It has no socket of its own to speak into, so no speakFn: the
  // discuss intent degrades to delegate here exactly as it did on omi-channel.
  const omiWakeBus = new WakeBus({
    cfg: live,
    store,
    counters,
    runFn,
    operativeFn,
    board,
    memoryWriter: new MemoryWriter({ prefix: "omi", label: "Omi", env: cfg.env ?? process.env }),
    notifier: speakingNotifier,
    source: OMI_TEXT_WAKE_SOURCE,
    screenContextFn,
    activeConversation
  });
  answerBuses.push(wakeBus, pendantWakeBus, omiWakeBus);
  // The interim wake watcher (ADR D8): fires the wake_detected FEEDBACK on
  // Deepgram interims so the pendant buzzes fast; the authoritative window
  // still runs on finals through the untouched WakeBus. The FeedbackBus
  // swallows the duplicate when the final lands.
  const pendantInterimRegex = wakeRegex(live.wakeVariants);

  const transcriber = new TranscriptionLane({
    cfg: live,
    counters,
    // Echo suppression at the single ingestion point: a suppressed segment
    // (the app's own spoken ack returning through the mic) never reaches the
    // stored transcript, the live view, or the wake gate (§2.5 defence 3).
    suppressFilter: (sessionId, segment) => echoGuard.shouldSuppress(segment.text),
    // Final segments only reach the wake buses: interims are unstable text,
    // and the settled-close logic keys on smart_format punctuation. The one
    // interim consumer is the pendant's feedback-only wake watcher above.
    onSegment: (sessionId, segment) => {
      // A cancellation is an ANSWER to a prompt Zeca just spoke, not a command,
      // so it is checked before the wake gate and before the discussion branch
      // and it needs no wake word.
      if (segment.final && confirmBus.consumeSegment(sessionId, segment.text)) return;
      const mode = ingress?.sessions.get(sessionId)?.record.mode ?? null;
      // Language is learned ONLY from speech aimed at Zeca: a segment carrying
      // the wake word, or one arriving while the capture window is open.
      // Ambient television in another language must never flip the cue.
      if (segment.final && (languageMemory.isCapturing(sessionId) || pendantInterimRegex?.test(segment.text))) {
        languageMemory.note(sessionId, segment.text);
      }
      if (mode === "pendant") {
        if (!live.wakeEnabled) return;
        if (!segment.final) {
          if (pendantInterimRegex?.test(segment.text)) {
            counters.bump("pendant_interim_wake_hits");
            feedbackBus.emit("wake_detected", { sessionId, at: Date.now(), interim: true });
          }
          return;
        }
        pendantWakeBus.handleSegments({ sessionId, segments: [segment] });
        return;
      }
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
    onSessionEnd: (record) => {
      emitSessionEvent({ record, store, counters, cfg: live });
      // G5: a recording started from a conversation reports back into it.
      if (record.conversation_id) {
        void postConversationDigest({
          record,
          store,
          cfg: live,
          counters,
          notifier,
          env: cfg.env ?? process.env,
          fetchImpl: live.fetchImpl ?? fetch
        });
      }
    }
  });
  screenContext = new ScreenContextIndex({ ingress, cfg: live, counters });
  // cfg.fetchImpl is the REST-lane twin of cfg.wsFactory: a test hands the
  // clip calls (ElevenLabs, Deepgram /v1/listen and /v1/speak) a local fetch.
  const voice = new ZecaVoice({ cfg: live, counters, fetchImpl: live.fetchImpl ?? null });
  const cues = new Cues({ cfg: live, voice, counters });
  // Four short clips, once, so the first wake of the day is as fast as the
  // hundredth. Never awaited: a cold cue costs the phone's own voice, not a
  // delayed one.
  void cues.prewarm();
  const ackSink = new AckSink({ cfg: live, store, counters, echoGuard, ingress, notifier, voice, languageMemory });
  ackSinkRef = ackSink;
  // Announce-and-cancel for a parked send. Owns no timer of its own: the
  // connector's outbox holds the send, this only says it out loud and cancels.
  const confirmBus = new ConfirmBus({ cfg: live, counters, ackSink, languageMemory, env: cfg.env ?? process.env });
  // Speaking is the ack lane, which is what registers the echo fingerprint
  // BEFORE anything leaves - without that, Zeca's own voice comes back through
  // the pendant mic and, in a discussion where there is no wake gate, becomes
  // the user's next utterance.
  pendantWakeBus.speakFn = async (text, { kind = "discuss", lang = null } = {}) => {
    await ackSink.handleAck({
      id: `voice-${ulid()}`,
      kind: "captured",
      severity: "info",
      templateId: `voice_${kind}`,
      text,
      ...(lang ? { lang } : {})
    });
  };
  // Every delegated or parked action opens the confirmation watch.
  const wrappedAfter = confirmBus;
  ackSink.onSpeakTimeout = (ackId) => {
    const entry = awaitingReceipt.get(ackId);
    if (!entry) return;
    awaitingReceipt.delete(ackId);
    counters.bump("wake_confirmation_push_after_timeout");
    void notifier.send(entry.payload).catch(() => []);
  };
  ingress.onSpokenReceipt = (msg) => {
    ackSink.handleSpokenReceipt(msg);
    // The announcement has actually left the speaker now, so the microphone is
    // hearing the user again rather than us.
    if (msg?.ok) {
      const ackId = String(msg?.spoken ?? "");
      awaitingReceipt.delete(ackId);
      wrappedAfter.onSpoken(ackId);
      // A spoken question opens its answer window only now - its own echo,
      // which the mic hears a beat later, can no longer answer it.
      for (const bus of answerBuses) bus.armAnswerWindow(ackId);
    }
  };

  // Feedback delivery: every event goes to the live pendant session's socket
  // as {type:"feedback", event}; the Companion drives the device haptic and
  // the phone sinks and answers {type:"feedback_ack", event_id}, which closes
  // the latency measurement (wake_to_device_ack_ms /
  // card_commit_to_created_ack_ms on /health).
  feedbackBus.subscribeAll((event) => {
    const session = ingress.sessions.get(event.session_id);
    if (!session || session.record.mode !== "pendant") return;
    const ws = session.socket;
    if (ws && ws.readyState === ws.OPEN) {
      try {
        // The spoken cue rides the event it belongs to. Resolved SYNCHRONOUSLY
        // (cachedClipFor never touches the network) because everything after
        // this send - the device haptic, the feedback_ack, and therefore
        // wake_to_device_ack_ms - is waiting on it.
        //
        // A deduped wake never reaches here at all: FeedbackBus.emit returns
        // null before calling subscribers, so a swallowed second "Zeca" stays
        // silent for free.
        // A window that closed on nothing gets no "Deixa comigo." - the
        // unheard line the wake bus is about to speak is the honest one.
        const speak = event.empty
          ? null
          : cues.speechFor(event.name, languageMemory.current(event.session_id));
        if (speak) {
          // Before the sound exists, not after: the cue comes back through the
          // pendant mic a beat later, and while the capture window is open it
          // would otherwise land in the command AND re-arm the silence timer.
          cues.registerEcho(echoGuard, speak);
        }
        ws.send(JSON.stringify({ type: "feedback", event: speak ? { ...event, speak } : event }));
        counters.bump("feedback_pushed");
      } catch {
        counters.bump("feedback_push_failed");
      }
    } else {
      counters.bump("feedback_unpushed_no_socket");
    }
  });
  // The capture window drives what counts as speech aimed at Zeca.
  feedbackBus.subscribeAll((event) => {
    if (event.name === "wake_detected") languageMemory.markCapturing(event.session_id, true);
    else if (event.name === "window_closed" || event.name === "wake_lapsed") {
      languageMemory.markCapturing(event.session_id, false);
    }
  });
  ingress.onFeedbackAck = (sessionId, msg) => {
    feedbackBus.recordDeviceAck(String(msg?.event_id ?? ""), {
      atMs: typeof msg?.at_ms === "number" ? msg.at_ms : null
    });
  };

  const server = createServer(
    makeRequestHandler({
      cfg: live,
      store,
      counters,
      ingress,
      transcriber,
      wakeBus,
      pendantWakeBus,
      omiWakeBus,
      activeConversation,
      feedbackBus,
      echoGuard,
      notifier,
      voice,
      ackSink
    })
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

  return {
    server,
    cfg: live,
    store,
    counters,
    ingress,
    transcriber,
    wakeBus,
    pendantWakeBus,
    omiWakeBus,
    activeConversation,
    feedbackBus,
    echoGuard,
    notifier,
    voice,
    ackSink
  };
}

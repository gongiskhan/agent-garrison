// Realtime forwarder (D24, 2026-09-02): the omi side of the one voice layer.
//
// Every realtime segment Omi delivers is handed to the voice layer - the
// capture-service fitting - over its text ingest, and the wake gate, the echo
// guard, the classifier and the dispatch all run THERE. This fitting keeps
// none of that any more: it authenticates the webhook (I8), acks fast (I7) and
// forwards. There is no local fallback on purpose: with the voice layer down the
// segments are dropped and counted, never buffered or classified here.
//
// Privacy (I5) holds across the hop: the segments live in memory between the
// webhook body and the outbound request, and every log line this module writes
// describes the FAILURE (status, reason, byte counts), never the speech.
//
// Discovery follows the fan-out convention every fitting uses: the voice
// layer's base URL is read from its status file under
// <cfg.home>/ui-fittings/capture-service.json, so nothing here pins a port. The
// home is the one the config was loaded with (the runner-projected
// GARRISON_HOME), never re-read from process.env behind the config's back.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { underTestRunner } from "./notify.mjs";

export const CAPTURE_FITTING_ID = "capture-service";
export const INGEST_PATH = "/capture/ingest/text";
// The webhook has already been acked when this fires, so the budget is about
// not piling up sockets against a wedged peer, not about the wearer waiting.
export const DEFAULT_TIMEOUT_MS = 3000;
// One warning per failure reason per minute: an outage would otherwise write a
// line per segment batch, and Omi delivers several a second while speaking.
const WARN_EVERY_MS = 60_000;

// Omi's wire shape -> the ingest contract. Only the fields the contract names
// travel; `speakerId` and anything else Omi adds stays behind. A segment
// without text carries nothing worth forwarding.
export function toCaptureSegments(segments) {
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const text = typeof seg?.text === "string" ? seg.text.trim() : "";
    if (!text) continue;
    const mapped = { text };
    if (typeof seg.speaker === "string" && seg.speaker) mapped.speaker = seg.speaker;
    if (typeof seg.is_user === "boolean") mapped.is_user = seg.is_user;
    if (Number.isFinite(seg.start)) mapped.start = seg.start;
    if (Number.isFinite(seg.end)) mapped.end = seg.end;
    out.push(mapped);
  }
  return out;
}

function readStatusUrl(file) {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return typeof doc.url === "string" && doc.url.length ? doc.url : null;
  } catch {
    return null;
  }
}

// Where the voice layer's status file lives for THIS config. A test process
// whose config fell back to the real ~/.garrison gets nothing: a sandboxed run
// must never discover, and forward speech to, the live voice layer.
export function captureStatusFile(cfg, env = process.env) {
  const home = typeof cfg?.home === "string" ? cfg.home.trim() : "";
  if (!home) return null;
  if (home === path.join(os.homedir(), ".garrison") && underTestRunner(env)) return null;
  return path.join(home, "ui-fittings", `${CAPTURE_FITTING_ID}.json`);
}

export class RealtimeForwarder {
  constructor({
    cfg,
    counters,
    log = console,
    fetchImpl = fetch,
    statusFile = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    now = () => Date.now()
  }) {
    this.cfg = cfg;
    this.counters = counters;
    this.log = log;
    this.fetchImpl = fetchImpl;
    // An explicit status file path wins (tests point it at a stub); otherwise
    // the file is derived from cfg.home, guarded so a process that never named
    // a GARRISON_HOME cannot reach a LIVE voice layer. Resolved per call, not
    // here: the file appears when the voice layer starts, which may be later.
    this.statusFile = statusFile;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.now = now;
    this.lastWarnAt = new Map();
    // Per-session promise chains: Omi delivers several batches a second while
    // speaking and the webhook fires push() without awaiting it, so without a
    // chain two batches of one session race each other to the voice layer and
    // can land out of order. One chain per session keeps the order the wearer
    // spoke in; different sessions still forward concurrently.
    this.chains = new Map();
    // The last delivery that did not land, for /health: readiness() is otherwise
    // computed from config alone and would read "forwarding" through a peer that
    // rejects every batch.
    this.lastFailure = null;
    // Outcomes are ordered by a counter, not the clock: two batches can settle
    // in one millisecond and the LATER outcome is the one /health must show.
    this.outcomeSeq = 0;
    this.lastSuccessSeq = 0;
  }

  token() {
    return (this.cfg?.secrets?.captureToken || "").trim();
  }

  captureUrl() {
    const file = this.statusFile ?? captureStatusFile(this.cfg, this.env);
    const url = file ? readStatusUrl(file) : null;
    return url ? url.replace(/\/$/, "") : null;
  }

  // What /health and the status page show beside the "Realtime forward" row.
  // Ordered by what the operator would fix first.
  readiness() {
    if (!this.cfg?.wakeEnabled) return { ok: false, reason: "wake_enabled off - segments counted and dropped" };
    if (!this.token()) return { ok: false, reason: "CAPTURE_TOKEN unset in the vault - forwarding skipped" };
    const url = this.captureUrl();
    if (!url) return { ok: false, reason: `${CAPTURE_FITTING_ID} not running (no status file url)` };
    if (this.lastFailure && this.lastFailure.seq > this.lastSuccessSeq) {
      return {
        ok: false,
        reason: `${CAPTURE_FITTING_ID} rejected the last forward (${this.lastFailure.reason}) - segments counted and dropped until it accepts again`
      };
    }
    return { ok: true, reason: `forwarding to ${CAPTURE_FITTING_ID}` };
  }

  warn(reason, detail) {
    const at = this.now();
    const last = this.lastWarnAt.get(reason) ?? 0;
    if (at - last < WARN_EVERY_MS) return;
    this.lastWarnAt.set(reason, at);
    this.log.warn?.(`[omi-channel] realtime forward ${reason}: ${detail}`);
  }

  // Fire-and-forget from the webhook handler: never throws, never blocks the
  // ack. Batches of one session go out in the order they arrived (see
  // `chains`); the returned promise settles when THIS batch has been dealt
  // with, so a caller that does await it gets the ordered outcome.
  push({ sessionId, segments }) {
    const key = String(sessionId);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.send({ sessionId: key, segments }));
    this.chains.set(key, next);
    next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  // One batch to the voice layer. Never throws: failures are counted and
  // warned about by SHAPE only, and the latest one is kept for readiness().
  async send({ sessionId, segments }) {
    const mapped = toCaptureSegments(segments);
    if (mapped.length === 0) return;
    const token = this.token();
    if (!token) {
      this.counters.bump("realtime_forward_skipped");
      this.warn("skipped", "CAPTURE_TOKEN unset (fail closed, nothing sent)");
      return;
    }
    const base = this.captureUrl();
    if (!base) {
      this.fail("failed", `${CAPTURE_FITTING_ID} status file has no url - is the voice layer running?`, "no status file url");
      return;
    }
    try {
      const res = await this.fetchImpl(`${base}${INGEST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ source: "omi", session_id: String(sessionId), segments: mapped }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!res.ok) {
        this.fail(`http-${res.status}`, `${CAPTURE_FITTING_ID} answered HTTP ${res.status} (segments=${mapped.length})`, `HTTP ${res.status}`);
        return;
      }
      this.lastSuccessSeq = ++this.outcomeSeq;
      this.counters.bump("realtime_forwarded");
      this.counters.bump("realtime_forward_segments", mapped.length);
    } catch (err) {
      const why = err?.name === "TimeoutError" ? "timed out" : err?.message ?? String(err);
      this.fail("failed", `${why} (segments=${mapped.length})`, why);
    }
  }

  // A batch that did not land: counted, warned about (rate-limited by reason)
  // and remembered for readiness(). `reason` is a short operator-facing phrase
  // ("HTTP 401", "timed out"); it never carries speech.
  fail(warnKey, detail, reason) {
    this.counters.bump("realtime_forward_failed");
    this.lastFailure = { seq: ++this.outcomeSeq, at: this.now(), reason };
    this.warn(warnKey, detail);
  }
}

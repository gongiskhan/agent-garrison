// The spoken-acknowledgement sink (spec §5, M5b) — POST /ack consumer.
//
// Order is load-bearing (§2.5): the echo fingerprint is registered BEFORE
// the phone is told to speak, or the suppression window opens too late and
// the app's own voice comes back as conversation. Then:
//
//   speak lane   a live AUDIO-mode session with a connected socket gets
//                {type:"speak", ack} (screen_audio never speaks in-session —
//                the broadcast extension's mic has no AEC coupling to the
//                app's speaker, ADR §6); the app answers {spoken, ok, reason}
//                so a silently-dropping sink is distinguishable from an off
//                one. The queue ceiling and staleness window are the APP's
//                (§5b) — the server forwards and keeps receipts.
//   push lane    otherwise the ack falls through to APNs via the notifier,
//                sharing the notification's idempotencyKey so a sink that
//                saw both speaks/buzzes only once.
//
// The ack `text` is pre-rendered and pre-validated upstream (wake-word check,
// referent rule) — this sink never composes sentences (I11 stays upstream
// too: acks only exist for post-persistence outcomes). The server-side ack
// log keeps ids and outcomes, never text (I5 discipline).

import path from "node:path";
import { speechChunks } from "./tts.mjs";
import { confidentSpeech } from "./speech-input.mjs";
import { appendFileSync, mkdirSync } from "node:fs";

const SPEAK_RECEIPT_TIMEOUT_MS = 30_000; // default; cfg.speakReceiptTimeoutMs overrides (tests)

// Burst control for error pushes (2026-08-18: ~30 failures in 60 s put ~30
// buzzes on the phone). The rules, in order of what matters:
//   1. the FIRST error of a kind always goes through, immediately;
//   2. a REPEAT of the same subject inside the window never buzzes again —
//      one flapping card cannot drown a different real failure;
//   3. once a burst exceeds the ceiling, further distinct errors are counted
//      and delivered as ONE summary when the window closes.
const BURST_WINDOW_MS = 5 * 60_000;
const BURST_CEILING = 3; // distinct error pushes per window before collapsing

export class AckSink {
  constructor({ cfg, store, counters, echoGuard, ingress, notifier, voice = null, languageMemory = null, log = console, now = () => Date.now() }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.echoGuard = echoGuard;
    this.ingress = ingress;
    this.notifier = notifier;
    this.log = log;
    this.now = now;
    this.voice = voice;
    this.languageMemory = languageMemory;
    this.interimSpeech = new Map();
    this.onInterrupt = null;
    this.pendingSpeaks = new Map(); // ack id -> {sentAt, sessionId, timer}
    this.replyClaims = new Map();
    this.ackDeliveries = new Map();
    // Fired when a forwarded speak gets NO receipt inside the window. A socket
    // send is not delivery - the app can be suspended with the socket looking
    // open - and 26 of 44 speaks timing out in one day is what "I didn't get a
    // reply" looks like from the server. The capture-service uses this to fall
    // back to a real push.
    this.onSpeakTimeout = null;
    // sessionId -> epoch ms until which it is skipped for speech.
    this.mutedSessions = new Map();
    // In-memory on purpose: a restart is exactly when the operator should hear
    // the next failure again, and the window is minutes, not days.
    this.burst = { startedAt: 0, pushed: 0, suppressed: 0, subjects: new Map(), timer: null };
  }

  // Decide whether THIS error ack may buzz. Returns null to allow, or a
  // reason string to suppress (already counted into the pending summary).
  burstVerdict(ack) {
    const now = this.now();
    const b = this.burst;
    if (now - b.startedAt > BURST_WINDOW_MS) {
      b.startedAt = now;
      b.pushed = 0;
      b.suppressed = 0;
      b.subjects.clear();
    }
    // Same subject repeating: the operator already knows.
    const subject = String(ack.templateId ?? "") + "|" + String(ack.text ?? "").slice(0, 120);
    if (b.subjects.has(subject)) {
      b.suppressed += 1;
      this.counters.bump("notify_burst_repeat_suppressed");
      this.scheduleBurstSummary();
      return "repeat within burst window";
    }
    b.subjects.set(subject, now);
    if (b.pushed >= BURST_CEILING) {
      b.suppressed += 1;
      this.counters.bump("notify_burst_suppressed");
      this.scheduleBurstSummary();
      return `burst ceiling ${BURST_CEILING} reached`;
    }
    b.pushed += 1;
    return null;
  }

  // One summary when the window closes, so a suppressed burst is never a
  // silent one. Interactive priority: it answers real failures.
  scheduleBurstSummary() {
    const b = this.burst;
    if (b.timer) return;
    const delay = Math.max(1000, BURST_WINDOW_MS - (this.now() - b.startedAt));
    b.timer = setTimeout(() => {
      b.timer = null;
      const count = b.suppressed;
      b.suppressed = 0;
      if (count <= 0) return;
      this.counters.bump("notify_burst_summaries");
      void this.notifier
        .deliver({
          title: "Zeca - problems",
          body: count === 1 ? "1 more problem needs you." : `${count} more problems need you.`,
          link: null,
          tag: "ack",
          priority: "interactive"
        })
        .catch(() => []);
    }, delay);
    b.timer.unref?.();
  }

  logAck(entry) {
    const file = path.join(this.store.root, "acks-log.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n");
  }

  // A live audio-mode session whose socket is currently connected. The most
  // recently active session wins when several are live (rare on one phone).
  // The session that can actually be HEARD right now.
  //
  // This used to return the FIRST match in Map insertion order while its own
  // comment claimed "the most recently active session wins". Those differ the
  // moment a phone reconnects without ending the old session - which is every
  // app restart - and the loser is silence: a TCP socket to a dead app still
  // reports readyState OPEN, so every line went to the oldest corpse and timed
  // out. Live evidence: 104 speaks forwarded, 23 confirmed, 78 receipt
  // timeouts, with sessions from two days earlier still in the map.
  //
  // So: newest first, and a session that has recently failed to answer is
  // skipped rather than being chosen again and again.
  speakableSession(sessionId = null) {
    if (!this.cfg.speakEnabled) return null;
    const candidates = [];
    for (const session of this.ingress.sessions.values()) {
      // "audio" is the companion mic; "pendant" is the wearable. Both are the
      // same phone with the same speaker, and the wearer of a pendant is
      // exactly who wants to be answered out loud - excluding it meant Zeca
      // could not talk to the one session that listens all day. screen_audio
      // is still excluded (ADR section 6).
      if (sessionId && session.record.id !== sessionId) continue;
      const speakableMode = session.record.mode === "audio" || session.record.mode === "pendant";
      if (!speakableMode) continue;
      if (session.record.ended) continue;
      if (!session.socket || session.socket.readyState !== session.socket.OPEN) continue;
      if ((this.mutedSessions.get(session.record.id) ?? 0) > this.now()) continue;
      candidates.push(session);
    }
    if (candidates.length === 0) return null;
    // Newest wins. started_at is an ISO string on the record; ids are ULIDs and
    // sort the same way, so either ordering agrees.
    candidates.sort((a, b) => String(b.record.started_at ?? b.record.id).localeCompare(String(a.record.started_at ?? a.record.id)));
    if (candidates.length > 1) this.counters.bump("speakable_sessions_multiple");
    return candidates[0];
  }

  // A session that did not answer a speak is sidelined briefly, so one dead
  // socket cannot swallow every line while a live session sits behind it.
  muteSession(sessionId, forMs = 60_000) {
    if (!sessionId) return;
    this.mutedSessions.set(sessionId, this.now() + forMs);
    for (const [id, until] of this.mutedSessions) if (until <= this.now()) this.mutedSessions.delete(id);
  }

  // The native sink and the visible page watch the same reply. Claim before
  // any await; content/language must not be used as a reply identity.
  claimReply(key, owner) {
    if (!key) return true;
    const cutoff = this.now() - 10 * 60_000;
    for (const [id, claim] of this.replyClaims) if (claim.at < cutoff) this.replyClaims.delete(id);
    if (this.replyClaims.has(key)) return false;
    if (owner === "page" && this.speakableSession()) return false;
    this.replyClaims.set(key, { owner, at: this.now() });
    while (this.replyClaims.size > 200) this.replyClaims.delete(this.replyClaims.keys().next().value);
    return true;
  }

  async handleAck(ack) {
    if (!ack || typeof ack !== "object" || typeof ack.text !== "string" || ack.text.trim() === "") {
      return { status: 400, body: { error: "ack.text is required" } };
    }
    // Retries must not speak a second time, even when they arrive mid-render.
    const key = ack.idempotencyKey || ack.id;
    const cutoff = this.now() - 10 * 60_000;
    for (const [id, entry] of this.ackDeliveries) if (entry.at < cutoff) this.ackDeliveries.delete(id);
    if (key && this.ackDeliveries.has(key)) return this.ackDeliveries.get(key).work;
    const work = this.deliverAck(ack);
    if (key) {
      this.ackDeliveries.set(key, { at: this.now(), work });
      while (this.ackDeliveries.size > 200) this.ackDeliveries.delete(this.ackDeliveries.keys().next().value);
    }
    return work;
  }

  async deliverAck(ack) {
    // Output is not a language observation: an unrelated English card update
    // must not turn the next Portuguese wake cue into "Yes?".
    // 1. Echo window opens FIRST — before any speak instruction leaves.
    const registered = this.echoGuard.register({ text: ack.text, echo: ack.echo ?? null });
    this.counters.bump("acks_in");

    // 2. Speak lane.
    const session = this.speakableSession(ack.sessionId ?? null);
    if (session) {
      try {
        // Zeca's own voice when one can be rendered, the phone's synthesizer
        // otherwise. clipFor NEVER throws and returns null on any failure, so
        // the acknowledgement is never held hostage to the nicety - the phone
        // just speaks it itself, exactly as it always did.
        const chunks = speechChunks(ack.text);
        const chunked = session.speechProtocol === 1 && chunks.length > 1;
        const audioChunks = chunked ? [] : null;
        if (audioChunks) {
          // Bound provider concurrency when a reply spans many clips.
          for (let i = 0; i < chunks.length; i += 2) {
            audioChunks.push(...await Promise.all(chunks.slice(i, i + 2).map(async text => {
              const clip = this.voice ? await this.voice.clipFor(text, { lang: ack.lang ?? null }) : null;
              return { text, audioPath: clip ? `/speak/${clip.id}.mp3` : null };
            })));
          }
        }
        const clip = !chunked && this.voice ? await this.voice.clipFor(ack.text, { lang: ack.lang ?? null }) : null;
        const speak = audioChunks ? { ...ack, audioChunks } : clip ? { ...ack, audioPath: `/speak/${clip.id}.mp3` } : ack;
        // The echo-guard fingerprint and the receipt timer must expire together:
        // a longer wait for the phone's receipt with a shorter echo-suppression
        // window means the tail of a slow reply escapes suppression the moment
        // the guard's window closes first (2026-09-09 echo diagnosis).
        const receiptTimeoutMs = this.cfg.speakReceiptTimeoutMs ?? Math.min(200_000, Math.max(SPEAK_RECEIPT_TIMEOUT_MS, ack.text.split(/\s+/).length * 700 + 30_000));
        // Never shorter than the old flat 120s default - the receipt-timer
        // formula's floor (30s) is far too tight a fingerprint window for a
        // short ack; only stretch it past 120s when the formula asks for more.
        this.echoGuard.startPlayback(ack.id, ack.text, { ttlMs: Math.max(120_000, receiptTimeoutMs) });
        session.socket.send(JSON.stringify({ type: "speak", ack: speak }));
        this.counters.bump("speaks_forwarded");
        const timer = setTimeout(() => {
          const pending = this.pendingSpeaks.get(ack.id);
          if (this.pendingSpeaks.delete(ack.id)) {
            this.echoGuard.finishPlayback(ack.id);
            this.counters.bump("speak_receipt_timeouts");
            // It did not answer: stop choosing it for a while.
            this.muteSession(pending?.sessionId);
            try {
              this.onSpeakTimeout?.(ack.id);
            } catch (err) {
              this.log.error(`[capture-service] speak-timeout hook failed: ${err?.message ?? err}`);
            }
          }
        }, receiptTimeoutMs);
        timer.unref?.();
        this.pendingSpeaks.set(ack.id, { sentAt: this.now(), sessionId: session.record.id, timer });
        this.logAck({
          id: ack.id,
          kind: ack.kind ?? null,
          severity: ack.severity ?? null,
          templateId: ack.templateId ?? null,
          via: "socket",
          sessionId: session.record.id,
          at: new Date(this.now()).toISOString()
        });
        return { status: 200, body: { ok: true, registered, delivered: "socket" } };
      } catch (err) {
        this.echoGuard.finishPlayback(ack.id);
        this.counters.bump("speak_forward_failed");
        this.log.error(`[capture-service] speak forward failed: ${err?.message ?? err}`);
        // fall through to push
      }
    }

    // 3. Push lane — for ERRORS only. Routine info acks (the operative's
    // created/completed chatter fanned out from the board) go to the
    // web-channel thread and never buzz the phone: 2026-08-15 they burned the
    // whole daily push budget by mid-afternoon (69 pushes), which then
    // starved the pushes answering the user's own spoken commands. When a
    // session is live they are still SPOKEN (lane 2, above).
    const burstReason = ack.severity === "error" ? this.burstVerdict(ack) : null;
    const wantsPush = ack.severity === "error" && !burstReason;
    const receipts = ack.idempotencyKey && this.notifier.alreadyDelivered(ack.idempotencyKey)
      ? [{ means: "companion-push", ok: true, deduplicated: true }]
      : wantsPush
        ? await this.notifier.deliver({
            title: "Zeca - problem",
            body: ack.text,
            link: null,
            tag: "ack"
          })
        : [
            {
              means: "companion-push",
              ok: false,
              skipped: burstReason ?? "routine ack (web-channel only)"
            },
            await this.notifier.sendWebChannelFallback(ack.text)
          ];
    if (ack.idempotencyKey && receipts.some((r) => r.ok)) this.notifier.markDelivered(ack.idempotencyKey);
    const via = wantsPush || receipts.some((r) => r.deduplicated) ? "push" : "web-channel";
    this.logAck({
      id: ack.id,
      kind: ack.kind ?? null,
      severity: ack.severity ?? null,
      templateId: ack.templateId ?? null,
      via,
      receipts: receipts.map((r) => ({ means: r.means, ok: r.ok, skipped: r.skipped ?? null })),
      at: new Date(this.now()).toISOString()
    });
    return { status: 200, body: { ok: true, registered, delivered: via, receipts } };
  }

  // Only recognized, non-echo speech from this playback's own capture stream
  // may interrupt it. Interim text must remain stable across two observations.
  considerInterruption(sessionId, segment) {
    const session = this.ingress.sessions.get(sessionId);
    if (session?.speechProtocol !== 1) return false;
    const pending = [...this.pendingSpeaks].filter(([, value]) => value.sessionId === sessionId);
    if (!pending.length) { this.interimSpeech.delete(sessionId); return false; }
    if (!confidentSpeech(segment, { interim: !segment.final })) return false;
    if (!segment.final) {
      const words = String(segment.text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      const previous = this.interimSpeech.get(sessionId);
      if (!previous || previous.start !== segment.start || !words.join(" ").startsWith(previous.words)) {
        this.interimSpeech.set(sessionId, { start: segment.start, words: words.join(" "), at: this.now() });
        return false;
      }
      if (this.now() - previous.at < 250) return false;
    }
    this.interimSpeech.delete(sessionId);
    const ids = pending.map(([id]) => id);
    try { session.socket.send(JSON.stringify({ type: "speech.interrupt", ack_ids: ids })); }
    catch { return false; }
    for (const [id, value] of pending) {
      clearTimeout(value.timer);
      this.pendingSpeaks.delete(id);
      this.echoGuard.finishPlayback(id);
      this.onInterrupt?.(id, sessionId);
    }
    this.counters.bump("speech_interruptions");
    this.log.log(`[capture-service] speech interrupted by recognized input (${ids.length} playback)`);
    return true;
  }

  // {spoken: <ack id>, ok, reason?} from the app over the session socket.
  handleSpokenReceipt(msg, sessionId = null) {
    const pending = this.pendingSpeaks.get(msg.spoken);
    if (pending && sessionId && pending.sessionId !== sessionId) return false;
    if (!pending) {
      this.counters.bump("speak_receipts_unknown");
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingSpeaks.delete(msg.spoken);
    this.echoGuard.finishPlayback(msg.spoken);
    if (msg.ok) {
      this.counters.bump("speaks_confirmed");
      this.counters.observe("speak_confirm_ms", this.now() - pending.sentAt);
      // WHICH voice actually spoke. "ok" alone cannot tell Diogo from a system
      // voice reading Portuguese in Brazilian - they are both a success, which
      // is precisely how a Brazilian-sounding assistant went unnoticed for
      // days. The reason is a short enum-ish string, never content.
      const via = String(msg.reason ?? "").trim();
      if (via === "clip") this.counters.bump("speaks_via_clip");
      else if (via.startsWith("synth")) {
        this.counters.bump("speaks_via_synth");
        this.counters.bump(`speaks_via_${via.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40)}`);
        this.log.log(`[capture-service] speak ${msg.spoken} used the phone's own voice (${via})`);
      }
    } else {
      this.counters.bump("speaks_failed");
      // Reason is a short enum-ish string from the app (muted, interrupted,
      // synth-error) — no content.
      this.log.log(`[capture-service] speak ${msg.spoken} not spoken: ${msg.reason ?? "unknown"}`);
    }
    return true;
  }
}

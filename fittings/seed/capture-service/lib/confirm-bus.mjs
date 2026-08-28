// "Vou enviar à Marília: é melhor amanhã. Diz cancela para parar."
//
// A message aimed at a person is irreversible in the way a card is not, and a
// spoken command can pick the wrong person - a misheard name, or (once screen
// context lands) a referent read off a screenshot. So the send is ANNOUNCED
// out loud with the recipient AND the text, and the wearer can stop it by
// saying "cancela" - no wake word, because they are answering a prompt rather
// than issuing a command.
//
// This owns NO timer and NO parked-send record. whatsapp-web's outbox already
// holds the send, re-arms it after a crash, flips it exactly once, and answers
// honestly after the window has elapsed. A second copy of that here would
// eventually disagree with it about whether a message went out, which is the
// one bug this whole mechanism exists to prevent. So: poll its documented
// /outbox, announce what is parked, and POST its cancel.
//
// The arming order is the subtle part. The announcement CONTAINS the word
// "cancela", the pendant hears it a beat later, and one word is below
// EchoGuard's MIN_TOKENS floor - so a naive listener would cancel the send it
// just announced. The cancel window therefore opens only once the phone
// reports the announcement SPOKEN, with a short fallback for the push lane.

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ulid } from "./store.mjs";
import { t } from "./lang.mjs";
import { wakeRegex } from "./wake.mjs";

export function whatsappBase(env = process.env) {
  try {
    const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const doc = JSON.parse(readFileSync(path.join(home, "ui-fittings", "whatsapp-web.json"), "utf8"));
    const url = typeof doc?.url === "string" ? doc.url.trim().replace(/\/$/, "") : "";
    return url || null;
  } catch {
    return null;
  }
}

export class ConfirmBus {
  constructor({ cfg, counters, ackSink = null, languageMemory = null, log = console, fetchImpl = fetch, now = () => Date.now(), env = process.env }) {
    this.cfg = cfg;
    this.counters = counters;
    this.ackSink = ackSink;
    this.languageMemory = languageMemory;
    this.log = log;
    this.fetch = fetchImpl;
    this.now = now;
    this.env = env;
    this.pending = new Map(); // outbox id -> { armed, expiresAt, summary }
    this.announced = new Set();
    this.contacts = null; // { at, byJid }
    this.pollTimer = null;
    this.watchUntil = 0;
    this.cancelRegex = wakeRegex(cfg.cancelVariants ?? []);
  }

  enabled() {
    return Boolean(this.cfg.confirmEnabled) && Boolean(this.ackSink);
  }

  base() {
    return whatsappBase(this.env);
  }

  // Armed only while the user has just told Zeca to do something - never a
  // standing poller.
  watch() {
    if (!this.enabled()) return;
    this.watchUntil = this.now() + (this.cfg.confirmWatchMs ?? 90000);
    if (this.pollTimer) return;
    const tick = async () => {
      try {
        await this.poll();
      } catch (err) {
        this.counters?.bump?.("confirm_poll_failed");
        this.log?.error?.(`[capture-service] confirm poll failed: ${err?.message ?? err}`);
      }
      if (this.now() < this.watchUntil || this.pending.size > 0) {
        this.pollTimer = setTimeout(tick, this.cfg.confirmPollMs ?? 1000);
        this.pollTimer.unref?.();
      } else {
        this.pollTimer = null;
      }
    };
    this.pollTimer = setTimeout(tick, 0);
    this.pollTimer.unref?.();
  }

  stop() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  // A phone number read aloud is not a confirmation. Cached briefly - the
  // announcement has to be fast, and contact names do not move.
  async displayName(jid) {
    const base = this.base();
    if (!base || !jid) return jid ?? "";
    if (!this.contacts || this.now() - this.contacts.at > 60_000) {
      try {
        const res = await this.fetch(`${base}/contacts?n=500`, { signal: AbortSignal.timeout(3000) });
        const data = await res.json().catch(() => ({}));
        const list = Array.isArray(data?.contacts) ? data.contacts : [];
        this.contacts = { at: this.now(), byJid: new Map(list.map((c) => [c?.id ?? c?.jid, c?.name])) };
      } catch {
        this.contacts = { at: this.now(), byJid: new Map() };
      }
    }
    return this.contacts.byJid.get(jid) || jid;
  }

  async poll() {
    const base = this.base();
    if (!base) return;
    const res = await this.fetch(`${base}/outbox`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const pending = Array.isArray(data?.pending) ? data.pending : [];
    const live = new Set(pending.map((e) => e.id));
    for (const id of [...this.pending.keys()]) {
      if (!live.has(id)) {
        this.pending.delete(id);
        this.counters?.bump?.("confirm_expired");
      }
    }
    for (const entry of pending) {
      if (this.announced.has(entry.id)) continue;
      this.announced.add(entry.id);
      await this.announce(entry);
    }
  }

  async announce(entry) {
    const lang = this.languageMemory?.current() ?? "pt";
    const recipient = await this.displayName(entry.to);
    const text = t("send.queued", { recipient, body: entry.preview }, lang);
    const ackId = `confirm-${entry.id}`;
    this.pending.set(entry.id, {
      armed: false,
      expiresAt: Date.parse(entry.executeAt) || this.now() + 60_000,
      ackId
    });
    this.counters?.bump?.("confirm_announced");
    // Armed by the spoken receipt (see onSpoken); this is the push-lane
    // fallback, so a send announced without a live socket is still cancellable.
    const fallback = setTimeout(() => this.arm(entry.id), this.cfg.confirmArmDelayMs ?? 1500);
    fallback.unref?.();
    await this.ackSink
      ?.handleAck({ id: ackId, kind: "captured", severity: "info", templateId: "outbound_confirm", text, lang })
      .catch(() => null);
  }

  arm(outboxId) {
    const p = this.pending.get(outboxId);
    if (p) p.armed = true;
  }

  // Called from the app's {type:"spoken"} receipt. The announcement has now
  // actually left the speaker, so anything the microphone hears next is the
  // user, not us.
  onSpoken(ackId) {
    for (const [id, p] of this.pending) if (p.ackId === ackId) p.armed = true;
  }

  // -> true when this segment was a cancellation and must not travel further.
  // Checked BEFORE the wake gate and before any discussion branch: someone
  // answering a prompt is answering, not commanding.
  consumeSegment(sessionId, text) {
    if (!this.enabled() || this.pending.size === 0 || !this.cancelRegex) return false;
    const trimmed = String(text ?? "").trim();
    if (!trimmed || !this.cancelRegex.test(trimmed)) return false;
    const armed = [...this.pending.entries()].filter(([, p]) => p.armed && this.now() < p.expiresAt);
    if (armed.length === 0) return false;
    // An unqualified "cancela" with several windows open cancels ALL of them
    // and says so, rather than silently picking one.
    void this.cancelAll(armed.map(([id]) => id));
    return true;
  }

  async cancelAll(ids) {
    const base = this.base();
    const lang = this.languageMemory?.current() ?? "pt";
    let cancelled = 0;
    let alreadySent = 0;
    for (const id of ids) {
      this.pending.delete(id);
      try {
        const res = await this.fetch(`${base}/outbox/${encodeURIComponent(id)}/cancel`, {
          method: "POST",
          signal: AbortSignal.timeout(3000)
        });
        if (res.ok) cancelled += 1;
        else if (res.status === 409) alreadySent += 1;
      } catch (err) {
        this.log?.error?.(`[capture-service] cancel failed: ${err?.message ?? err}`);
      }
    }
    if (cancelled > 0) this.counters?.bump?.("confirm_cancelled");
    if (alreadySent > 0) this.counters?.bump?.("confirm_cancel_after_send");
    const key = cancelled > 0 ? "send.cancelled" : "send.already_sent";
    await this.ackSink
      ?.handleAck({ id: `cancel-${ulid()}`, kind: "captured", severity: "info", templateId: "outbound_cancel", text: t(key, {}, lang), lang })
      .catch(() => null);
  }
}

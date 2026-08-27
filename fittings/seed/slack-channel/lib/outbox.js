'use strict';

// Outbound delay buffer — the cancel window that turns an irreversible send
// into one that is revertible in practice.
//
// COPY. The canonical implementation is
// fittings/seed/whatsapp-web/lib/outbox.mjs; this is that file in CommonJS (the
// module system the rest of this Fitting uses) plus the Slack-shaped request
// handlers at the bottom. Cross-fitting imports are forbidden, so a fix in one
// has to be carried to the other by hand.
//
// A send an AGENT triggered is PARKED, not sent: the entry lands in
// $GARRISON_HOME/slack-channel/outbox.json with an executeAt, and the real
// chat.postMessage runs only when that window elapses uncancelled. That is the
// whole reason an autonomy band may ever grant act-without-asking on an
// outbound message — fittings/seed/orchestrator/lib/routing-autonomy.mjs gates
// an irreversible action on it staying revertible.
//
// The drain has to live in a LONG-LIVED process. scripts/connector.mjs exits in
// milliseconds, so it cannot hold the timer; the adapter (scripts/slack-adapter.js)
// is the process that mounts these handlers and re-arms what is still pending
// on start.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { clampText } = require('./outbound.js');

// Copied from fittings/seed/orchestrator/lib/routing-autonomy.mjs, where the
// reversibility taxonomy declares it (OUTBOUND_DELAY_SECONDS = 60). The two
// values must move together.
const OUTBOUND_DELAY_SECONDS = 60;

const TERMINAL = new Set(['sent', 'cancelled', 'failed']);
const KEEP_TERMINAL = 200;
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Where a call came from. Only "human" — a person acting in a UI, marked by
 * that UI's process and never by an argument the caller types — skips the
 * buffer. An unmarked caller counts as an agent and is buffered: the same
 * unknown-is-unsafe default reversibilityOf() applies. GARRISON_AUTOMATION_ENGINE
 * is set on every connector child the Automations engine spawns (see
 * fittings/seed/automations/lib/engine.mjs defaultRunConnector).
 */
function resolveSendContext(env = {}) {
  // The engine's marker is checked FIRST and cannot be talked out of: an
  // automation that inherited GARRISON_SEND_CONTEXT from somewhere must not be
  // able to present itself as a human.
  if (env.GARRISON_AUTOMATION_ENGINE) return 'automation';
  const explicit = String(env.GARRISON_SEND_CONTEXT ?? '').trim().toLowerCase();
  if (explicit === 'human' || explicit === 'agent' || explicit === 'automation') return explicit;
  return 'agent';
}

class Outbox {
  /**
   * groupKey(entry) -> string names the destination a send is addressed to. Set
   * it only in a Fitting whose transport rate-limits per destination and whose
   * messages can legitimately be merged (Slack: ~1 message/second/channel).
   * Left null, every entry sends on its own — which is what a transport with
   * human-pacing discipline (whatsapp-web) requires.
   */
  constructor({
    file,
    send,
    delaySeconds = OUTBOUND_DELAY_SECONDS,
    groupKey = null,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = () => {}
  }) {
    this.file = file;
    this.send = send;
    this.delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    this.groupKey = groupKey;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    this.timers = new Map();
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
    } catch {
      // Missing or corrupt: an empty buffer is always the safe reading — it can
      // only ever fail to send, never send something twice.
      return [];
    }
  }

  write(entries) {
    const cutoff = this.now() - TERMINAL_TTL_MS;
    const live = entries.filter((e) => !TERMINAL.has(e.status) || Date.parse(e.settledAt ?? '') >= cutoff);
    const terminal = live.filter((e) => TERMINAL.has(e.status));
    const kept =
      terminal.length > KEEP_TERMINAL
        ? live.filter((e) => !TERMINAL.has(e.status)).concat(terminal.slice(-KEEP_TERMINAL))
        : live;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: kept }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return kept;
  }

  get(id) {
    return this.read().find((e) => e.id === id) ?? null;
  }

  pending() {
    return this.read().filter((e) => e.status === 'pending');
  }

  /** Park a send. Returns the record; the caller answers the agent with it. */
  enqueue({ action, payload, summary = '', context = 'agent' }) {
    const at = this.now();
    const entry = {
      id: `ob_${at.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      action: String(action),
      payload,
      summary: String(summary).slice(0, 300),
      context,
      status: 'pending',
      queuedAt: new Date(at).toISOString(),
      executeAt: new Date(at + this.delayMs).toISOString(),
      settledAt: null,
      result: null,
      error: null
    };
    this.write(this.read().concat(entry));
    this.schedule(entry);
    return entry;
  }

  schedule(entry) {
    if (this.timers.has(entry.id)) return;
    const delay = Math.max(0, Date.parse(entry.executeAt) - this.now());
    const timer = this.setTimer(() => {
      this.timers.delete(entry.id);
      this.fire(entry.id).catch((err) => this.log(`outbox ${entry.id}: ${(err && err.message) || err}`));
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.timers.set(entry.id, timer);
  }

  /**
   * Execute one parked send, exactly once. The pending -> sending flip is
   * written BEFORE the await, so a second timer for the same id (a double
   * schedule, a re-arm racing a live timer) finds it already claimed.
   *
   * With a groupKey, everything else already DUE for the same destination is
   * claimed in the same pass and handed to send() together, so a fitting whose
   * transport rate-limits per destination can deliver one message instead of a
   * burst. An entry whose own window has not elapsed is never pulled in early —
   * that would spend someone else's cancel window.
   */
  async fire(id) {
    const entries = this.read();
    const entry = entries.find((e) => e.id === id);
    if (!entry || entry.status !== 'pending') return entry ?? null;
    const at = this.now();
    const key = this.groupKey ? this.groupKey(entry) : null;
    const claimed = [entry];
    if (key !== null && key !== undefined) {
      for (const other of entries) {
        if (other === entry || other.status !== 'pending') continue;
        if (Date.parse(other.executeAt) > at) continue;
        if (this.groupKey(other) !== key) continue;
        claimed.push(other);
      }
    }
    for (const claim of claimed) claim.status = 'sending';
    this.write(entries);
    // The batched-in entries must not fire again on their own timers.
    for (const claim of claimed) this.unschedule(claim.id);
    let settled;
    try {
      settled = { status: 'sent', result: (await this.send(entry, claimed)) ?? null, error: null };
    } catch (err) {
      settled = { status: 'failed', result: null, error: String((err && err.message) || err) };
    }
    this.settle(claimed.map((claim) => claim.id), settled);
    return this.get(id);
  }

  unschedule(id) {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    this.clearTimer(timer);
    this.timers.delete(id);
  }

  settle(ids, patch) {
    const wanted = Array.isArray(ids) ? ids : [ids];
    const entries = this.read();
    const settledAt = new Date(this.now()).toISOString();
    let found = null;
    for (const entry of entries) {
      if (!wanted.includes(entry.id)) continue;
      Object.assign(entry, patch, { settledAt });
      if (!found) found = entry;
    }
    if (!found) return null;
    this.write(entries);
    return found;
  }

  /** Idempotent. After the window it answers honestly rather than lying. */
  cancel(id) {
    const entry = this.get(id);
    if (!entry) return { ok: false, status: 'unknown', error: `no outbox entry ${id}` };
    if (entry.status === 'cancelled') return { ok: true, status: 'cancelled', entry };
    if (entry.status !== 'pending') return { ok: false, status: entry.status, error: `already ${entry.status}`, entry };
    this.unschedule(id);
    return { ok: true, status: 'cancelled', entry: this.settle(id, { status: 'cancelled' }) };
  }

  /**
   * On process start: re-arm what is still pending (an overdue entry fires
   * immediately) and fail anything a crash left mid-send. A "sending" entry may
   * already have reached Slack, and posting an irreversible message twice is
   * worse than not posting it, so it is never retried.
   */
  rearm() {
    const entries = this.read();
    let dirty = false;
    for (const entry of entries) {
      if (entry.status === 'sending') {
        Object.assign(entry, {
          status: 'failed',
          error: 'process exited mid-send; not retried',
          settledAt: new Date(this.now()).toISOString()
        });
        dirty = true;
      }
    }
    if (dirty) this.write(entries);
    const pending = entries.filter((e) => e.status === 'pending');
    for (const entry of pending) this.schedule(entry);
    return pending;
  }
}

// ---------------------------------------------------------------------------
// The Slack-shaped half: the destination a send is grouped by, how a batch
// renders, and the HTTP contract as pure request handlers — same shape as
// lib/outbound.js's notify/threadAppend, so mounting them in the adapter is a
// three-route dispatch and nothing about Slack leaks into the buffer itself.
// ---------------------------------------------------------------------------

/** The destination two parked sends have to share to be delivered together. */
function slackDestination(entry) {
  return String((entry.payload && entry.payload.channel) ?? '');
}

/**
 * One Slack message out of everything that came due for one channel at once.
 *
 * chat.postMessage is rate-limited around one message per second per channel,
 * and several buffered updates landing as a burst read worse than one message
 * anyway. A lone entry renders VERBATIM — a buffered message must arrive as the
 * sender composed it, with no decoration a direct post would not have had.
 * clampText is lib/outbound.js's, so every outbound path in this Fitting shares
 * one length budget.
 */
function renderBatch(entries) {
  const texts = entries.map((entry) => String((entry.payload && entry.payload.text) ?? '').trim()).filter(Boolean);
  return clampText(texts.join('\n\n'));
}

// Enough to decide whether to cancel, never the whole record.
function publicEntry(entry) {
  return {
    id: entry.id,
    action: entry.action,
    to: (entry.payload && entry.payload.channel) ?? null,
    preview: String((entry.payload && entry.payload.text) ?? '').slice(0, 300),
    summary: entry.summary,
    context: entry.context,
    status: entry.status,
    queuedAt: entry.queuedAt,
    executeAt: entry.executeAt
  };
}

/**
 * @param outbox   an Outbox whose send() performs the real chat.postMessage
 * @param baseUrl  this adapter's own loopback base, for a copy-pasteable cancel
 * @param announce optional async (entry) => void — the fitting's own /notify
 *                 path, so a parked send is visible where the operator is
 *                 already looking rather than only in a JSON file.
 */
function createOutboxRoutes({ outbox, baseUrl = '', announce = null, log = () => {} }) {
  function list() {
    return { status: 200, body: { ok: true, pending: outbox.pending().map(publicEntry) } };
  }

  async function enqueue(body) {
    if (!body || body.action !== 'send_message') {
      return { status: 400, body: { ok: false, error: `outbox does not carry action ${JSON.stringify(String((body && body.action) ?? ''))}` } };
    }
    const channel = String((body.payload && body.payload.channel) ?? '').trim();
    const text = String((body.payload && body.payload.text) ?? '').trim();
    if (!channel) return { status: 400, body: { ok: false, error: 'payload.channel is required' } };
    if (!text) return { status: 400, body: { ok: false, error: 'payload.text is required' } };
    const context = body.context === 'human' || body.context === 'automation' ? body.context : 'agent';
    const entry = outbox.enqueue({
      action: 'send_message',
      payload: { channel, text },
      summary: typeof body.summary === 'string' ? body.summary : `Slack to ${channel}`,
      context
    });
    if (announce) {
      // Never fatal: an unannounced parked send is still cancellable, a failed
      // announcement that swallowed the send would not be.
      try {
        await announce(entry);
      } catch (err) {
        log(`outbox: announce failed for ${entry.id}: ${(err && err.message) || err}`);
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        ...publicEntry(entry),
        delaySeconds: Math.round(outbox.delayMs / 1000),
        cancelHint: `curl -sX POST ${baseUrl}/outbox/${entry.id}/cancel`
      }
    };
  }

  function cancel(id) {
    const outcome = outbox.cancel(id);
    // Idempotent, and honest after the fact: a window that already elapsed
    // answers "sent", never a cancellation that did not happen.
    return {
      status: outcome.ok ? 200 : outcome.status === 'unknown' ? 404 : 409,
      body: { ...outcome, entry: outcome.entry ? publicEntry(outcome.entry) : null }
    };
  }

  return { list, enqueue, cancel };
}

/** The one-line announcement a parked send makes on the channel itself. */
function renderQueuedNotice(entry) {
  return {
    title: 'Message queued, not sent yet',
    text: `A message to ${(entry.payload && entry.payload.channel) ?? 'a channel'} is parked and goes out at ${entry.executeAt}. Cancel it before then and it never sends.\n\n${String((entry.payload && entry.payload.text) ?? '').slice(0, 300)}`,
    idempotencyKey: `outbox-queued:${entry.id}`
  };
}

module.exports = {
  OUTBOUND_DELAY_SECONDS,
  resolveSendContext,
  Outbox,
  publicEntry,
  slackDestination,
  renderBatch,
  createOutboxRoutes,
  renderQueuedNotice
};

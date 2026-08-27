'use strict';

// Outbound half of the Slack channel.
//
// The inbound adapter (scripts/slack-adapter.js) has always been able to POST
// to Slack - it does so for every reply to an app_mention. What it did not have
// were the two HTTP contracts the rest of Garrison uses to reach a channel
// PROACTIVELY, so every reminder, card outcome, ack and mirrored question was
// invisible on Slack:
//
//   POST /notify                       - the fan-out contract. kanban-loop's
//     fanOutNotification POSTs it to EVERY running own-port fitting it finds
//     under ~/.garrison/ui-fittings/*.json; a 404 means "not a notify-capable
//     channel". Payload: {title, text, actions[], link, tag, idempotencyKey}.
//   POST /api/threads/:id/messages     - the thread-append contract. The card
//     that a Slack message created carries originChannel {channel:"slack",
//     threadId}, and every lifecycle event for that card is posted back here.
//
// Everything in this file is transport-pure: it renders text and decides
// delivery, and calls an injected postMessage(). The adapter owns the HTTP
// plumbing and the real Slack Web API call, so both endpoints are unit
// testable without a Slack workspace or a network.

const fs = require('fs');
const path = require('path');

const SLACK_FITTING_ID = 'slack-channel';

// Slack conversation ids: C public channel, G private group, D direct message,
// U/W a user (chat.postMessage accepts a user id and posts into that DM).
const CONVERSATION_ID = /^[CDGUW][A-Z0-9]{1,}$/;
// A Slack message ts is seconds.microseconds, e.g. 1712345678.000200. It is the
// thread key: replying with thread_ts = the parent's ts threads the message.
const MESSAGE_TS = /^\d{1,12}\.\d{1,8}$/;

// Slack's documented ceiling for chat.postMessage text is 40,000 characters.
// Stay well under it: clients collapse anything past ~4,000 behind a "See more"
// expander anyway, and the card link carries the full record.
const MAX_SLACK_TEXT = 12_000;

const DEDUPE_MAX = 500;
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The thread id a Slack conversation maps to: `<conversation>:<thread_ts>`.
 *
 * This is the SAME identity on both sides of the round trip. Inbound, the
 * adapter sends it to the gateway as `sessionId` with `channel: "slack"`, so a
 * carded turn is stamped originChannel {channel:"slack", threadId:"C123:171…"}
 * and kanban's origins.mjs derives the origin id "slack:C123:171…" - the
 * `<transport>:<address>` convention every transport already uses (and the one
 * discuss-intercept's originIdFor formats). Outbound, notify-origin hands that
 * same threadId back to POST /api/threads/:id/messages, and parseSlackThreadId
 * turns it into the (channel, thread_ts) pair chat.postMessage needs. Nothing
 * about Slack is special-cased anywhere in between.
 */
function slackThreadId(conversation, threadTs) {
  const c = String(conversation ?? '').trim();
  const ts = String(threadTs ?? '').trim();
  if (!c) return null;
  return ts ? `${c}:${ts}` : c;
}

/**
 * Parse a thread id back into { channel, threadTs }. Accepts the bare address
 * (`C123:171…`) and the full origin id (`slack:C123:171…`), because a caller
 * holding a parsed origin id and one holding the card's threadId are both
 * legitimate. A conversation with no ts is valid: the message lands in the
 * conversation unthreaded. Anything else returns null - the caller decides
 * whether to fall back or refuse.
 */
function parseSlackThreadId(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.toLowerCase().startsWith('slack:')) s = s.slice('slack:'.length).trim();
  const parts = s.split(':');
  const channel = (parts.shift() ?? '').trim();
  if (!CONVERSATION_ID.test(channel)) return null;
  const rest = parts.join(':').trim();
  if (!rest) return { channel, threadTs: null };
  if (!MESSAGE_TS.test(rest)) return null;
  return { channel, threadTs: rest };
}

// Slack mrkdwn reserves three characters in message text.
function escapeMrkdwn(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function clampText(value, max = MAX_SLACK_TEXT) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Render a /notify payload as one Slack message.
 *
 * actions[] become LINKS, not buttons: this adapter has no Slack interactivity
 * endpoint (no Request URL, no block_actions handler), so a real button would
 * be a control that silently does nothing when pressed. An action carrying a
 * url renders as a Slack link; a label-only action degrades to a plain text
 * line so the information is not lost. Buttons become possible the day an
 * interactivity endpoint exists - that is a separate change.
 */
function renderNotification({ title = null, text = '', link = null, actions = [] } = {}) {
  const blocks = [];
  const head = String(title ?? '').trim();
  if (head) blocks.push(`*${escapeMrkdwn(head)}*`);
  const body = String(text ?? '').trim();
  if (body) blocks.push(escapeMrkdwn(body));

  const seen = new Set();
  const url = typeof link === 'string' && link.trim() ? link.trim() : null;
  if (url) {
    blocks.push(url);
    seen.add(url);
  }
  const rendered = [];
  for (const action of Array.isArray(actions) ? actions.slice(0, 5) : []) {
    if (!action || typeof action !== 'object') continue;
    const label = String(action.label ?? '').trim();
    const target = typeof action.url === 'string' && action.url.trim() ? action.url.trim() : null;
    if (target) {
      // The link line above already carries this destination; repeating it
      // under a label just doubles the same URL in the message.
      if (seen.has(target)) continue;
      seen.add(target);
      rendered.push(`<${target}|${escapeMrkdwn(label || target)}>`);
    } else if (label) {
      rendered.push(escapeMrkdwn(label));
    }
  }
  if (rendered.length) blocks.push(rendered.join('  ·  '));

  return clampText(blocks.join('\n\n'));
}

/**
 * Delivery dedupe keyed by the caller's idempotencyKey.
 *
 * In memory AND on disk: a re-fanned notification within one adapter process is
 * the common case (kanban retries), but an adapter restart between the two
 * fan-outs is exactly when a duplicate is most annoying, so the record outlives
 * the process. Entries expire (ttlMs) and are capped (max) - this is a
 * short-horizon "did I just send this" memory, not an audit log.
 *
 * begin/commit/abort rather than a bare has/add: the reservation has to happen
 * BEFORE the Slack round trip (two concurrent fan-outs would otherwise both
 * pass a has() check and both post), and a delivery that FAILED must not be
 * remembered as delivered, or the retry is swallowed.
 */
class NotifyDedupe {
  constructor({ file = null, max = DEDUPE_MAX, ttlMs = DEDUPE_TTL_MS, now = () => Date.now() } = {}) {
    this.file = file;
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.inflight = new Set();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const entries = parsed && typeof parsed.entries === 'object' ? parsed.entries : {};
      for (const [key, at] of Object.entries(entries)) {
        if (typeof key === 'string' && key && Number.isFinite(at)) this.entries.set(key, at);
      }
      this.prune();
    } catch {
      // No file, unreadable file, corrupt JSON: an empty memory is always safe
      // here - the worst case is one duplicate message, never a lost one.
    }
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, at] of this.entries) {
      if (at < cutoff) this.entries.delete(key);
    }
    // Map preserves insertion order and remember() always appends, so the head
    // is the oldest.
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }), {
        mode: 0o600
      });
      fs.renameSync(tmp, this.file);
    } catch {
      // A dedupe store that cannot persist still works in memory; failing the
      // delivery over it would be the wrong trade.
    }
  }

  seen(key) {
    if (!key) return false;
    const at = this.entries.get(key);
    if (at === undefined) return false;
    if (at < this.now() - this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Reserve a delivery. false = already delivered, or in flight right now. */
  begin(key) {
    if (!key) return true;
    if (this.seen(key) || this.inflight.has(key)) return false;
    this.inflight.add(key);
    return true;
  }

  commit(key) {
    if (!key) return;
    this.inflight.delete(key);
    this.entries.delete(key);
    this.entries.set(key, this.now());
    this.prune();
    this.persist();
  }

  abort(key) {
    if (!key) return;
    this.inflight.delete(key);
  }
}

function trimmed(value, max = 200) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * The two outbound endpoints, as pure request handlers.
 *
 * postMessage({channel, threadTs, text}) -> Promise<boolean> is injected: the
 * adapter passes its retrying chat.postMessage, tests pass a recorder.
 * notifyChannel is the conversation proactive notifications land in (see the
 * fitting's notify_channel config); absent, /notify reports honestly rather
 * than 404-ing, because "no destination configured" is a different fact from
 * "this fitting is not a channel".
 */
function createOutbound({ postMessage, dedupe = new NotifyDedupe(), notifyChannel = null, log = () => {} }) {
  const target = trimmed(notifyChannel, 64);

  async function notify(body) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return { status: 400, body: { ok: false, error: 'text required' } };
    if (!target) {
      return {
        status: 200,
        body: { ok: true, delivered: 0, reason: 'no notify_channel configured' }
      };
    }
    const raw = trimmed(body?.idempotencyKey);
    const key = raw ? `notify:${raw}` : null;
    if (!dedupe.begin(key)) {
      return { status: 200, body: { ok: true, delivered: 0, deduplicated: true } };
    }
    const rendered = renderNotification({
      title: body?.title ?? null,
      text,
      link: body?.link ?? null,
      actions: body?.actions ?? []
    });
    let posted = false;
    try {
      posted = (await postMessage({ channel: target, threadTs: null, text: rendered })) === true;
    } catch (err) {
      log(`notify: postMessage threw: ${err?.message ?? err}`);
    }
    if (posted) dedupe.commit(key);
    else dedupe.abort(key);
    return posted
      ? { status: 200, body: { ok: true, delivered: 1, channel: target } }
      : { status: 502, body: { ok: false, delivered: 0, error: 'chat.postMessage failed' } };
  }

  async function threadAppend(threadId, body) {
    const parsed = parseSlackThreadId(threadId);
    // An id this channel cannot locate still carries something the operator is
    // waiting on. Delivering it to the configured notify conversation, unthreaded,
    // beats the alternative - silence, which is the exact failure this whole
    // contract exists to fix. With no notify channel either, say so honestly.
    const destination = parsed ?? (target ? { channel: target, threadTs: null } : null);
    if (!destination) {
      return {
        status: 400,
        body: { ok: false, error: `unroutable thread id ${JSON.stringify(String(threadId ?? ''))} and no notify_channel configured` }
      };
    }
    if (!parsed) log(`thread-append: ${threadId} is not a Slack thread id; delivering to ${target}`);

    const messages = (Array.isArray(body?.messages) ? body.messages : [])
      .map((message) => (typeof message?.text === 'string' ? message.text.trim() : ''))
      .filter(Boolean);
    if (!messages.length) return { status: 400, body: { ok: false, error: 'messages required' } };

    const raw = trimmed(body?.idempotencyKey);
    const key = raw ? `thread:${threadId}:${raw}` : null;
    if (!dedupe.begin(key)) {
      return { status: 200, body: { ok: true, appended: 0, deduplicated: true } };
    }

    let appended = 0;
    for (const text of messages) {
      let posted = false;
      try {
        posted = (await postMessage({
          channel: destination.channel,
          threadTs: destination.threadTs,
          text: clampText(text)
        })) === true;
      } catch (err) {
        log(`thread-append: postMessage threw: ${err?.message ?? err}`);
      }
      if (!posted) break;
      appended += 1;
    }
    // Remembered only when the WHOLE batch landed: a partial batch retried by
    // the caller may repeat what already arrived, and a repeat is recoverable
    // where a silently dropped outcome is not. Every caller in Garrison today
    // sends a single message, where this is exact.
    if (appended === messages.length) dedupe.commit(key);
    else dedupe.abort(key);

    return appended === messages.length
      ? {
          status: 200,
          body: { ok: true, appended, channel: destination.channel, thread_ts: destination.threadTs }
        }
      : {
          status: 502,
          body: { ok: false, appended, error: 'chat.postMessage failed' }
        };
  }

  return { notify, threadAppend };
}

module.exports = {
  SLACK_FITTING_ID,
  MAX_SLACK_TEXT,
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  slackThreadId,
  parseSlackThreadId,
  renderNotification,
  clampText,
  escapeMrkdwn,
  NotifyDedupe,
  createOutbound
};

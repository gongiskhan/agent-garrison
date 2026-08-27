#!/usr/bin/env node
'use strict';

// Slack channel adapter for the Garrison HTTP gateway.
//
// Inbound:  POST /slack/events  (Slack Events API webhook)
//   - Verifies Slack signature (HMAC-SHA256, 5-minute replay guard).
//   - Handles url_verification challenges.
//   - For app_mention or message.im events, calls the gateway's
//     POST /chat synchronously, then posts the reply back to Slack
//     via chat.postMessage threaded on the original message.
//   - The call carries channel:"slack" + sessionId:"<conversation>:<thread_ts>",
//     so a turn that becomes a card is stamped with a Slack origin and every
//     later lifecycle event finds its way back to THIS thread.
//
// Outbound: the two contracts every Garrison channel fitting may implement, so
// proactive messages (reminders, card outcomes, mirrored questions) are not
// invisible on Slack:
//   - POST /notify                    (kanban-loop's fan-out; 404 = not a channel)
//   - POST /api/threads/:id/messages  (thread-append into a card's origin thread)
// Both are loopback-only and unauthenticated by design, exactly like the other
// channel fittings: the server binds 127.0.0.1 and only the Slack webhook route
// is meant to be tunnelled.
//
// Discovery: the adapter writes ~/.garrison/ui-fittings/slack-channel.json on
// start and removes it on shutdown. That status file is the ONLY way kanban-loop
// finds a channel (never a hardcoded port, never a hardcoded transport map), so
// without it the two endpoints above would be unreachable. Garrison does not
// spawn this adapter (it needs a public tunnel; see instructions.md) - the file
// is how a manually started adapter announces itself.
//
// No SSE subscriber loop. The gateway's /chat is synchronous; long
// turns are tolerated via Slack's threaded ack pattern.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const {
  SLACK_FITTING_ID,
  slackThreadId,
  NotifyDedupe,
  createOutbound
} = require('../lib/outbound.js');
const {
  Outbox,
  slackDestination,
  renderBatch,
  createOutboxRoutes,
  renderQueuedNotice
} = require('../lib/outbox.js');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:24777';
// Both spellings: SLACK_PORT is what instructions.md documents for a hand-started
// adapter; GARRISON_SLACKCHANNEL_SLACK_PORT is the projection Garrison would use
// for the `slack_port` config key, so a composition-configured port wins if this
// ever runs under the runner.
const SLACK_PORT = Number(
  process.env.SLACK_PORT || process.env.GARRISON_SLACKCHANNEL_SLACK_PORT || 29512
);
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 600_000);
// Where a proactive notification lands: a channel id (C…), a DM (D…), or the
// operator's user id (U…, which chat.postMessage delivers as a DM). Unset means
// /notify answers honestly with "no notify_channel configured" instead of
// pretending to have delivered.
const NOTIFY_CHANNEL = (
  process.env.SLACK_NOTIFY_CHANNEL ||
  process.env.GARRISON_SLACKCHANNEL_NOTIFY_CHANNEL ||
  ''
).trim();

const GARRISON_HOME =
  (process.env.GARRISON_HOME || '').trim() || path.join(os.homedir(), '.garrison');
const STATUS_FILE = path.join(GARRISON_HOME, 'ui-fittings', `${SLACK_FITTING_ID}.json`);
const DEDUPE_FILE = path.join(GARRISON_HOME, SLACK_FITTING_ID, 'notify-dedupe.json');
// Sends parked in their cancel window. Beside the dedupe file, for the same
// reason: it is this fitting's own state and it has to outlive the process.
const OUTBOX_FILE = path.join(GARRISON_HOME, SLACK_FITTING_ID, 'outbox.json');

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET) {
  console.error('[slack] SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET are required');
  process.exit(1);
}

const log = (...args) => console.error('[slack]', ...args);

// ---------------------------------------------------------------------------
// Slack signature verification
// ---------------------------------------------------------------------------

function verifySlackSignature(headers, rawBody) {
  const ts = headers['x-slack-request-timestamp'];
  const sig = headers['x-slack-signature'];
  if (!ts || !sig) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;
  const base = `v0:${ts}:${rawBody}`;
  const expected =
    'v0=' +
    crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendText(res, status, body, type = 'text/plain') {
  const payload = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': payload.length });
  res.end(payload);
}

function sendJson(res, status, body) {
  sendText(res, status, `${JSON.stringify(body)}\n`, 'application/json');
}

// Returns the parsed body, or null when it is not JSON (the caller answers 400).
async function readJson(req) {
  const raw = await readRaw(req);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// A malformed percent-escape is a bad request, not a server error; the raw
// segment is then judged by the thread-id parser like any other id.
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function postJson(url, body, { headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, headers: res.headers, body: text });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Slack Web API: chat.postMessage with retry
// ---------------------------------------------------------------------------

async function chatPostMessage({ channel, thread_ts, text }, attempt = 0) {
  const res = await postJson(
    'https://slack.com/api/chat.postMessage',
    { channel, thread_ts, text },
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } },
  ).catch((err) => ({ error: err }));

  if (res.error) {
    if (attempt < 3) {
      const wait = 500 * Math.pow(2, attempt);
      log(`chat.postMessage network error, retrying in ${wait}ms:`, res.error.message);
      await new Promise((r) => setTimeout(r, wait));
      return chatPostMessage({ channel, thread_ts, text }, attempt + 1);
    }
    log('chat.postMessage gave up after network failures');
    return false;
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers['retry-after'] || 1);
    if (attempt < 5) {
      log(`chat.postMessage 429, retrying in ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return chatPostMessage({ channel, thread_ts, text }, attempt + 1);
    }
    log('chat.postMessage gave up after 429s');
    return false;
  }

  if (res.status >= 500 && attempt < 3) {
    const wait = 500 * Math.pow(2, attempt);
    log(`chat.postMessage ${res.status}, retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return chatPostMessage({ channel, thread_ts, text }, attempt + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.ok !== true) {
    log(`chat.postMessage failed: status=${res.status} body=${res.body.slice(0, 300)}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Slack inbound: app_mention and DM handling
// ---------------------------------------------------------------------------

function stripMention(text) {
  return text.replace(/^\s*(<@[UW][A-Z0-9]+>\s*)+/i, '').trim();
}

async function handleSlackEvent(parsed) {
  const event = parsed.event;
  if (!event) return;
  if (event.subtype === 'bot_message' || event.bot_id) return;

  if (event.type !== 'app_mention' && !(event.type === 'message' && event.channel_type === 'im')) {
    return;
  }

  const text = stripMention(event.text || '');
  if (!text) return;
  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;
  // The conversation's Garrison identity. A task-shaped turn becomes a card
  // stamped originChannel {channel:"slack", threadId}, which kanban derives into
  // the origin id "slack:<conversation>:<thread_ts>" - the same id
  // discuss-intercept resolves, so answering a pending question or saying "go"
  // works here exactly as it does on the web channel.
  const sessionId = slackThreadId(channel, thread_ts);

  log(`forwarding to gateway: from=${event.user} channel=${channel} thread=${thread_ts}`);
  const res = await postJson(
    `${GATEWAY_URL}/chat`,
    {
      message: text,
      channel: 'slack',
      sessionId,
      sessionTitle: `Slack ${event.channel_type === 'im' ? 'DM' : 'thread'} ${channel}`
    },
    { timeoutMs: CHAT_TIMEOUT_MS },
  ).catch((err) => ({ error: err }));

  if (res.error || res.status !== 200) {
    log(`gateway /chat failed: ${res.error ? res.error.message : res.status}`);
    await chatPostMessage({
      channel,
      thread_ts,
      text: 'Sorry — the operative is unreachable right now.',
    });
    return;
  }

  let parsedReply;
  try {
    parsedReply = JSON.parse(res.body);
  } catch (err) {
    log('gateway /chat: bad JSON', err.message);
    return;
  }

  const reply = String(parsedReply.reply || '').trim();
  if (!reply) {
    log('gateway /chat: empty reply, skipping post');
    return;
  }

  await chatPostMessage({ channel, thread_ts, text: reply });
}

// ---------------------------------------------------------------------------
// Outbound contracts (/notify, thread-append)
// ---------------------------------------------------------------------------

const outbound = createOutbound({
  postMessage: ({ channel, threadTs, text }) =>
    // thread_ts must be ABSENT, not null: Slack rejects an explicit null.
    chatPostMessage({ channel, thread_ts: threadTs || undefined, text }),
  dedupe: new NotifyDedupe({ file: DEDUPE_FILE }),
  notifyChannel: NOTIFY_CHANNEL,
  log
});

const THREAD_MESSAGES = /^\/api\/threads\/([^/]+)\/messages$/;

// ---------------------------------------------------------------------------
// Outbound delay buffer (/outbox)
// ---------------------------------------------------------------------------
//
// A post an AGENT triggered does not go out now: scripts/connector.mjs parks it
// here for a cancel window and this process - the only long-lived one in the
// fitting - drains it when the window elapses uncancelled. That is what makes
// an irreversible send revertible in practice, which is the only footing an
// autonomy band has to grant act-without-asking on one.
//
// Everything due for the SAME channel drains as ONE message: chat.postMessage
// is rate-limited near one message per second per channel, so N buffered
// updates posted back to back is both slower and worse to read than one.

const outbox = new Outbox({
  file: OUTBOX_FILE,
  groupKey: slackDestination,
  log,
  // Through chatPostMessage, never a fresh HTTP call: the retry/429/Retry-After
  // handling stays in one place. It answers a BOOLEAN, and a false has to FAIL
  // the entry - settling a failed post as "sent" would lose the message
  // silently, which is the one outcome this buffer exists to prevent.
  send: async (entry, batch) => {
    const posted = await chatPostMessage({
      channel: entry.payload.channel,
      text: renderBatch(batch)
    });
    if (posted !== true) throw new Error('chat.postMessage failed');
    return { posted: true, messages: batch.length };
  }
});

const outboxRoutes = createOutboxRoutes({
  outbox,
  baseUrl: `http://127.0.0.1:${SLACK_PORT}`,
  // A parked send announces itself where the operator is already looking,
  // through this fitting's own /notify path rather than a second delivery
  // mechanism invented for the buffer.
  announce: (entry) => outbound.notify(renderQueuedNotice(entry)),
  log
});

const OUTBOX_CANCEL = /^\/outbox\/([^/]+)\/cancel$/;

// ---------------------------------------------------------------------------
// Status file - how kanban-loop discovers this channel
// ---------------------------------------------------------------------------

function writeStatusFile() {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(
      STATUS_FILE,
      `${JSON.stringify(
        {
          fittingId: SLACK_FITTING_ID,
          port: SLACK_PORT,
          url: `http://127.0.0.1:${SLACK_PORT}`,
          pid: process.pid,
          startedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
  } catch (err) {
    // Not fatal: inbound Slack still works. Outbound just stays undiscoverable,
    // which is worth one loud line rather than a silent half-working channel.
    log(`could not write ${STATUS_FILE}: ${err.message}; proactive messages will not reach Slack`);
  }
}

function clearStatusFile() {
  try {
    const current = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    // Only ever remove our OWN registration - a status file naming another live
    // pid belongs to another adapter, and deleting it would hide a running channel.
    if (current && current.pid !== process.pid) return;
    fs.unlinkSync(STATUS_FILE);
  } catch {
    // already gone, or never written
  }
}

// ---------------------------------------------------------------------------
// HTTP server for Slack webhooks
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;

    if (method === 'GET' && pathname === '/health') {
      return sendText(res, 200, 'ok\n');
    }

    if (method === 'POST' && pathname === '/notify') {
      const body = await readJson(req);
      if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      const out = await outbound.notify(body);
      return sendJson(res, out.status, out.body);
    }

    if (method === 'GET' && pathname === '/outbox') {
      const out = outboxRoutes.list();
      return sendJson(res, out.status, out.body);
    }

    if (method === 'POST' && pathname === '/outbox') {
      const body = await readJson(req);
      if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      const out = await outboxRoutes.enqueue(body);
      return sendJson(res, out.status, out.body);
    }

    const cancelMatch = method === 'POST' ? OUTBOX_CANCEL.exec(pathname) : null;
    if (cancelMatch) {
      const out = outboxRoutes.cancel(safeDecode(cancelMatch[1]));
      return sendJson(res, out.status, out.body);
    }

    const threadMatch = method === 'POST' ? THREAD_MESSAGES.exec(pathname) : null;
    if (threadMatch) {
      const body = await readJson(req);
      if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      const out = await outbound.threadAppend(safeDecode(threadMatch[1]), body);
      return sendJson(res, out.status, out.body);
    }

    if (method !== 'POST' || pathname !== '/slack/events') {
      // 404 is the contract's "not for you" for every endpoint this fitting
      // does not implement; the fan-out skips it silently.
      return sendText(res, 404, 'not found\n');
    }

    const raw = await readRaw(req);
    if (!verifySlackSignature(req.headers, raw)) {
      log('rejected: bad signature');
      return sendText(res, 401, 'bad signature\n');
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendText(res, 400, 'bad json\n');
    }

    if (parsed.type === 'url_verification') {
      return sendText(res, 200, parsed.challenge || '');
    }

    sendText(res, 200, 'ok\n');
    handleSlackEvent(parsed).catch((err) => log('handleSlackEvent threw:', err.message));
  } catch (err) {
    log('handler error:', err.message);
    if (!res.headersSent) sendText(res, 500, 'error\n');
  }
});

server.listen(SLACK_PORT, '127.0.0.1', () => {
  writeStatusFile();
  // A restart inside someone's cancel window must not swallow their message:
  // re-arm what is still parked (overdue entries drain at once). Anything a
  // crash caught mid-post is failed rather than posted twice - see Outbox.rearm.
  const rearmed = outbox.rearm();
  if (rearmed.length) log(`outbox: re-armed ${rearmed.length} parked send(s)`);
  log(`webhook listening on http://127.0.0.1:${SLACK_PORT}/slack/events`);
  log(`outbound: POST /notify and POST /api/threads/:id/messages`);
  log(`send buffer: GET /outbox and POST /outbox/:id/cancel`);
  log(
    NOTIFY_CHANNEL
      ? `notifications post to ${NOTIFY_CHANNEL}`
      : 'no notify_channel configured; proactive notifications will be reported as undelivered'
  );
  log(`gateway: ${GATEWAY_URL}`);
});

const shutdown = (signal) => {
  log(`received ${signal}, shutting down`);
  clearStatusFile();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

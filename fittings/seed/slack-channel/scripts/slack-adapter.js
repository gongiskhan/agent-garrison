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
//
// No SSE subscriber loop. The gateway's /chat is synchronous; long
// turns are tolerated via Slack's threaded ack pattern.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:4777';
const SLACK_PORT = Number(process.env.SLACK_PORT || 9512);
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 600_000);

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

  log(`forwarding to gateway: from=${event.user} channel=${channel} thread=${thread_ts}`);
  const res = await postJson(
    `${GATEWAY_URL}/chat`,
    { message: text },
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
// HTTP server for Slack webhooks
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendText(res, 200, 'ok\n');
    }
    if (req.method !== 'POST' || req.url !== '/slack/events') {
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
  log(`webhook listening on http://127.0.0.1:${SLACK_PORT}/slack/events`);
  log(`gateway: ${GATEWAY_URL}`);
});

const shutdown = (signal) => {
  log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// The conversation serving layer (Conversations plan, C1) - ONE node http
// handler, mounted at the SAME relative base by every surface that renders a
// conversation: the web-channel server, the kanban board server, and the Next
// app's /api/conversation/[...path] route.
//
// One router, three mounts, because the client code is identical everywhere: the
// browser is almost never on the Garrison box, so every URL a conversation view
// builds is RELATIVE, and a relative URL only works if each origin answers the
// same paths.
//
//   GET  {base}/:id                    meta: summary, handoffs, tail, stretch
//   GET  {base}/:id/log?fromIndex&limit  raw ledger records (the L3 view)
//   GET  {base}/:id/summary            L1, text/markdown
//   GET  {base}/:id/handoff/:n         one L2 handoff, JSON
//   GET  {base}/:id/payload/:ref       one L3 payload, raw bytes, confined
//   GET  {base}/:id/stream?from=       SSE SessionEvents {init|events|end}
//   POST {base}/:id/message            admit a user message (allowed fields)
//   GET  {base}/search?q&id&limit      fixed-string search over L1/L2/L3
//
// Reading is not free of consequence: a payload/log/handoff read writes a `dig`
// event, debounced per (conversation, target, ref), so "which records did a
// human actually open" is a measurable fact rather than a guess.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { conversationDir, listConversations, openConversation } from "./conversation-store.mjs";
import { ledgerToSessionEvents } from "./conversation-adapt.mjs";

/** The id vocabulary the gateway's /conversation routes already enforce. */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** An opaque payload name. No slash, so it cannot address a directory; `.` and
 *  `..` are rejected separately because both match the character class. */
const PAYLOAD_REF_RE = /^[A-Za-z0-9._-]{1,200}$/;
const HANDOFF_ORDINAL_RE = /^\d{1,4}$/;

const STREAM_POLL_MS = 800;
const KEEPALIVE_MS = 15_000;
const BODY_CAP_BYTES = 1024 * 1024;
const DIG_DEBOUNCE_MS = 60_000;
const SEARCH_PER_FILE = 50;
const SEARCH_GLOBAL_CAP = 200;
const SNIPPET_WINDOW = 80;
const SNIPPET_CAP = 200;

const CONTENT_TYPES = {
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Handle one request under `base`. Returns true when the request was handled
 * (including its 404s and 400s - anything under the base belongs to this
 * router), false when the path is not ours and the mount should carry on.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{base?: string, env?: object, role?: string,
 *          onDig?: (dig: object) => void,
 *          forwardMessage: (msg: object) => Promise<{ok: boolean, recorded?: boolean}>,
 *          pollMs?: number}} opts
 */
export async function handleConversationRequest(req, res, opts = {}) {
  const base = (opts.base ?? "/api/conversation").replace(/\/+$/, "");
  const env = opts.env ?? process.env;
  const method = (req.method || "GET").toUpperCase();
  const raw = req.url || "/";
  const qmark = raw.indexOf("?");
  const rawPath = qmark === -1 ? raw : raw.slice(0, qmark);
  const query = new URLSearchParams(qmark === -1 ? "" : raw.slice(qmark + 1));
  if (rawPath !== base && !rawPath.startsWith(`${base}/`)) return false;

  // Decode PER SEGMENT, never the whole path: decoding first would turn an
  // encoded slash into a path separator, and decoding again downstream would
  // let a double-encoded traversal through a check that already passed.
  const rest = rawPath.slice(base.length).replace(/^\/+/, "");
  const segments = rest ? rest.split("/").filter((segment) => segment.length > 0).map(decodeSegment) : [];
  const onDig = opts.onDig ?? recordDig(env, opts.role);

  if (segments.length === 1 && segments[0] === "search") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "search is GET-only" });
      return true;
    }
    await handleSearch(res, { query, env });
    return true;
  }

  const conversationId = segments[0] ?? "";
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    sendJson(res, 400, { error: "invalid conversation id" });
    return true;
  }
  const store = openConversation(conversationId, { role: opts.role ?? "reader", env });
  const tail = segments.slice(1);

  if (method === "GET" && tail.length === 0) {
    handleMeta(res, store, conversationId);
    return true;
  }
  if (method === "GET" && tail.length === 1 && tail[0] === "log") {
    noteDig(onDig, conversationId, "log", `from:${query.get("fromIndex") ?? 0}`);
    handleLog(res, store, query);
    return true;
  }
  if (method === "GET" && tail.length === 1 && tail[0] === "summary") {
    noteDig(onDig, conversationId, "summary", "summary.md");
    handleSummary(res, store);
    return true;
  }
  if (method === "GET" && tail.length === 2 && tail[0] === "handoff") {
    noteDig(onDig, conversationId, "handoff", tail[1]);
    handleHandoff(res, store, tail[1]);
    return true;
  }
  if (method === "GET" && tail.length === 2 && tail[0] === "payload") {
    noteDig(onDig, conversationId, "payload", tail[1]);
    handlePayload(res, store, tail[1]);
    return true;
  }
  if (method === "GET" && tail.length === 1 && tail[0] === "stream") {
    handleStream(req, res, {
      store,
      conversationId,
      from: clampInt(query.get("from"), 0, 0, Number.MAX_SAFE_INTEGER),
      pollMs: Number(opts.pollMs) > 0 ? Number(opts.pollMs) : STREAM_POLL_MS,
    });
    return true;
  }
  if (method === "POST" && tail.length === 1 && tail[0] === "message") {
    await handleMessage(req, res, { store, conversationId, forwardMessage: opts.forwardMessage });
    return true;
  }

  sendJson(res, 404, { error: `no such conversation route: ${rest || "/"}` });
  return true;
}

// -- endpoints ---------------------------------------------------------------

function handleMeta(res, store, conversationId) {
  const page = store.range({ fromIndex: 0, limit: 0 });
  sendJson(res, 200, {
    conversationId,
    summary: store.readSummary(),
    handoffs: store.lastHandoffs(10),
    tail: store.tail(50),
    currentStretch: store.currentStretch(),
    total: page.total,
  });
}

function handleLog(res, store, query) {
  const fromIndex = clampInt(query.get("fromIndex"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(query.get("limit"), 500, 1, 2000);
  sendJson(res, 200, store.range({ fromIndex, limit }));
}

function handleSummary(res, store) {
  const text = store.readSummary();
  if (text == null) {
    sendJson(res, 404, { error: "no summary yet" });
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "text/markdown; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(text);
}

function handleHandoff(res, store, ordinalRaw) {
  if (!HANDOFF_ORDINAL_RE.test(ordinalRaw)) {
    sendJson(res, 400, { error: "invalid handoff ordinal" });
    return;
  }
  const handoff = store.readHandoff(Number(ordinalRaw));
  if (!handoff) {
    sendJson(res, 404, { error: "no such handoff" });
    return;
  }
  sendJson(res, 200, handoff);
}

/**
 * Serve one payload's bytes.
 *
 * Confinement is by CONSTRUCTION, not by inspecting a caller-supplied path: the
 * ref is a bare name matched against a no-slash character class and joined onto
 * THIS conversation's payloads/ directory, exactly as the store's own
 * readPayload does. The realpath check underneath catches the one case the
 * character class cannot - a symlink placed inside payloads/ pointing out.
 *
 * The bytes go out RAW (a JSON wrapper would make the viewer re-parse an
 * already-structured record) under nosniff plus a sandboxing CSP, so a payload
 * can never be interpreted as an active document on this origin.
 */
function handlePayload(res, store, refRaw) {
  // Already decoded once, by segment, at the router's front door.
  let ref = refRaw;
  // Both spellings resolve: the adapter emits the bare name, while a caller
  // holding a store ref (`payloads/<name>`) should not have to know to strip it.
  if (ref.startsWith("payloads/")) ref = ref.slice("payloads/".length);
  if (!PAYLOAD_REF_RE.test(ref) || ref === "." || ref === "..") {
    sendJson(res, 400, { error: "invalid payload ref" });
    return;
  }
  const dir = path.join(store.dir, "payloads");
  const file = path.join(dir, ref);
  let real = null;
  try {
    if (statSync(file).isFile()) real = realpathSync(file);
  } catch {
    real = null;
  }
  if (!real || !confinedTo(real, dir)) {
    sendJson(res, 404, { error: "no such payload" });
    return;
  }
  let body;
  try {
    body = readFileSync(real);
  } catch {
    sendJson(res, 404, { error: "no such payload" });
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", CONTENT_TYPES[path.extname(ref).toLowerCase()] ?? "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-security-policy", "default-src 'none'; sandbox");
  res.end(body);
}

/**
 * SSE the conversation as canonical SessionEvents.
 *
 * There is deliberately NO `snapshot` frame here, unlike the web channel's
 * thread stream. That stream reconciles two independently-written sources and
 * can discover an older row after a newer one; this ledger is APPEND-ONLY and
 * its indexes are stable forever, so a delta can always express what changed.
 * The one in-place update - a stretch `ended` settling its `started` row -
 * travels as a revision of the same stable event id, which mergeSessionEvents
 * applies without the whole array being resent.
 */
function handleStream(req, res, { store, conversationId, from, pollMs }) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();

  const emit = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  // Carried across polls: an `ended` record arriving in a later batch must still
  // revise the `started` event the client already painted.
  const stretchStarts = new Map();
  const first = store.range({ fromIndex: from, limit: 2000 });
  let cursor = first.nextIndex;
  let size = logBytes(store);
  // A valid id with no directory yet is LIVE, not unavailable: a conversation is
  // routinely rendered before its first event lands, and an `end` here would
  // leave the pane dead until a manual reload.
  emit({
    type: "init",
    available: true,
    live: true,
    events: ledgerToSessionEvents(first.events, { conversationId, stretchStarts }),
  });

  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(keep);
    clearInterval(poll);
    emit({ type: "end" });
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };
  const keep = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      stop();
    }
  }, KEEPALIVE_MS);
  const poll = setInterval(() => {
    if (closed) return;
    try {
      // Cheap change detection first: without it the poll re-parses the whole
      // log every tick, per connected client, for a file that usually did not
      // move.
      const bytes = logBytes(store);
      if (bytes === size) return;
      size = bytes;
      const page = store.range({ fromIndex: cursor, limit: 500 });
      if (!page.events.length) return;
      cursor = page.nextIndex;
      emit({ type: "events", events: ledgerToSessionEvents(page.events, { conversationId, stretchStarts }) });
    } catch {
      // A transient read miss is retried on the next tick; it must never turn a
      // live conversation into a dead pane.
    }
  }, pollMs);
  req.on("close", stop);
  res.on("close", stop);
}

/**
 * Admit one user message.
 *
 * `forwardMessage` is MANDATORY. A message that lands in the ledger and wakes
 * nothing is the worst outcome available here - it looks delivered and is not -
 * so a mount that cannot reach a responder must not accept messages at all.
 *
 * The forwarder reports whether the SINK already appended the user-message
 * record (the gateway's POST /conversation/message does, before it spawns the
 * responder). Only when it did not does this router write the record itself, so
 * one message can never appear twice in the ledger.
 */
async function handleMessage(req, res, { store, conversationId, forwardMessage }) {
  if (typeof forwardMessage !== "function") {
    sendJson(res, 500, { error: "this mount has no message forwarder" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err?.code === "BODY_TOO_LARGE" ? 413 : 400, { error: err?.message ?? "unreadable body" });
    return;
  }
  const allowed = new Set(["message", "clientRequestId", "origin"]);
  const unknown = Object.keys(body ?? {}).filter((key) => !allowed.has(key));
  if (unknown.length) {
    sendJson(res, 400, { error: `unknown fields: ${unknown.join(", ")}` });
    return;
  }
  const message = typeof body?.message === "string" ? body.message : "";
  if (!message.trim()) {
    sendJson(res, 400, { error: "message is required" });
    return;
  }
  const clientRequestId = typeof body?.clientRequestId === "string" ? body.clientRequestId.slice(0, 200) : null;
  const origin = typeof body?.origin === "string" ? body.origin.slice(0, 80) : "web";

  let forwarded;
  try {
    forwarded = await forwardMessage({ conversationId, message, clientRequestId, origin });
  } catch (err) {
    forwarded = { ok: false, error: err?.message ?? String(err) };
  }
  if (!forwarded?.ok) {
    sendJson(res, 502, {
      error: "the conversation responder is unreachable; the message was NOT recorded",
      detail: forwarded?.error ?? forwarded?.status ?? null,
    });
    return;
  }
  let seq = null;
  if (!forwarded.recorded) {
    const running = store.currentStretch();
    const record = store.append({
      kind: "user-message",
      payload: {
        text: message.slice(0, 32_000),
        origin,
        clientRequestId,
        arrivedDuringStretch: running,
        disposition: running ? "queued" : "opened",
      },
    });
    seq = record.ok ? record.seq : null;
  }
  sendJson(res, 202, {
    accepted: true,
    conversationId,
    recordedBy: forwarded.recorded ? "responder" : "router",
    seq,
  });
}

/**
 * The forwarder every real mount uses: POST the gateway's own
 * /conversation/message, which is where the launcher lives.
 *
 * ONE implementation, exported, because all three mounts need exactly this and
 * a per-mount copy is how the same fact ends up spelled three ways. It reports
 * `recorded: true` because that gateway route appends the user-message record
 * BEFORE it spawns the responder - the router writing a second copy would put
 * the message in the transcript twice.
 */
export function gatewayMessageForwarder(gatewayUrl) {
  return async ({ conversationId, message, origin }) => {
    if (!gatewayUrl) return { ok: false, error: "this mount has no gateway URL" };
    try {
      const response = await fetch(new URL("/conversation/message", gatewayUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message, origin }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { ok: false, status: response.status, error: `gateway answered ${response.status}` };
      return { ok: true, recorded: true };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  };
}

// -- search ------------------------------------------------------------------

/**
 * Fixed-string search over a conversation's three layers.
 *
 * `grep -F` runs through execFile ARGV - never a shell string - and the pattern
 * travels behind `-e`, so a query that reads as flags ("-r /etc") is a needle,
 * not an option. Hits come back as conversation coordinates
 * ({conversationId, kind, seq}) plus a snippet: a raw file path would leak the
 * store's layout and is never something the client needs.
 */
async function handleSearch(res, { query, env }) {
  const needle = (query.get("q") ?? "").trim();
  if (!needle) {
    sendJson(res, 400, { error: "q is required" });
    return;
  }
  const limit = clampInt(query.get("limit"), 50, 1, SEARCH_GLOBAL_CAP);
  const id = query.get("id");
  if (id && !CONVERSATION_ID_RE.test(id)) {
    sendJson(res, 400, { error: "invalid conversation id" });
    return;
  }

  const ids = id ? [id] : listConversations(env).map((entry) => entry.id).slice(0, 200);
  const dirs = ids.map((cid) => conversationDir(cid, env)).filter((dir) => existsSync(dir));
  if (!dirs.length) {
    sendJson(res, 200, { hits: [], truncated: false });
    return;
  }

  let raw;
  try {
    raw = await grepHits(needle, dirs);
  } catch {
    raw = scanHits(needle, dirs);
  }
  const capped = raw.length > SEARCH_GLOBAL_CAP;
  const hits = resolveHits(raw.slice(0, SEARCH_GLOBAL_CAP), { env, needle });
  sendJson(res, 200, { hits: hits.slice(0, limit), truncated: capped || hits.length > limit });
}

const SEARCH_INCLUDES = [
  "--include=log.jsonl",
  "--include=log.*.jsonl",
  "--include=summary.md",
  // The handoff ordinal filenames (0001.json). Deliberately narrower than
  // *.json so the payload spill directory stays out of the result set.
  "--include=[0-9][0-9][0-9][0-9].json",
];

function grepHits(needle, dirs) {
  return new Promise((resolve, reject) => {
    execFile(
      "grep",
      ["-r", "-F", "-n", "-m", String(SEARCH_PER_FILE), ...SEARCH_INCLUDES, "-e", needle, "--", ...dirs],
      { maxBuffer: 8 * 1024 * 1024, timeout: 10_000, encoding: "utf8" },
      (err, stdout) => {
        // grep exits 1 for "no matches" - that is an answer, not a failure. Any
        // other error (grep absent, buffer blown) falls back to the node scan.
        if (err && err.code !== 1 && !stdout) return reject(err);
        resolve(parseGrepOutput(stdout ?? ""));
      }
    );
  });
}

function parseGrepOutput(stdout) {
  const out = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const firstColon = line.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = line.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;
    const lineNo = Number(line.slice(firstColon + 1, secondColon));
    if (!Number.isInteger(lineNo)) continue;
    out.push({ file: line.slice(0, firstColon), lineNo, text: line.slice(secondColon + 1) });
  }
  return out;
}

/** Pure-node equivalent, for a box where spawning grep fails. Same files, same
 *  per-file cap, same hit shape - a fallback that answered a different question
 *  than the fast path would be worse than no fallback. */
function scanHits(needle, dirs) {
  const out = [];
  for (const dir of dirs) {
    const files = [];
    for (const name of safeReaddir(dir)) {
      if (name === "summary.md" || /^log(\.\d+)?\.jsonl$/.test(name)) files.push(path.join(dir, name));
    }
    for (const name of safeReaddir(path.join(dir, "handoffs"))) {
      if (/^\d{4}\.json$/.test(name)) files.push(path.join(dir, "handoffs", name));
    }
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let perFile = 0;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && perFile < SEARCH_PER_FILE; i += 1) {
        if (!lines[i].includes(needle)) continue;
        perFile += 1;
        out.push({ file, lineNo: i + 1, text: lines[i] });
        if (out.length > SEARCH_GLOBAL_CAP) return out;
      }
    }
  }
  return out;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Turn file coordinates into conversation coordinates. Everything filesystem
 *  about a hit dies here. */
function resolveHits(raw, { env, needle }) {
  const lineIndexes = new Map(); // conversationId -> Map<segment name, number[]>
  const handoffIndexes = new Map(); // conversationId -> log index per ordinal
  const totals = new Map(); // conversationId -> total record count
  const out = [];
  for (const hit of raw) {
    const located = locate(hit.file);
    if (!located) continue;
    const { conversationId, file, segment } = located;
    if (!CONVERSATION_ID_RE.test(conversationId)) continue;
    const store = openConversation(conversationId, { role: "reader", env });
    if (file === "log") {
      if (!lineIndexes.has(conversationId)) lineIndexes.set(conversationId, segmentLineIndexes(store));
      const seq = lineIndexes.get(conversationId).get(segment)?.[hit.lineNo - 1];
      if (!Number.isInteger(seq) || seq < 0) continue;
      out.push({ conversationId, kind: logKind(hit.text), seq, snippet: logSnippet(hit.text, needle) });
      continue;
    }
    if (!totals.has(conversationId)) totals.set(conversationId, store.range({ fromIndex: 0, limit: 0 }).total);
    const lastIndex = Math.max(0, totals.get(conversationId) - 1);
    if (file === "handoff") {
      if (!handoffIndexes.has(conversationId)) {
        handoffIndexes.set(
          conversationId,
          store.tail(10_000, { kinds: ["handoff"] }).map((event) => event.index)
        );
      }
      // handoffs/000N.json is the N-th handoff the conversation recorded, so the
      // N-th `handoff` ledger row is where the reader should land.
      const seq = handoffIndexes.get(conversationId)[segment - 1];
      out.push({
        conversationId,
        kind: "handoff",
        seq: Number.isInteger(seq) ? seq : lastIndex,
        snippet: windowAround(hit.text, needle),
      });
      continue;
    }
    // summary.md is L1: it always describes the CURRENT state, so its landing
    // point is the live tail rather than any historical row.
    out.push({ conversationId, kind: "summary", seq: lastIndex, snippet: windowAround(hit.text, needle) });
  }
  return out;
}

function locate(file) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  if (name === "summary.md") return { conversationId: path.basename(dir), file: "summary", segment: null };
  if (/^log(\.\d+)?\.jsonl$/.test(name)) return { conversationId: path.basename(dir), file: "log", segment: name };
  if (/^\d{4}\.json$/.test(name) && path.basename(dir) === "handoffs") {
    return { conversationId: path.basename(path.dirname(dir)), file: "handoff", segment: Number(name.slice(0, 4)) };
  }
  return null;
}

/** Map every segment's 1-based file line number to the store's stable global
 *  index, so a grep coordinate becomes the UI's jump coordinate. */
function segmentLineIndexes(store) {
  const map = new Map();
  let index = 0;
  for (const seg of store.logSegments()) {
    const positions = [];
    let text = "";
    try {
      text = readFileSync(seg, "utf8");
    } catch {
      map.set(path.basename(seg), positions);
      continue;
    }
    let pos = 0;
    while (true) {
      const nl = text.indexOf("\n", pos);
      if (nl === -1) break; // a torn tail is unread by the store too
      const line = text.slice(pos, nl).trim();
      pos = nl + 1;
      if (!line) {
        positions.push(-1);
        continue;
      }
      try {
        JSON.parse(line);
        positions.push(index);
        index += 1;
      } catch {
        positions.push(-1);
      }
    }
    map.set(path.basename(seg), positions);
  }
  return map;
}

function logKind(line) {
  try {
    const kind = JSON.parse(line)?.kind;
    return typeof kind === "string" && kind ? kind : "event";
  } catch {
    return "event";
  }
}

/** A ledger line's snippet comes from its PAYLOAD, never from the record spine:
 *  the spine carries the writer and the conversation directory's own identity,
 *  which is exactly what a search result must not hand back. */
function logSnippet(line, needle) {
  try {
    const record = JSON.parse(line);
    return windowAround(JSON.stringify(record?.payload ?? null) ?? "", needle);
  } catch {
    return "";
  }
}

function windowAround(text, needle) {
  const value = String(text ?? "");
  const at = value.indexOf(needle);
  if (at === -1) return value.slice(0, SNIPPET_CAP);
  const start = Math.max(0, at - SNIPPET_WINDOW);
  const end = Math.min(value.length, at + needle.length + SNIPPET_WINDOW);
  const head = start > 0 ? "..." : "";
  const foot = end < value.length ? "..." : "";
  return `${head}${value.slice(start, end)}${foot}`.slice(0, SNIPPET_CAP);
}

// -- digs --------------------------------------------------------------------

const digSeen = new Map();

/** The default recorder: a read writes a `dig` into the conversation it read. */
export function recordDig(env = process.env, role = "reader") {
  return ({ conversationId, target, ref, by }) => {
    try {
      openConversation(conversationId, { role, env }).append({
        kind: "dig",
        payload: { target, ref, by },
      });
    } catch {
      /* a read must never fail because its own trace could not be written */
    }
  };
}

function noteDig(onDig, conversationId, target, ref) {
  if (typeof onDig !== "function") return;
  const key = `${conversationId} ${target} ${ref}`;
  const now = Date.now();
  const last = digSeen.get(key);
  if (last !== undefined && now - last < DIG_DEBOUNCE_MS) return;
  digSeen.set(key, now);
  if (digSeen.size > 5000) {
    for (const [seen, at] of digSeen) if (now - at >= DIG_DEBOUNCE_MS) digSeen.delete(seen);
  }
  try {
    onDig({ conversationId, target, ref, by: "human" });
  } catch {
    /* advisory */
  }
}

// -- plumbing ----------------------------------------------------------------

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > BODY_CAP_BYTES) {
      const err = new Error("request body exceeds 1 MB");
      err.code = "BODY_TOO_LARGE";
      throw err;
    }
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
  }
  return parsed;
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // a malformed escape stays verbatim and fails its own pattern
  }
}

function clampInt(value, fallback, min, max) {
  // An ABSENT parameter is not a zero: `Number(null)` is 0 and would silently
  // clamp an omitted `limit` down to `min`, turning every result page into one
  // row. Absence has to be tested before the number is.
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function logBytes(store) {
  let total = 0;
  for (const seg of store.logSegments()) {
    try {
      total += statSync(seg).size;
    } catch {
      /* rolled away between calls */
    }
  }
  return total;
}

function confinedTo(candidate, dir) {
  let realDir;
  try {
    realDir = realpathSync(dir);
  } catch {
    return false;
  }
  return candidate === realDir || candidate.startsWith(realDir + path.sep);
}

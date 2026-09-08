// A metadata projection of the canonical conversation ledger. Legacy channel
// thread files do not receive launcher turns. Cache file offsets and counters,
// never message bodies, so a rail poll reads only newly appended ledger bytes.
import fs from "node:fs";
import path from "node:path";

const cache = new Map();
const DECIDERS = new Set(["user-message", "stretch-started", "stretch-ended", "approval-requested", "conversation-opened"]);
const empty = () => ({ messageCount: 0, createdAt: null, updatedAt: null, title: null, cardId: null, decider: null });

function consume(meta, line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (typeof event.ts === "string" && Number.isFinite(Date.parse(event.ts))) {
    meta.createdAt ??= event.ts;
    meta.updatedAt = event.ts;
  }
  if (event.kind === "user-message" || (event.kind === "stretch-ended" && event.payload?.replyRef)) meta.messageCount += 1;
  if (event.kind === "conversation-opened" && typeof event.payload?.cardId === "string") meta.cardId = event.payload.cardId.slice(0, 128);
  if (event.kind === "conversation-opened" && typeof event.payload?.title === "string") meta.title = event.payload.title.trim().slice(0, 200);
  if (DECIDERS.has(event.kind)) meta.decider = { kind: event.kind, ts: event.ts, next: event.payload?.next };
}

function scan(file, stat, prior) {
  const state = prior && prior.ino === stat.ino && stat.size >= prior.offset
    && (stat.size !== prior.size || stat.mtimeMs === prior.mtimeMs)
    ? prior : { ino: stat.ino, offset: 0, meta: empty() };
  const fd = fs.openSync(file, "r");
  try {
    // A writer can rotate log.jsonl between the caller's stat and this open.
    // Never cache the new live file under the old rolled segment's identity.
    if (fs.fstatSync(fd).ino !== stat.ino) throw new Error("conversation log rotated before open");
    const buf = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let position = state.offset;
    let skipping = false;
    while (position < stat.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, stat.size - position), position);
      if (!n) break;
      position += n;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      let start = 0;
      for (let end = pending.indexOf(10); end !== -1; end = pending.indexOf(10, start)) {
        if (!skipping) consume(state.meta, pending.subarray(start, end).toString("utf8"));
        skipping = false;
        start = end + 1;
        state.offset = position - pending.length + start;
      }
      pending = pending.subarray(start);
      // Canonical payloads spill at 64KB. A corrupt unbounded record must not
      // turn a metadata poll into an unbounded allocation.
      if (pending.length > 256 * 1024) { pending = Buffer.alloc(0); skipping = true; }
    }
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    return state;
  } finally { fs.closeSync(fd); }
}

export function conversationListMeta(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter((name) => /^log(?:\.\d+)?\.jsonl$/.test(name)); }
  catch { return null; }
  files.sort((a, b) => a === "log.jsonl" ? 1 : b === "log.jsonl" ? -1
    : Number(a.split(".")[1]) - Number(b.split(".")[1]));
  const previous = cache.get(dir) ?? new Map();
  const next = new Map();
  const result = empty();
  for (const name of files) {
    try {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      // An immutable rolled segment keeps the live file's inode and cache.
      const prior = [...previous.values()].find((entry) => entry.ino === stat.ino);
      const state = prior?.size === stat.size && prior.mtimeMs === stat.mtimeMs ? prior : scan(file, stat, prior);
      next.set(name, state);
      result.messageCount += state.meta.messageCount;
      result.createdAt ??= state.meta.createdAt;
      if (state.meta.updatedAt) result.updatedAt = state.meta.updatedAt;
      if (state.meta.title) result.title = state.meta.title;
      if (state.meta.cardId) result.cardId = state.meta.cardId;
      if (state.meta.decider) result.decider = state.meta.decider;
    } catch { /* another process may roll a segment between readdir and open */ }
  }
  cache.delete(dir);
  cache.set(dir, next);
  while (cache.size > 500) cache.delete(cache.keys().next().value);
  return result.updatedAt ? result : null;
}

// Origin records + the durable per-origin event log (S3a, D8).
//
// An "origin" is where a run came from — a web thread, the board itself, the
// garrison skill/doorway, or a terminal. Every card carries an origin_id; the
// store keeps one record per origin under <kanbanRoot>/origins/:
//   <safe-origin-id>.json         { origin_id, transport, address, thread, createdAt }
//   <safe-origin-id>.events.jsonl append-only lifecycle events (all transports)
//
// origin_id format: "<transport>:<address>" (e.g. "web:<threadId>",
// "skill:<sessionId>"), or the literal "board" for a board-originated run. The
// events file is the durable record S3e's pull delivery (skill/terminal) reads.

import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const ORIGIN_TRANSPORTS = ["web", "board", "skill", "terminal"];

// Sanitize an origin_id into a safe filename (mirrors web-channel threads.mjs
// safeThreadId): filename-safe chars only, capped, with a short hash suffix when
// sanitising materially changed the id so distinct ids stay distinct on disk.
export function safeOriginId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "board";
  const cleaned = s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (cleaned !== s) {
    const h = createHash("sha256").update(s).digest("hex").slice(0, 8);
    return `${cleaned || "origin"}-${h}`;
  }
  return cleaned;
}

// Derive a card's origin_id: an explicit card.origin_id wins; else a web
// originChannel -> "web:<threadId>"; the garrison doorway -> "skill:unknown"; else
// the board.
export function deriveOriginId(card) {
  if (!card || typeof card !== "object") return "board";
  if (typeof card.origin_id === "string" && card.origin_id) return card.origin_id;
  const oc = card.originChannel;
  if (oc && oc.channel === "web" && typeof oc.threadId === "string" && oc.threadId) return `web:${oc.threadId}`;
  if (card.origin === "garrison-doorway") return "skill:unknown";
  return "board";
}

// Parse an origin_id into { transport, address }. Unknown/malformed -> board.
export function parseOriginId(origin_id) {
  if (typeof origin_id !== "string" || !origin_id || origin_id === "board") return { transport: "board", address: null };
  const i = origin_id.indexOf(":");
  if (i === -1) return { transport: "board", address: null };
  const transport = origin_id.slice(0, i);
  const address = origin_id.slice(i + 1) || null;
  return { transport: ORIGIN_TRANSPORTS.includes(transport) ? transport : "board", address: transport === "board" ? null : address };
}

function originsDir(root) {
  return path.join(root, "origins");
}

export function originRecordFile(root, origin_id) {
  return path.join(originsDir(root), `${safeOriginId(origin_id)}.json`);
}

export function originEventsFile(root, origin_id) {
  return path.join(originsDir(root), `${safeOriginId(origin_id)}.events.jsonl`);
}

// Write the origin record if it does not exist yet (idempotent). Returns true when
// a record was created. Never throws.
export function ensureOriginRecord(root, { origin_id, transport = null, address = null, thread = null } = {}) {
  try {
    if (!origin_id) return false;
    const file = originRecordFile(root, origin_id);
    if (existsSync(file)) return false;
    const parsed = parseOriginId(origin_id);
    const record = {
      origin_id,
      transport: transport ?? parsed.transport,
      address: address ?? parsed.address,
      thread: thread ?? null,
      createdAt: new Date().toISOString()
    };
    mkdirSync(originsDir(root), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

// Append one event to the origin's durable event log. Never throws.
export function appendOriginEvent(root, origin_id, event) {
  try {
    if (!origin_id) return false;
    mkdirSync(originsDir(root), { recursive: true });
    appendFileSync(originEventsFile(root, origin_id), JSON.stringify(event) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readOriginRecord(root, origin_id) {
  try {
    return JSON.parse(readFileSync(originRecordFile(root, origin_id), "utf8"));
  } catch {
    return null;
  }
}

export function readOriginEvents(root, origin_id) {
  try {
    return readFileSync(originEventsFile(root, origin_id), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// feedback-signals.mjs — the ONE reader of the shared feedback queue, and the
// documented home of the record-id format its three producers stamp.
//
// The queue used to be a file (~/.garrison/improver/feedback-queue.jsonl). It is
// now the state service's two append-only tables — `feedback_queue` and
// `feedback_tombstones` — reached through POST/GET /v1/feedback. Nothing else
// about the contract moved: the same three writers, the same record shapes, the
// same tombstone semantics.
//
// THREE concurrent writers append to it, each now through one transaction:
//   • the gateway's conversational overrides   (http-gateway/scripts/lib/feedback-queue.mjs
//                                               buildOverrideRecord, provenance "override")
//   • the Probe's answers + dismissals         (probe-core.mjs buildFeedbackRecord,
//                                               provenance "probe" / "retrospective")
//   • the Decisions panel's verdicts           (src/lib/decision-verdicts.ts
//                                               buildVerdictRecord, provenance "decision-verdict")
//
// Two consequences drive everything here.
//
// 1. DELETE IS A TOMBSTONE, NEVER A REWRITE. On the file this was a discipline
//    (filtering and rewriting raced all three appenders and silently lost the
//    tail). In the service it is structural: the API has no update and no delete
//    verb for either table, so a deletion can only be an append —
//    {target, reason} into `feedback_tombstones` — and the reader joins the named
//    rows out. The log stays append-only, which is also what keeps a deletion
//    auditable.
//
// 2. A RECORD NEEDS A STABLE HANDLE to be tombstoned. New records carry a minted
//    `id`, passed to the service so the id the producer stamped IS the row id.
//    The records written before ids existed have none, so the importer gave each
//    one a key DERIVED from its raw line and stored it in the `legacy_key`
//    column; a tombstone naming either the id or the legacy key hides the row.
//    That derivation is kept below, byte-identical, for two reasons: it is what
//    the importer computed, and it is what a transition read of a leftover
//    `*.pre-mesh` file would need.
//
// FAILURE IS LOUD. There is no file fallback and no local queue: a feedback loop
// that silently splits in two is worse than one that stops and says so. Every
// function here propagates StateUnavailableError.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { createStateClient } from "./state-client.mjs";

// ── The client ───────────────────────────────────────────────────────────────
// One per process, built lazily so importing this module never requires the node
// to be enrolled (the pure helpers below are used by tests and by producers that
// never read). Pass an explicit client to override — that is the seam the tests
// use, and it is why nothing here reads process.env at module scope.
let cachedClient = null;

export function feedbackClient(client = null) {
  if (client) return client;
  cachedClient ??= createStateClient({ readFileSync });
  return cachedClient;
}

/** Drop the cached client (token rotation, tests). */
export function resetFeedbackClient() {
  cachedClient = null;
}

// ── Paths ────────────────────────────────────────────────────────────────────
// PRE-MESH. The queue file is no longer read or written by anything on the live
// path; the importer renamed it `*.pre-mesh`. Kept because the path is still the
// honest answer to "where did this live before", and because a transition read
// of a leftover file needs it.
export function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length ? o : path.join(os.homedir(), ".garrison");
}

export function feedbackQueuePath() {
  return path.join(garrisonHome(), "improver", "feedback-queue.jsonl");
}

/** What `readFeedbackQueue` reports as its source, in place of a file path. */
export const FEEDBACK_SOURCE = "state-service:/v1/feedback";

// ── The id format (source of truth) ──────────────────────────────────────────
// `fq-<9 chars base36 millis>-<8 hex random>`. Fixed-width timestamp prefix so
// ids sort lexicographically by mint time (the ULID property the board's card
// ids rely on), 32 bits of randomness so two producers appending in the same
// millisecond do not collide.
//
// The service accepts a client-minted id and enforces it UNIQUE, so the id the
// producer stamps on the record is the row's primary key. Minting stays
// client-side because one of the three producers is a "use client"-reachable TS
// module that cannot import node:crypto at all — Web Crypto (`globalThis.crypto`)
// is the one RNG all three can call, which is why the format specifies it.
//
// Deliberately NOT the board's ulid.mjs: that lives in the kanban-loop fitting
// and cross-fitting imports are forbidden.
export const FEEDBACK_ID_PREFIX = "fq-";

export function mintFeedbackId(at) {
  const parsed = Date.parse(at ?? "");
  const ms = Number.isFinite(parsed) ? parsed : Date.now();
  const stamp = Math.max(0, ms).toString(36).padStart(9, "0").slice(-9);
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${FEEDBACK_ID_PREFIX}${stamp}-${rand}`;
}

// ── The derived key for id-less historical records ───────────────────────────
// sha256 of the raw line, TRIMMED (the only normalisation, since a reader may or
// may not have stripped the newline) and truncated to 32 hex chars — 128 bits,
// far more than enough to name one line of one file. The `raw:` prefix makes a
// tombstone self-describing: it says "this targets a line hash", not a minted id.
//
// BYTE-IDENTICAL to the importer's derivation (services/state/scripts/
// import-from-files.mjs) and to the shell's (src/lib/routing-tracks.ts). The
// importer stored the result in `legacy_key`, so a tombstone written against a
// key derived here still names the imported row.
//
// Two identical lines (the same answer given twice in the same millisecond)
// share a key and are deleted together. That is the honest behaviour: nothing
// on disk distinguished them, so nothing here can pretend to.
export const DERIVED_KEY_PREFIX = "raw:";

export function derivedKeyForLine(rawLine) {
  return `${DERIVED_KEY_PREFIX}${createHash("sha256").update(String(rawLine ?? "").trim()).digest("hex").slice(0, 32)}`;
}

/** The handle a tombstone can name: the record's minted id, else its line hash. */
export function keyForRecord(record, rawLine) {
  const id = record && typeof record.id === "string" ? record.id.trim() : "";
  return id.length ? id : derivedKeyForLine(rawLine);
}

// ── Tombstones ───────────────────────────────────────────────────────────────
export const TOMBSTONE_KIND = "tombstone";

export function isTombstone(record) {
  return Boolean(record) && typeof record === "object" && record.kind === TOMBSTONE_KIND;
}

export function buildTombstone({ target, at, reason } = {}) {
  const t = typeof target === "string" ? target.trim() : "";
  if (!t) return null;
  return {
    kind: TOMBSTONE_KIND,
    target: t,
    at: at ?? new Date().toISOString(),
    ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
  };
}

// ── Writing ──────────────────────────────────────────────────────────────────
/**
 * A record's service row. The payload is the legacy record VERBATIM — every
 * reader here reconstructs exactly what it used to read off the line, and no
 * producer has to learn a second shape.
 *
 * The promoted columns are a convenience for querying, never the truth:
 * `kind` carries the record's `provenance` (the discriminator every consumer
 * actually keys on). Rows imported from the pre-mesh file have `kind` NULL
 * because the importer mapped the file's own `kind` field, which real records
 * never carried — so `kind` is not a reliable filter ACROSS the import boundary
 * and readers must keep reading `payload.provenance`.
 */
export function feedbackRowFromRecord(record) {
  const rec = record && typeof record === "object" ? record : {};
  const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : undefined;
  const sessionId = typeof rec.session_id === "string" && rec.session_id.trim() ? rec.session_id.trim() : undefined;
  const kind = typeof rec.provenance === "string" && rec.provenance.trim() ? rec.provenance.trim() : undefined;
  const area = typeof rec.area === "string" && rec.area.trim() ? rec.area.trim() : undefined;
  return {
    ...(id ? { id } : {}),
    ...(kind ? { kind } : {}),
    ...(area ? { area } : {}),
    ...(sessionId ? { sessionId } : {}),
    payload: rec,
  };
}

/**
 * Append one record. Returns the service's {id, seq}.
 *
 * The single-`appendFile` atomicity the file relied on is now a transaction, so
 * two producers appending in the same millisecond can no longer interleave — and
 * a duplicate id is a 409 rather than a silent second copy.
 */
export async function appendFeedbackRecord(record, { client } = {}) {
  return feedbackClient(client).appendFeedback(feedbackRowFromRecord(record));
}

/** Delete one record: append a tombstone naming its key. Never a rewrite. */
export async function tombstoneFeedbackRecord(target, { reason, client } = {}) {
  const t = typeof target === "string" ? target.trim() : "";
  if (!t) throw new Error("tombstoneFeedbackRecord: target is required");
  return feedbackClient(client).tombstoneFeedback(t, reason ?? null);
}

// ── Reading ──────────────────────────────────────────────────────────────────
const PAGE_SIZE = 500;
/** How many rows a read walks before it stops. Paged, so this is a ceiling on
 *  work rather than a silent truncation at the service's default page. */
export const DEFAULT_READ_LIMIT = 5000;

async function listPaged(client, { includeTombstoned, limit }) {
  const out = [];
  let sinceSeq = 0;
  while (out.length < limit) {
    const size = Math.min(PAGE_SIZE, limit - out.length);
    const page = await client.listFeedback({ sinceSeq, limit: size, includeTombstoned });
    if (!page.length) break;
    out.push(...page);
    sinceSeq = page[page.length - 1].seq;
    // The tombstone join happens in SQL BEFORE the LIMIT, so a short page means
    // the scan reached the end — not that the rest was filtered out.
    if (page.length < size) break;
  }
  return out;
}

/**
 * One service row as the entry shape every reader here already spoke.
 *
 * `key` is the handle a tombstone names: the legacy key when the row was
 * imported id-less, else the row id (which is the producer's minted id). That is
 * `keyForRecord` expressed in columns.
 *
 * Two fields are honestly degraded from the file era and say so:
 *   • `raw` is the record re-serialised, not the byte-exact source line. Nothing
 *     reads it to derive a key any more — the key comes off the row.
 *   • `lineNumber` is the service `seq`, which is the same thing it always meant:
 *     this record's position in the one append-only order.
 */
export function entryFromRow(row, { tombstoned = false } = {}) {
  const record = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const legacy = typeof row?.legacyKey === "string" && row.legacyKey.trim() ? row.legacyKey.trim() : "";
  return {
    key: legacy || String(row?.id ?? ""),
    record,
    raw: JSON.stringify(record),
    seq: row?.seq ?? null,
    lineNumber: row?.seq ?? null,
    tombstoned,
    // The service exposes no read verb for `feedback_tombstones`, so WHEN a row
    // was deleted and WHY are not retrievable — only THAT it was. Null rather
    // than invented.
    tombstonedBy: null,
  };
}

/**
 * Read the queue.
 *
 * Returns { entries, tombstones, source } in FILE-ERA shape so every consumer
 * keeps its reader. `entries` excludes nothing by default (the service's join
 * already dropped the tombstoned rows); with `includeTombstoned` the deleted
 * rows come back too, flagged — which is what the Signals view needs to show a
 * deletion rather than hide it.
 *
 * `tombstones` is DERIVED from the rows a tombstone hid, not read from the
 * tombstone table (which has no read verb). It therefore counts deleted RECORDS,
 * not tombstone rows — the two differ only for a tombstone that named nothing,
 * which `tombstoneSignal` refuses to write.
 */
export async function readFeedbackQueue({ client, limit = DEFAULT_READ_LIMIT, includeTombstoned = false } = {}) {
  const c = feedbackClient(client);
  const live = await listPaged(c, { includeTombstoned: false, limit });
  if (!includeTombstoned) {
    return { entries: live.map((r) => entryFromRow(r)), tombstones: [], source: FEEDBACK_SOURCE };
  }
  const all = await listPaged(c, { includeTombstoned: true, limit });
  const liveIds = new Set(live.map((r) => r.id));
  const entries = all.map((r) => entryFromRow(r, { tombstoned: !liveIds.has(r.id) }));
  const tombstones = entries
    .filter((e) => e.tombstoned)
    .map((e) => ({ kind: TOMBSTONE_KIND, target: e.key }));
  return { entries, tombstones, source: FEEDBACK_SOURCE };
}

/** The records a consumer should actually learn from: everything not deleted. */
export function liveRecords(entries) {
  return (entries ?? []).filter((e) => !e.tombstoned).map((e) => e.record);
}

// ── The pre-mesh line parser ─────────────────────────────────────────────────
/**
 * Parse queue TEXT into entries in file order. OFF THE LIVE READ PATH — the
 * service is the queue now — and kept for exactly one job: reading a leftover
 * `feedback-queue.jsonl(.pre-mesh)` during a transition, where the tombstone
 * resolution and the derived-key semantics still have to be the ones the
 * importer used.
 *
 * Two passes are unavoidable there: a tombstone is appended AFTER the record it
 * deletes, so nothing can be decided about line N until the whole file is read.
 *
 * Returns { entries, tombstones }, where an entry is
 *   { key, record, raw, lineNumber, tombstoned, tombstonedBy }
 * `entries` excludes the tombstone lines themselves (they are not signals) and
 * unparseable lines.
 */
export function parseFeedbackQueue(text) {
  const rows = [];
  const tombstones = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue; // malformed line: skipped, never fatal
    }
    if (isTombstone(record)) {
      tombstones.push({ ...record, lineNumber: i + 1 });
      continue;
    }
    rows.push({ key: keyForRecord(record, raw), record, raw, lineNumber: i + 1 });
  }
  const byTarget = new Map();
  for (const t of tombstones) if (typeof t.target === "string") byTarget.set(t.target, t);
  const entries = rows.map((r) => {
    const t = byTarget.get(r.key) ?? null;
    return { ...r, tombstoned: Boolean(t), tombstonedBy: t };
  });
  return { entries, tombstones };
}

// ── What a record currently feeds ────────────────────────────────────────────
// The Signals view has to answer "why is this row here / what does deleting it
// change?", and the honest answer names the two consumers by name.
//
// MIRROR — SOURCE OF TRUTH: src/lib/routing-tracks.ts `evidenceFromVerdict`.
// That reader folds verdicts into the autonomy bands on the home page. It is
// TypeScript in the shell and cannot be imported from a fitting, so the rule is
// replicated here and `tests/improver-signals.test.ts` runs BOTH over the same
// producer-built fixtures and asserts they agree. Change one without the other
// and that test fails — which is the only reason this duplication is allowed.
const VERDICT_PROVENANCE = "decision-verdict";
const str = (v) => (typeof v === "string" && v.trim().length > 0 ? v : null);
const submap = (v) => (!v || typeof v !== "object" || Array.isArray(v) ? {} : v);

export function trackContributionForRecord(record) {
  if (!record || typeof record !== "object") return [];
  if (str(record.provenance) !== VERDICT_PROVENANCE) return [];
  const verdict = str(record.answer);
  if (verdict !== "right" && verdict !== "wrong") return []; // incl. "unsure": inert by design
  const original = submap(record.original);
  const applied = submap(record.applied);
  const shape = str(original.flow) ?? str(original.duty) ?? "unknown";
  if (verdict === "right") {
    return [
      { category: "flow", shape, signal: "explicit-confirmation" },
      { category: "level", shape, signal: "explicit-confirmation" },
    ];
  }
  const out = [];
  if (str(applied.flow)) out.push({ category: "flow", shape, signal: "explicit-negative" });
  if (str(applied.tier) || str(applied.duty)) out.push({ category: "level", shape, signal: "explicit-negative" });
  if (!out.length) {
    out.push(
      { category: "flow", shape, signal: "explicit-negative" },
      { category: "level", shape, signal: "explicit-negative" }
    );
  }
  return out;
}

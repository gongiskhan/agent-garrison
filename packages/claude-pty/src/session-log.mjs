// The append-only session log — Garrison's native session substrate (Harness
// Ideas Adoption Brief, 2026-08-22, topic 1).
//
// One JSONL file per Operative run under $GARRISON_HOME/session-logs/. Every
// SDK message and every Garrison injection is appended here BEFORE anyone
// consumes it; the context window is a projection derived elsewhere — this
// file is ground truth, not a context mechanism and not RAG.
//
// Deliberately runtime-neutral (topic 6): events carry {domain, turn, kind,
// payload} plus an optional runtime session id under the neutral name
// `runtimeSessionId`. No Agent SDK specifics in the schema, so any future
// ACP-speaking runtime slots into the same choke point.
//
// Compaction follows shadow-don't-delete: a superseding event is appended with
// `shadowOf: <seq>`; nothing is ever rewritten or removed. Readers treat a
// shadowed seq as superseded but still searchable.
//
// Single-writer discipline: the gateway process owns a run's file (in-process
// runtime adapters share its writer). Out-of-process fittings do not write —
// their injections reach the gateway and are logged there.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Domains, per the brief: only `session`-domain events feed prompt
 *  derivation; everything else is bookkeeping around it. */
export const LOG_DOMAINS = ["session", "agent", "tools", "channel", "automation", "api", "lifecycle"];

const PAYLOAD_CAP_BYTES = 256 * 1024;

export function sessionLogDir(env = process.env) {
  const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  return path.join(home, "session-logs");
}

export function sessionLogPath(runId, env = process.env) {
  const safe = String(runId).replace(/[^A-Za-z0-9._@-]+/g, "_").slice(0, 160);
  return path.join(sessionLogDir(env), `${safe}.jsonl`);
}

/** Cap a payload for storage. Truncation is EXPLICIT: a capped payload is
 *  replaced by {truncated: true, bytes, head} so the log never silently lies
 *  about carrying the whole thing. */
export function capPayload(payload, cap = PAYLOAD_CAP_BYTES) {
  let text;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = JSON.stringify(String(payload));
  }
  if (text === undefined) return null;
  if (Buffer.byteLength(text, "utf8") <= cap) return payload;
  return { truncated: true, bytes: Buffer.byteLength(text, "utf8"), head: text.slice(0, cap) };
}

export class SessionLog {
  /** @param {string} runId  @param {{env?: object}} [opts] */
  constructor(runId, opts = {}) {
    this.runId = String(runId);
    this.file = sessionLogPath(this.runId, opts.env ?? process.env);
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.seq = this.#lastSeqOnDisk() + 1;
  }

  #lastSeqOnDisk() {
    try {
      if (!existsSync(this.file)) return -1;
      const text = readFileSync(this.file, "utf8");
      const nl = text.lastIndexOf("\n", text.length - 2);
      const lastLine = text.slice(nl + 1).trim();
      if (!lastLine) return -1;
      const parsed = JSON.parse(lastLine);
      return Number.isInteger(parsed?.seq) ? parsed.seq : -1;
    } catch {
      return -1;
    }
  }

  /**
   * Append one event. Returns the event's seq (or -1 when the write failed —
   * the log must never take the runtime down with it).
   * @param {{domain: string, kind: string, turn?: string|null,
   *          runtimeSessionId?: string|null, payload?: unknown,
   *          shadowOf?: number}} evt
   */
  append(evt) {
    const seq = this.seq;
    const record = {
      v: 1,
      seq,
      ts: new Date().toISOString(),
      run: this.runId,
      domain: LOG_DOMAINS.includes(evt.domain) ? evt.domain : "lifecycle",
      turn: evt.turn ?? null,
      kind: String(evt.kind ?? "event"),
      ...(evt.runtimeSessionId ? { runtimeSessionId: String(evt.runtimeSessionId) } : {}),
      ...(Number.isInteger(evt.shadowOf) ? { shadowOf: evt.shadowOf } : {}),
      payload: capPayload(evt.payload ?? null),
    };
    try {
      // One O_APPEND write per record: a single appendFileSync is one write()
      // under the hood, so single-writer appends never interleave partially.
      appendFileSync(this.file, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
      this.seq = seq + 1;
      return seq;
    } catch {
      return -1;
    }
  }

  /** Shadow-don't-delete: append a superseding event for `seq`. */
  shadow(seq, evt) {
    return this.append({ ...evt, shadowOf: seq });
  }
}

// ── The process-wide run log (the gateway opens it; adapters share it) ──────

let _runLog = null;

/** The current process's run log, lazily opened from GARRISON_SESSION_LOG_RUN.
 *  Null when no run identity is configured — callers must tolerate that (the
 *  log is additive; nothing may fail because it is absent). */
export function runLog(env = process.env) {
  if (_runLog) return _runLog;
  const runId = env.GARRISON_SESSION_LOG_RUN?.trim();
  if (!runId) return null;
  try {
    _runLog = new SessionLog(runId, { env });
    return _runLog;
  } catch {
    return null;
  }
}

/** Test seam. */
export function resetRunLog() {
  _runLog = null;
}

// ── Readers (the viewer + future consumers: improver, kanban, search) ───────

export function listRuns(env = process.env) {
  const dir = sessionLogDir(env);
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => {
        const st = statSync(path.join(dir, n));
        return { runId: n.slice(0, -6), bytes: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

/** Read up to `limit` complete events from the opaque cursor `offset`
 *  (0 = start). A partial trailing line stays unread and is re-read on the
 *  next poll (the readJsonlLines discipline). Pass the returned offset back
 *  verbatim to continue. */
export function readEvents(runId, { offset = 0, limit = 500, env = process.env } = {}) {
  const file = sessionLogPath(runId, env);
  try {
    const text = readFileSync(file, "utf8");
    let pos = Math.max(0, Number(offset) || 0);
    const events = [];
    while (events.length < limit) {
      const nl = text.indexOf("\n", pos);
      if (nl === -1) break;
      const line = text.slice(pos, nl).trim();
      pos = nl + 1;
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip torn line */ }
    }
    return { events, offset: pos };
  } catch {
    return { events: [], offset };
  }
}

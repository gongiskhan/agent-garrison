// The conversation store — Garrison Conversations' single source of truth
// (Conversations plan, 2026-08-26). One directory per conversation under
// $GARRISON_HOME/conversations/<id>/:
//
//   summary.md          L1 — one page, five fixed sections, exit-gate-written
//   handoffs/0001.json  L2 — one structured handoff per stretch, ordinal files
//   log.jsonl           L3 — append-only ledger, multi-process, greppable
//   log.<ms>.jsonl      L3 — rolled segments (immutable once rolled)
//   payloads/           L3 — content-addressed spill + named raw copies
//   .current-stretch    write guard: the stretch that owns L1 right now
//
// Unlike the per-run session log (session-log.mjs, single-writer), FOUR
// processes append here: the gateway (launcher/exit gate), the kanban board
// server (card events), the web-channel server (user messages, digs) and the
// codex bridge (delegations). The discipline that makes that safe:
//
//   - one appendFileSync per record = one O_APPEND write(2): concurrent
//     writers interleave BETWEEN records, never within one.
//   - ORDER IS LINE ORDER. `seq` is per-writer diagnostics (counts from 0 on
//     the open handle, never read from disk — a gap proves a lost record, it
//     does not order anything). Readers assign the stable coordinate `index`
//     (= line number across segments) at read time; the UI's jump target.
//   - payloads over 64KB spill to payloads/<sha16>.json and the record carries
//     a verifiable {spilled, bytes, sha256} pointer — never a lossy truncate.
//   - the log rolls at 64MB into an immutable log.<ms>.jsonl segment. Nothing
//     is ever dropped or rewritten.
//
// Event kinds (the ledger vocabulary; unknown kinds are stored verbatim so the
// vocabulary can grow without redeploying every writer):
//   conversation-opened, stretch-started, stretch-ended, handoff,
//   delegation-dispatched, delegation-returned, delegation-failed,
//   user-message, card-materialized, card-state-changed, policy-rewrite,
//   escalation, summary-trimmed, dig
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ulid } from "./ulid.mjs";

export const PAYLOAD_INLINE_CAP_BYTES = 64 * 1024;
export const LOG_ROLL_BYTES = 64 * 1024 * 1024;
export const SUMMARY_MAX_BYTES = 6000;
export const SUMMARY_MAX_LINES = 80;

export const CONVERSATION_EVENT_KINDS = [
  "conversation-opened",
  "stretch-started",
  "stretch-ended",
  "handoff",
  "delegation-dispatched",
  "delegation-returned",
  "delegation-failed",
  "user-message",
  "card-materialized",
  "card-state-changed",
  "policy-rewrite",
  "escalation",
  "summary-trimmed",
  "dig",
];

// ── paths ───────────────────────────────────────────────────────────────────

export function conversationsDir(env = process.env) {
  const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  return path.join(home, "conversations");
}

export function safeConversationId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 128);
}

export function conversationDir(id, env = process.env) {
  return path.join(conversationsDir(env), safeConversationId(id));
}

/** Mint a conversation id. A card that materializes from this conversation
 *  TAKES this id as its card id — one identity, per the Conversations plan. */
export function newConversationId(now = Date.now()) {
  return ulid(now);
}

export function listConversations(env = process.env) {
  const dir = conversationsDir(env);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const p = path.join(dir, d.name, "log.jsonl");
        try {
          const st = statSync(p);
          return { id: d.name, bytes: st.size, mtime: st.mtime.toISOString() };
        } catch {
          return { id: d.name, bytes: 0, mtime: null };
        }
      })
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  } catch {
    return [];
  }
}

// ── the store ───────────────────────────────────────────────────────────────

export function openConversation(id, { role = "unknown", env = process.env } = {}) {
  return new ConversationStore(id, { role, env });
}

export class ConversationStore {
  constructor(id, { role = "unknown", env = process.env } = {}) {
    this.id = safeConversationId(id);
    this.role = String(role);
    this.env = env;
    this.dir = conversationDir(this.id, env);
    this.logFile = path.join(this.dir, "log.jsonl");
    this.seq = 0; // per-writer; NEVER read from disk (order is line order)
  }

  #ensureDirs() {
    mkdirSync(path.join(this.dir, "handoffs"), { recursive: true });
    mkdirSync(path.join(this.dir, "payloads"), { recursive: true });
  }

  /** Idempotent: creates the directory skeleton, seeds L1 when absent, and
   *  emits `conversation-opened` exactly once (guarded by the marker file). */
  init({ title = "Conversation", objective = "", origin = null, cardId = null } = {}) {
    this.#ensureDirs();
    const marker = path.join(this.dir, ".opened");
    if (existsSync(marker)) return { ok: true, opened: false };
    const summaryFile = path.join(this.dir, "summary.md");
    if (!existsSync(summaryFile)) {
      const seed = renderSummary({
        title,
        objective: objective || "(not yet written — the triage stretch writes this)",
        currentState: "New conversation. No stretch has run yet.",
        decisions: [],
        activeConstraints: [],
        escalationFloor: {},
      });
      writeFileSync(summaryFile, seed, "utf8");
    }
    try {
      writeFileSync(marker, new Date().toISOString(), { flag: "wx" });
    } catch {
      return { ok: true, opened: false };
    }
    this.append({ kind: "conversation-opened", payload: { title, origin, cardId } });
    return { ok: true, opened: true };
  }

  /**
   * Append one ledger event. Returns {ok, ts, seq} — never throws (the store
   * must never take a runtime down with it).
   * @param {{kind: string, stretch?: string|null, duty?: string|null,
   *          runId?: string|null, turn?: string|null, payload?: unknown}} evt
   */
  append(evt) {
    const ts = new Date().toISOString();
    try {
      this.#ensureDirs();
      this.#maybeRoll();
      const record = {
        v: 1,
        ts,
        conversation: this.id,
        writer: `${this.role}:${process.pid}`,
        seq: this.seq,
        kind: String(evt?.kind ?? "event"),
        ...(evt?.stretch ? { stretch: String(evt.stretch) } : {}),
        ...(evt?.duty ? { duty: String(evt.duty) } : {}),
        ...(evt?.runId ? { runId: String(evt.runId) } : {}),
        ...(evt?.turn ? { turn: String(evt.turn) } : {}),
        payload: this.#inlineOrSpill(evt?.payload ?? null),
      };
      appendFileSync(this.logFile, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
      this.seq += 1;
      return { ok: true, ts, seq: record.seq };
    } catch (err) {
      return { ok: false, ts, seq: -1, error: err?.message };
    }
  }

  #inlineOrSpill(payload) {
    let text;
    try {
      text = JSON.stringify(payload);
    } catch {
      // Unserializable (cycles, exotic objects): store its string form — the
      // record itself must always serialize.
      return { unserializable: true, text: String(payload) };
    }
    if (text === undefined) return null;
    if (Buffer.byteLength(text, "utf8") <= PAYLOAD_INLINE_CAP_BYTES) return payload;
    const { ref, bytes, sha256 } = this.spillPayload(payload);
    return { spilled: ref, bytes, sha256 };
  }

  /** Roll the live log into an immutable segment past LOG_ROLL_BYTES. The
   *  rename is race-tolerant: when two writers roll at once, one rename wins
   *  and the loser's ENOENT is swallowed — both then append to the fresh log. */
  #maybeRoll() {
    try {
      const st = statSync(this.logFile);
      if (st.size < LOG_ROLL_BYTES) return;
      const rolled = path.join(this.dir, `log.${Date.now()}.jsonl`);
      renameSync(this.logFile, rolled);
    } catch {
      /* absent file or lost race — either way, append to log.jsonl */
    }
  }

  /** All log segments, oldest first, live log last. Rolled segments are
   *  immutable, so global line indexes are stable forever. */
  logSegments() {
    let names = [];
    try {
      names = readdirSync(this.dir).filter((n) => /^log\.\d+\.jsonl$/.test(n));
    } catch {
      return [];
    }
    names.sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));
    const segs = names.map((n) => path.join(this.dir, n));
    if (existsSync(this.logFile)) segs.push(this.logFile);
    return segs;
  }

  #readAllEvents() {
    const events = [];
    let index = 0;
    for (const seg of this.logSegments()) {
      let text;
      try {
        text = readFileSync(seg, "utf8");
      } catch {
        continue;
      }
      let pos = 0;
      while (true) {
        const nl = text.indexOf("\n", pos);
        if (nl === -1) break; // torn tail stays unread until complete
        const line = text.slice(pos, nl).trim();
        pos = nl + 1;
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          parsed.index = index;
          events.push(parsed);
        } catch {
          /* torn or corrupt line: still consumes an index slot? No — only
             parsed records get indexes, and a corrupt line inside an immutable
             segment stays corrupt, so numbering stays stable. */
          continue;
        }
        index += 1;
      }
    }
    return events;
  }

  tail(n = 100, { kinds = null } = {}) {
    const all = this.#readAllEvents();
    const filtered = kinds ? all.filter((e) => kinds.includes(e.kind)) : all;
    return filtered.slice(-n);
  }

  range({ fromIndex = 0, limit = 500 } = {}) {
    const all = this.#readAllEvents();
    const events = all.filter((e) => e.index >= fromIndex).slice(0, limit);
    const nextIndex = events.length ? events[events.length - 1].index + 1 : fromIndex;
    return { events, nextIndex, total: all.length };
  }

  grep(pattern, { kinds = null, limit = 50 } = {}) {
    const re = pattern instanceof RegExp ? pattern : null;
    const needle = re ? null : String(pattern).toLowerCase();
    const out = [];
    for (const e of this.#readAllEvents()) {
      if (kinds && !kinds.includes(e.kind)) continue;
      const line = JSON.stringify(e);
      const hit = re ? re.test(line) : line.toLowerCase().includes(needle);
      if (hit) {
        out.push(e);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  count(kind, { duty = null, sinceIndex = 0 } = {}) {
    return this.#readAllEvents().filter(
      (e) => e.kind === kind && e.index >= sinceIndex && (duty == null || e.duty === duty)
    ).length;
  }

  // ── L1: summary.md ────────────────────────────────────────────────────────

  summaryPath() {
    return path.join(this.dir, "summary.md");
  }

  readSummary() {
    try {
      return readFileSync(this.summaryPath(), "utf8");
    } catch {
      return null;
    }
  }

  parseSummary() {
    const text = this.readSummary();
    return text == null ? null : parseSummary(text);
  }

  /**
   * Write L1. REFUSES an over-cap write (a silent truncate can drop the
   * escalation floor) and refuses a writer that does not hold the stretch
   * marker — the exit gate is the only L1 writer while a stretch is open.
   * Accepts a parsed summary object or raw markdown.
   */
  writeSummary(summary, { stretchId = null } = {}) {
    const current = this.currentStretch();
    if (current && stretchId !== current) {
      return { ok: false, reason: "not-current-stretch", holder: current };
    }
    const text = typeof summary === "string" ? summary : renderSummary(summary);
    const bytes = Buffer.byteLength(text, "utf8");
    const lines = text.split("\n").length;
    if (bytes > SUMMARY_MAX_BYTES || lines > SUMMARY_MAX_LINES) {
      return { ok: false, reason: "over-cap", bytes, lines };
    }
    this.#ensureDirs();
    const tmp = `${this.summaryPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, this.summaryPath());
    return { ok: true, bytes, lines };
  }

  /** Cap-enforcing fallback: keep Objective + Current state whole, the LAST n
   *  decisions/constraints, the WHOLE escalation floor. Emits summary-trimmed
   *  with a payload ref of the pre-trim text. */
  trimSummary(parsed, { stretchId = null } = {}) {
    const pre = renderSummary(parsed);
    const dropped = [];
    let decisions = [...(parsed.decisions ?? [])];
    let constraints = [...(parsed.activeConstraints ?? [])];
    let candidate = { ...parsed, decisions, activeConstraints: constraints };
    const fits = (c) => {
      const t = renderSummary(c);
      return Buffer.byteLength(t, "utf8") <= SUMMARY_MAX_BYTES && t.split("\n").length <= SUMMARY_MAX_LINES;
    };
    while (!fits(candidate) && (decisions.length > 3 || constraints.length > 3)) {
      if (decisions.length > 3) dropped.push(`decision: ${decisions.shift()}`);
      else dropped.push(`constraint: ${constraints.shift()}`);
      candidate = { ...parsed, decisions, activeConstraints: constraints };
    }
    const spill = this.spillPayload({ preTrimSummary: pre });
    this.append({
      kind: "summary-trimmed",
      stretch: stretchId,
      payload: { dropped, preTrimRef: spill.ref },
    });
    return this.writeSummary(candidate, { stretchId });
  }

  // ── L2: handoffs ──────────────────────────────────────────────────────────

  handoffOrdinals() {
    try {
      return readdirSync(path.join(this.dir, "handoffs"))
        .map((n) => /^(\d{4})\.json$/.exec(n)?.[1])
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  nextHandoffOrdinal() {
    const ords = this.handoffOrdinals();
    return (ords[ords.length - 1] ?? 0) + 1;
  }

  handoffPath(ordinal) {
    return path.join(this.dir, "handoffs", `${String(ordinal).padStart(4, "0")}.json`);
  }

  readHandoff(ordinal) {
    try {
      return JSON.parse(readFileSync(this.handoffPath(ordinal), "utf8"));
    } catch {
      return null;
    }
  }

  writeHandoff(ordinal, handoff) {
    this.#ensureDirs();
    const file = this.handoffPath(ordinal);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(handoff, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
    return file;
  }

  lastHandoffs(n = 3) {
    return this.handoffOrdinals()
      .slice(-n)
      .map((ordinal) => ({ ordinal, handoff: this.readHandoff(ordinal) }))
      .filter((h) => h.handoff);
  }

  // ── L3: payloads ──────────────────────────────────────────────────────────

  /** Content-addressed spill. Same content = same file; write skipped. */
  spillPayload(obj) {
    this.#ensureDirs();
    let text;
    try {
      text = JSON.stringify(obj);
    } catch {
      text = JSON.stringify(String(obj));
    }
    const sha256 = createHash("sha256").update(text).digest("hex");
    const name = `${sha256.slice(0, 16)}.json`;
    const file = path.join(this.dir, "payloads", name);
    if (!existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, file);
    }
    return { ref: `payloads/${name}`, bytes: Buffer.byteLength(text, "utf8"), sha256 };
  }

  /** Named raw copy (delegation outputs, stretch replies). Capped; a capped
   *  write is EXPLICIT: the file carries the head and the return says so. */
  writeNamedPayload(name, content, { maxBytes = 1024 * 1024 } = {}) {
    this.#ensureDirs();
    const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160);
    const file = path.join(this.dir, "payloads", safe);
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    const bytes = Buffer.byteLength(text, "utf8");
    const truncated = bytes > maxBytes;
    const body = truncated ? text.slice(0, maxBytes) : text;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, file);
    return { ref: `payloads/${safe}`, bytes, truncated };
  }

  /** Read a payload by its `payloads/<name>` ref. Refuses refs that escape. */
  readPayload(ref) {
    const m = /^payloads\/([A-Za-z0-9._-]{1,160})$/.exec(String(ref));
    if (!m) return null;
    try {
      const text = readFileSync(path.join(this.dir, "payloads", m[1]), "utf8");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      return null;
    }
  }

  // ── write guard ───────────────────────────────────────────────────────────

  #markerPath() {
    return path.join(this.dir, ".current-stretch");
  }

  claimStretch(stretchId) {
    this.#ensureDirs();
    try {
      writeFileSync(this.#markerPath(), String(stretchId), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  releaseStretch(stretchId) {
    try {
      if (readFileSync(this.#markerPath(), "utf8").trim() === String(stretchId)) {
        unlinkSync(this.#markerPath());
        return true;
      }
    } catch {
      /* absent = already released */
    }
    return false;
  }

  currentStretch() {
    try {
      return readFileSync(this.#markerPath(), "utf8").trim() || null;
    } catch {
      return null;
    }
  }
}

// ── summary.md structural parse/render ──────────────────────────────────────

const SUMMARY_SECTIONS = ["Objective", "Current state", "Decisions", "Active constraints", "Escalation floor"];

export function parseSummary(text) {
  const lines = String(text).split("\n");
  const out = {
    title: "Conversation",
    objective: "",
    currentState: "",
    decisions: [],
    activeConstraints: [],
    escalationFloor: {},
  };
  let section = null;
  const prose = { Objective: [], "Current state": [] };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1 && section === null) {
      out.title = h1[1].trim();
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      section = SUMMARY_SECTIONS.find((s) => s.toLowerCase() === h2[1].trim().toLowerCase()) ?? h2[1].trim();
      continue;
    }
    if (!section) continue;
    if (section === "Objective" || section === "Current state") {
      prose[section].push(line);
    } else if (section === "Decisions" || section === "Active constraints") {
      const item = /^-\s+(.+)$/.exec(line.trim());
      if (item) (section === "Decisions" ? out.decisions : out.activeConstraints).push(item[1]);
    } else if (section === "Escalation floor") {
      const parsedLine = parseEscalationFloorLine(line);
      if (parsedLine) out.escalationFloor[parsedLine.duty] = parsedLine;
    }
  }
  out.objective = prose.Objective.join("\n").trim();
  out.currentState = prose["Current state"].join("\n").trim();
  return out;
}

function parseEscalationFloorLine(line) {
  const m = /^-\s+([a-z0-9-]+):\s+([a-z0-9-]+)(?:\s+\(raised\s+([^\s]+)\s+-\s+(.+)\))?$/i.exec(line.trim());
  if (!m) return null;
  return { duty: m[1], rung: m[2], raisedAt: m[3] ?? null, reason: m[4] ?? null };
}

export function parseEscalationFloor(text) {
  return parseSummary(text).escalationFloor;
}

export function renderSummary({
  title = "Conversation",
  objective = "",
  currentState = "",
  decisions = [],
  activeConstraints = [],
  escalationFloor = {},
} = {}) {
  const floorLines = Object.values(escalationFloor).map((f) =>
    f.raisedAt ? `- ${f.duty}: ${f.rung} (raised ${f.raisedAt} - ${f.reason ?? "unspecified"})` : `- ${f.duty}: ${f.rung}`
  );
  return [
    `# ${title}`,
    "",
    "## Objective",
    objective.trim(),
    "",
    "## Current state",
    currentState.trim(),
    "",
    "## Decisions",
    ...decisions.map((d) => `- ${d}`),
    "",
    "## Active constraints",
    ...activeConstraints.map((c) => `- ${c}`),
    "",
    "## Escalation floor",
    ...floorLines,
    "",
  ].join("\n");
}

// ── handoff schema ──────────────────────────────────────────────────────────

export const HANDOFF_STATUSES = ["complete", "partial", "blocked", "failed"];
export const EVIDENCE_KINDS = ["file", "commit", "run", "gate", "artifact", "url", "log"];
// Kinds whose refs must resolve to a non-empty file on disk (rule 10 — the
// anti-fabrication guard: a handoff claiming evidence that is not there is
// INVALID, replacing the engine's old hasEvidence/gate-freshness predicates).
const RESOLVABLE_KINDS = ["file", "gate", "run"];

export function defaultResolveEvidence(cwd = process.cwd()) {
  return (ref) => {
    const p = path.isAbsolute(ref) ? ref : path.join(cwd, ref);
    try {
      const st = statSync(p);
      return { exists: st.isFile() && st.size > 0, bytes: st.size };
    } catch {
      return { exists: false, bytes: 0 };
    }
  };
}

/**
 * Validate a stretch handoff. Missing KEY = invalid; `[]` is valid where an
 * array is required (the D19 discipline: emptiness must be stated, never
 * implied by absence).
 */
export function validateHandoff(obj, { selectedDuties = [], resolveEvidence = null } = {}) {
  const errors = [];
  const resolved = [];
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["handoff is not an object"], resolved };

  if (!HANDOFF_STATUSES.includes(obj.status)) {
    errors.push(`status must be one of ${HANDOFF_STATUSES.join("|")}`);
  }
  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    errors.push("summary must be a non-empty string");
  } else if (obj.summary.length > 4000) {
    errors.push("summary exceeds 4000 chars");
  }

  if (!Array.isArray(obj.evidenceRefs)) {
    errors.push("evidenceRefs must be an array (empty allowed, absent not)");
  } else {
    for (const [i, ev] of obj.evidenceRefs.entries()) {
      if (!ev || typeof ev !== "object" || !EVIDENCE_KINDS.includes(ev.kind) || typeof ev.ref !== "string" || !ev.ref.trim()) {
        errors.push(`evidenceRefs[${i}] must be {kind in ${EVIDENCE_KINDS.join("|")}, ref}`);
      }
    }
  }

  const validNext = new Set([...selectedDuties, "done", "needs-input"]);
  if (!obj.nextSteps || typeof obj.nextSteps !== "object") {
    errors.push("nextSteps must be an object {next, why, items}");
  } else {
    if (!validNext.has(obj.nextSteps.next)) {
      errors.push(`nextSteps.next must be a selected duty or done|needs-input (got ${JSON.stringify(obj.nextSteps.next)})`);
    }
    if (typeof obj.nextSteps.why !== "string" || !obj.nextSteps.why.trim()) {
      errors.push("nextSteps.why must be a non-empty string");
    }
    if (!Array.isArray(obj.nextSteps.items)) errors.push("nextSteps.items must be an array");
  }

  if (!("blocker" in obj)) {
    errors.push("blocker key is mandatory (null when there is none)");
  } else if (obj.blocker !== null) {
    if (
      typeof obj.blocker !== "object" ||
      typeof obj.blocker.what !== "string" ||
      !obj.blocker.what.trim() ||
      typeof obj.blocker.needs !== "string" ||
      !obj.blocker.needs.trim()
    ) {
      errors.push("blocker must be null or {what, needs, who?} with non-empty what/needs");
    }
  }

  for (const key of ["activeConstraints", "surprises"]) {
    if (!Array.isArray(obj[key])) errors.push(`${key} must be an array (empty allowed, absent not)`);
  }
  if (!Array.isArray(obj.failedApproaches)) {
    errors.push("failedApproaches must be an array (empty allowed, absent not)");
  } else {
    for (const [i, fa] of obj.failedApproaches.entries()) {
      if (!fa || typeof fa !== "object" || typeof fa.approach !== "string" || !fa.approach.trim() || typeof fa.why !== "string" || !fa.why.trim()) {
        errors.push(`failedApproaches[${i}] must be {approach, why}`);
      }
    }
  }

  // Cross-rules: the empty-is-a-failure discipline applied to prose.
  if (obj.status === "blocked" && obj.blocker == null) {
    errors.push("status blocked requires a blocker");
  }
  if ((obj.status === "partial" || obj.status === "failed") && (!Array.isArray(obj.failedApproaches) || obj.failedApproaches.length < 1)) {
    errors.push(`status ${obj.status} requires at least one failedApproaches entry`);
  }
  if (obj.nextSteps?.next === "done" && obj.status !== "complete") {
    errors.push("next done requires status complete");
  }

  // Rule 10 — evidence resolution on disk.
  if (Array.isArray(obj.evidenceRefs) && resolveEvidence) {
    for (const ev of obj.evidenceRefs) {
      if (!ev || !RESOLVABLE_KINDS.includes(ev.kind) || typeof ev.ref !== "string") continue;
      const r = resolveEvidence(ev.ref) ?? { exists: false, bytes: 0 };
      resolved.push({ ref: ev.ref, kind: ev.kind, exists: !!r.exists, bytes: r.bytes ?? 0 });
      if (!r.exists) errors.push(`evidence ${ev.kind} ref does not resolve to a non-empty file: ${ev.ref}`);
    }
  }

  return { ok: errors.length === 0, errors, resolved };
}

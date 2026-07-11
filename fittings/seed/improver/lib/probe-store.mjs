// probe-store.mjs — the Improver Probe's I/O (paths, reads, atomic queue append,
// pending lifecycle, stale-pending sweep). Every function here touches disk; the
// pure logic lives in probe-core.mjs. Kept dependency-light (node builtins only)
// so the Stop-hook path stays fast and the module installs cleanly into the
// improver fitting's own dir (containment: probe machinery lives HERE).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { dayStamp, buildFeedbackRecord } from "./probe-core.mjs";

// ── Paths (env-overridable for tests + non-default homes) ────────────────────
export function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length ? o : path.join(os.homedir(), ".garrison");
}

export function dataDir() {
  const o = process.env.IMPROVER_DATA;
  return o && o.trim().length ? o : path.join(garrisonHome(), "improver");
}

// Shared with the gateway's override writer — MUST be byte-identical to
// http-gateway/scripts/lib/feedback-queue.mjs improverQueuePath() so probe,
// retrospective and override records land in ONE queue the nightly rule reads.
export function queuePath() {
  return path.join(garrisonHome(), "improver", "feedback-queue.jsonl");
}

export function pendingPath() {
  return path.join(dataDir(), "probe-pending.json");
}

export function muteFlagPath(now) {
  return path.join(dataDir(), `probe-mute-${dayStamp(now)}`);
}

export function retroFlagPath(now) {
  return path.join(dataDir(), `retro-${dayStamp(now)}`);
}

export function skipLogPath() {
  return path.join(dataDir(), "probe-skip.log");
}

function claudeHome() {
  const o = process.env.GARRISON_CLAUDE_HOME?.trim();
  return o && o.length ? o : path.join(os.homedir(), ".claude");
}

// ── Input reads (tolerant: never throw, absent/garbage → empty) ──────────────
export function readSessionsState() {
  const p = process.env.GARRISON_SESSIONS_STATE || path.join(garrisonHome(), "sessions", "state.json");
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function readPolicy() {
  const p = process.env.GARRISON_POLICY_PATH || path.join(garrisonHome(), "orchestrator", "policy.json");
  return JSON.parse(readFileSync(p, "utf8")); // caller wants a LOUD failure when the policy is unreadable
}

// The two goal-sentinel homes (RUN_SPEC A5). Returns the paths that actually
// exist for this session, so probe-core.hasGoalSentinel can defer to the loop.
export function goalSentinelPaths(sessionId) {
  if (!sessionId) return [];
  const home = os.homedir();
  const candidates = [
    path.join(garrisonHome(), "sentinels", `${sessionId}.json`),
    path.join(home, ".autothing", "sentinels", `${sessionId}.json`),
  ];
  return candidates.filter((p) => existsSync(p));
}

// Read the composition's decisions.jsonl tail (E11). The composition dir is
// GARRISON_COMPOSITION_DIR (set by the runner) or an explicit override.
export function readDecisionsTail({ compositionDir, maxLines = 200 } = {}) {
  const dir = compositionDir || process.env.GARRISON_COMPOSITION_DIR;
  if (!dir) return [];
  const p = path.join(dir, ".garrison", "decisions.jsonl");
  return readJsonlTail(p, maxLines);
}

export function readTranscriptTail(transcriptPath, maxLines = 60) {
  if (!transcriptPath) return [];
  return readJsonlTail(transcriptPath, maxLines);
}

function readJsonlTail(file, maxLines) {
  if (!file || !existsSync(file)) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean);
  const tail = lines.slice(-maxLines);
  const out = [];
  for (const l of tail) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip unparseable line */
    }
  }
  return out;
}

// ── Kanban cards (best-effort, for classification + retrospective) ───────────
export function collectCards(cap = 500) {
  const root = process.env.GARRISON_KANBAN_DIR || path.join(garrisonHome(), "kanban-loop");
  const cardsDir = path.join(root, "cards");
  const cards = [];
  if (!existsSync(cardsDir)) return cards;
  let entries = [];
  try {
    entries = readdirSync(cardsDir, { withFileTypes: true });
  } catch {
    return cards;
  }
  for (const e of entries) {
    if (!e.isDirectory() || cards.length >= cap) continue;
    const f = path.join(cardsDir, e.name, "card.json");
    if (!existsSync(f)) continue;
    try {
      cards.push(JSON.parse(readFileSync(f, "utf8")));
    } catch {
      /* unreadable card — skip */
    }
  }
  return cards;
}

// ── Mute / retrospective flags ───────────────────────────────────────────────
export function isMutedToday(now) {
  return existsSync(muteFlagPath(now));
}

export function hasRetroFlagToday(now) {
  return existsSync(retroFlagPath(now));
}

export function touchRetroFlag(now) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(retroFlagPath(now), new Date(now || Date.now()).toISOString(), "utf8");
}

// ── Pending lifecycle ────────────────────────────────────────────────────────
export function readPending() {
  const p = pendingPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function writePending(pending) {
  mkdirSync(dataDir(), { recursive: true });
  const p = pendingPath();
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(pending, null, 2), "utf8");
  renameSync(tmp, p);
}

export function clearPending() {
  const p = pendingPath();
  if (!existsSync(p)) return;
  try {
    rmSync(p, { force: true });
  } catch {
    // last resort: empty the file — readPending() treats an empty/garbage file as "none"
    try {
      writeFileSync(p, "", "utf8");
    } catch {
      /* ignore */
    }
  }
}

// ── Atomic feedback-queue append ─────────────────────────────────────────────
// One O_APPEND write per record (the atomicity the routing telemetry relies on).
// A single appendFileSync with flag "a" is a single write() under the hood, so
// concurrent single-writer appends never interleave a partial line.
export function appendFeedbackSync(record, file = queuePath()) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
  return file;
}

// ── Stale-pending sweep (D26 dismissed) ──────────────────────────────────────
// A pending older than maxAgeMs (default 90s) means the AskUserQuestion was
// dismissed / timed out (Escape yields no PostToolUse capture). Write ONE explicit
// dismissed record per unanswered question so Escape is distinguishable from an
// answer, then clear the pending. Returns the dismissed records (for logging/tests).
export function sweepStalePending({ now, maxAgeMs = 90_000 } = {}) {
  const pending = readPending();
  if (!pending || !pending.askedAt) return { swept: false, records: [] };
  const age = Date.parse(now || new Date().toISOString()) - Date.parse(pending.askedAt);
  if (!(age >= maxAgeMs)) return { swept: false, records: [], fresh: true };
  const records = [];
  for (const q of Array.isArray(pending.questions) ? pending.questions : []) {
    const rec = buildFeedbackRecord({
      session_id: pending.session_id,
      area: q.area,
      question: q.question,
      options: q.options,
      answer: "dismissed",
      classification: q.classification,
      card_id: q.card_id,
      provenance: pending.mode === "retrospective" ? "retrospective" : "probe",
      at: now || new Date().toISOString(),
    });
    appendFeedbackSync(rec);
    records.push(rec);
  }
  clearPending();
  return { swept: true, records };
}

// ── Skip logging (fail LOUD, never silent) ───────────────────────────────────
export function logSkip(line, now) {
  const stamped = `${now || new Date().toISOString()} ${line}\n`;
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(skipLogPath(), stamped, "utf8");
  } catch {
    /* ignore — still surfaced on stderr below */
  }
  process.stderr.write(`probe-skip: ${line}\n`);
}

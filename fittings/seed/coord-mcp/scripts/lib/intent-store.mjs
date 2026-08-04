// Per-repo intent store — sessions declare an intent ("I'm about to touch <area>
// for <reason>") so overlapping work by other sessions surfaces as a conflict in
// the digest. Repo-scoped: a session only ever sees its own repo's intents.
//
// Ledger: ~/.garrison/coord/intents/<repoSlug>.jsonl (append-only)
//   { repo, session, area, files, reason, ts }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { repoSlug } from "./repo.mjs";
import { withinLookback } from "./lookback.mjs";

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}
function intentDir() {
  return path.join(garrisonHome(), "coord", "intents");
}
function intentPath(repo) {
  return path.join(intentDir(), `${repoSlug(repo)}.jsonl`);
}

// Shared mutation protocol with kanban-loop/lib/coordination.mjs. Append and
// read-modify-write callers take the same bakery-ticket lock; rewrites land by
// atomic rename, so a Kanban refresh/removal cannot erase a concurrent coord-mcp
// row. Every acquisition owns a unique ticket pathname. The elected owner also
// holds a PID-prefixed `<ledger>.lock` bridge so an already-running pre-ticket
// writer remains mutually exclusive during a rolling upgrade.
const INTENT_LOCK_TIMEOUT_MS = 5000;
const INTENT_LOCK_STALE_MS = 30000;
const INTENT_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const INTENT_CHOOSING_PREFIX = "choosing-";
const INTENT_TICKET_PREFIX = "ticket-";
const INTENT_RECORD_SUFFIX = ".json";
function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === "EPERM"; }
}

function ledgerTicketDir(file) {
  return `${file}.lock.tickets`;
}

function ledgerLockToken() {
  return `${process.pid}-${crypto.randomBytes(16).toString("hex")}`;
}

function ledgerRecordName(prefix, token) {
  return `${prefix}${token}${INTENT_RECORD_SUFFIX}`;
}

function ledgerTokenFromName(name, prefix) {
  if (!name.startsWith(prefix) || !name.endsWith(INTENT_RECORD_SUFFIX)) return null;
  const token = name.slice(prefix.length, -INTENT_RECORD_SUFFIX.length);
  return /^[0-9]+-[0-9a-f]{32}$/.test(token) ? token : null;
}

function activeLedgerLockRecords(dir, prefix) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const active = [];
  for (const name of names) {
    const token = ledgerTokenFromName(name, prefix);
    if (!token) continue;
    const recordFile = path.join(dir, name);
    let row = null;
    let stat = null;
    try {
      row = JSON.parse(fs.readFileSync(recordFile, "utf8"));
      stat = fs.statSync(recordFile);
    } catch {
      try { stat = fs.statSync(recordFile); } catch { continue; }
    }
    const valid =
      row &&
      row.token === token &&
      Number.isInteger(row.pid) &&
      row.pid > 0 &&
      (prefix !== INTENT_TICKET_PREFIX || Number.isSafeInteger(row.number) && row.number > 0);
    if (valid && ownerAlive(row.pid)) {
      active.push(row);
      continue;
    }
    if (valid || stat && Date.now() - stat.mtimeMs > INTENT_LOCK_STALE_MS) {
      try {
        fs.rmSync(recordFile, { force: true });
        continue;
      } catch {
        active.push({ token, invalid: true });
        continue;
      }
    }
    // Fresh partial writes block until readable or stale; never fail open across
    // the O_EXCL-create -> record-write visibility window.
    active.push({ token, invalid: true });
  }
  return active;
}

function legacyLedgerLockBlocks(file) {
  const lock = `${file}.lock`;
  try {
    const raw = fs.readFileSync(lock, "utf8");
    const stat = fs.statSync(lock);
    const owner = Number.parseInt(raw, 10);
    if (Number.isInteger(owner) && ownerAlive(owner)) return true;
    if (Number.isInteger(owner) || Date.now() - stat.mtimeMs > INTENT_LOCK_STALE_MS) {
      try {
        fs.rmSync(lock, { force: true });
        return false;
      } catch {
        return true;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function legacyLedgerBridgeRecord(token) {
  return `${process.pid}:${token}`;
}

function tryAcquireLegacyLedgerBridge(file, token) {
  const lock = `${file}.lock`;
  const record = legacyLedgerBridgeRecord(token);
  try {
    fs.writeFileSync(lock, record, { flag: "wx" });
    return record;
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
}

function releaseLegacyLedgerBridge(file, record) {
  if (!record) return;
  const lock = `${file}.lock`;
  try {
    if (fs.readFileSync(lock, "utf8") !== record) return;
    fs.rmSync(lock, { force: true });
  } catch {
    // A missing/replaced bridge no longer belongs to this generation.
  }
}

export function withLedgerLock(file, fn) {
  const dir = ledgerTicketDir(file);
  fs.mkdirSync(dir, { recursive: true });
  const token = ledgerLockToken();
  const choosingFile = path.join(dir, ledgerRecordName(INTENT_CHOOSING_PREFIX, token));
  const ticketFile = path.join(dir, ledgerRecordName(INTENT_TICKET_PREFIX, token));
  const deadline = Date.now() + INTENT_LOCK_TIMEOUT_MS;
  let ticketCreated = false;
  let legacyBridge = null;
  try {
    fs.writeFileSync(choosingFile, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
    const existing = activeLedgerLockRecords(dir, INTENT_TICKET_PREFIX);
    const number = existing.reduce((max, row) => Number.isSafeInteger(row.number) ? Math.max(max, row.number) : max, 0) + 1;
    fs.writeFileSync(ticketFile, JSON.stringify({ pid: process.pid, token, number }), { flag: "wx" });
    ticketCreated = true;
    fs.rmSync(choosingFile, { force: true });

    for (;;) {
      const choosing = activeLedgerLockRecords(dir, INTENT_CHOOSING_PREFIX);
      const tickets = activeLedgerLockRecords(dir, INTENT_TICKET_PREFIX);
      const owner = tickets
        .filter((row) => Number.isSafeInteger(row.number))
        .sort((a, b) => a.number - b.number || a.token.localeCompare(b.token))[0];
      const ownTicketPresent = tickets.some((row) => row.token === token);
      const everyTicketReadable = tickets.every((row) => Number.isSafeInteger(row.number));
      if (choosing.length === 0 && everyTicketReadable && ownTicketPresent && owner?.token === token && !legacyLedgerLockBlocks(file)) {
        legacyBridge = tryAcquireLegacyLedgerBridge(file, token);
        if (legacyBridge) return fn();
      }
      if (Date.now() > deadline) throw new Error(`coordination intent ledger lock timeout: ${file}`);
      Atomics.wait(INTENT_LOCK_WAIT, 0, 0, 10);
    }
  } finally {
    releaseLegacyLedgerBridge(file, legacyBridge);
    // Unique generation paths: a stale breaker may already have removed ours,
    // but this finally can never unlink the ticket of a later acquisition.
    try { fs.rmSync(choosingFile, { force: true }); } catch {}
    if (ticketCreated) {
      try { fs.rmSync(ticketFile, { force: true }); } catch {}
    }
  }
}
function atomicRewrite(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

export function declareIntent(repo, entry) {
  const row = {
    repo,
    session: entry.session || "unknown",
    area: entry.area || "",
    files: Array.isArray(entry.files) ? entry.files : [],
    reason: entry.reason || "",
    ts: entry.ts || new Date().toISOString()
  };
  const file = intentPath(repo);
  withLedgerLock(file, () => fs.appendFileSync(file, JSON.stringify(row) + "\n"));
  return row;
}

export function readIntents(repo) {
  let txt = "";
  try {
    txt = fs.readFileSync(intentPath(repo), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* partial trailing line — skip */
    }
  }
  return out;
}

export function recentIntents(repo, now = new Date()) {
  return readIntents(repo).filter((i) => withinLookback(i.ts, now));
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// Two intents overlap if they name the same area, if one area contains the other
// (so a free-text prompt mentioning another session's specific area/path counts —
// length-guarded to avoid trivial false positives), if an area mentions a file, or
// if any file paths share/prefix.
export function intentsOverlap(a, b) {
  const aArea = norm(a.area);
  const bArea = norm(b.area);
  const SPECIFIC = 4; // min length for a containment match (avoids "x" matching everything)
  if (aArea && bArea) {
    if (aArea === bArea) return true;
    if (bArea.length >= SPECIFIC && aArea.includes(bArea)) return true;
    if (aArea.length >= SPECIFIC && bArea.includes(aArea)) return true;
  }
  const fa = a.files || [];
  const fb = b.files || [];
  if (aArea && fb.some((f) => f && f.length >= SPECIFIC && aArea.includes(norm(f)))) return true;
  if (bArea && fa.some((f) => f && f.length >= SPECIFIC && bArea.includes(norm(f)))) return true;
  return fa.some((x) => fb.some((y) => x === y || x.startsWith(y + "/") || y.startsWith(x + "/")));
}

// Recent intents by OTHER sessions whose area/files overlap the given intent —
// i.e. potential conflicts the caller should know about before proceeding.
export function conflictsFor(repo, mine, now = new Date()) {
  return recentIntents(repo, now).filter((i) => i.session !== mine.session && intentsOverlap(i, mine));
}

// Cleanup (used by the canary to remove its synthetic intents).
export function removeIntentsBySession(repo, session) {
  const file = intentPath(repo);
  withLedgerLock(file, () => {
    const kept = readIntents(repo).filter((i) => i.session !== session);
    atomicRewrite(file, kept.map((i) => JSON.stringify(i)).join("\n") + (kept.length ? "\n" : ""));
  });
}

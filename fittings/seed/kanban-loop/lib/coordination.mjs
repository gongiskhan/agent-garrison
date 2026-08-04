// coordination.mjs — same-branch multi-run coordination for the kanban loop
// (GARRISON-FLOW-V2 S1, plan-coord-engine Q1-Q4 + Q8).
//
// Multiple autonomous runs coexist on the same project and branch with no
// worktrees. Each run's PLAN phase predicts a touch-set (the files/dirs it will
// modify). When a run's plan completes the engine registers that touch-set,
// scores it against every other LIVE same-project run's touch-set, and either
// lets the run proceed (no/light overlap) or defers it behind the earlier run
// (medium -> wait until the earlier run's first-review stability; heavy -> wait
// until it is terminal). Ordering is total and acyclic: the EARLIER run is the
// one whose plan completed first (planCompletedAt; ties broken by runId ULID),
// so no two runs can each wait on the other.
//
// This module owns: touch-set IO + validation, the overlap scorer, the policy
// coordination section (with code defaults so an un-recompiled policy still
// works), the plan-completion wait decision, the waiting re-evaluation, the
// stability predicate, the coord-mcp intents-ledger writer (a FILE protocol,
// not a code dependency — rows are appended in coord-mcp's wire format so
// interactive coord-mcp sessions see kanban claims for free), the D9
// availability probe + serialize gate, and the project -> repo-path resolver.
//
// It depends only on the leaf storage (board.mjs) and read-only policy/discover
// helpers — never on engine.mjs — so the dependency runs one way (engine.mjs
// imports THIS; this never imports engine.mjs) and there is no import cycle.
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  openSync,
  closeSync,
  rmSync,
  renameSync,
  statSync
} from "node:fs";
import { saveCardCAS, updateCardCAS, loadCard, loadAllCards, withCardLock } from "./board.mjs";
import { loadPolicy, policyLoadState } from "./policy.mjs";
import { listProjects, readDevRoot } from "./discover.mjs";

// ── policy coordination section ──────────────────────────────────────────────
//
// Every default lives here so S1/S2 do not depend on the composer work (S6) that
// will surface these keys — an absent or partial policy.coordination merges over
// these and behaves identically to the shipped defaults.
export const DEFAULT_COORDINATION = {
  enabled: true,
  thresholds: { heavyFiles: 3, heavyRatio: 0.5 },
  fences: { enabled: true, trailer: "Garrison-Card" },
  leaseTtlMinutes: 60,
  serializeWhenUnavailable: true,
  // Always-exclusive paths (D6): any card whose touch-set covers one of these
  // must hold its exclusive lease even when the prediction forgot to list it.
  // The real list is policy-seeded (composer-owned); the code default keeps an
  // un-recompiled policy safe.
  exclusiveLeases: []
};

// Merge policy.coordination (if any) over the code defaults. A null/garbage
// policy or missing section yields the pure defaults.
export function coordinationConfig(policy) {
  const c = policy && typeof policy.coordination === "object" && policy.coordination ? policy.coordination : {};
  return {
    ...DEFAULT_COORDINATION,
    ...c,
    thresholds: { ...DEFAULT_COORDINATION.thresholds, ...(c.thresholds || {}) },
    fences: { ...DEFAULT_COORDINATION.fences, ...(c.fences || {}) }
  };
}

// ── touch-set artifact (Q1) ────────────────────────────────────────────────

// Normalise to a posix, repo-relative path: strip a leading ./, leading slashes,
// and any trailing slash, and turn backslashes into forward slashes so a
// Windows-style prediction still compares.
function normPath(p) {
  return String(p == null ? "" : p)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function normStrings(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
}

function normPaths(v) {
  return normStrings(v).map(normPath).filter(Boolean);
}

// A path claim is UNSAFE when it is absolute or contains a `..` traversal segment:
// it purports to be repo-relative but escapes the repo. S2 feeds these paths
// straight into scoped `git add`, so an escaping claim is a schema violation, not
// something to silently normalise away. Checked on the RAW string (before the
// leading-slash strip in normPath would hide an absolute path).
function isUnsafePath(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/\\/g, "/");
  if (!s) return false; // empty entries are dropped by normStrings, not a violation
  if (s.startsWith("/")) return true; // posix absolute
  if (/^[A-Za-z]:/.test(s)) return true; // windows drive-absolute
  return s.split("/").some((seg) => seg === ".."); // any traversal segment
}

// Return an actionable schema diagnostic instead of collapsing every invalid
// artifact into "missing". Absolute paths remain forbidden in the repo-scoped
// path fields because fences pass those claims to git. Work that deliberately
// lives outside the project repository is represented as an opaque surface
// claim (for example `filesystem:/tmp/my-workspace`) so overlap ordering still
// works without ever handing an external path to git.
export function touchSetValidationIssue(obj) {
  if (!obj || typeof obj !== "object") return "the file must contain a JSON object";
  if (obj.version !== 1) return "the object must use schema version 1";
  for (const field of ["files", "dirs", "exclusive"]) {
    const values = obj[field];
    if (!Array.isArray(values)) continue;
    const unsafe = values.find((x) => typeof x === "string" && isUnsafePath(x));
    if (unsafe == null) continue;
    const raw = String(unsafe).trim().replace(/\\/g, "/");
    const problem = raw.startsWith("/") || /^[A-Za-z]:/.test(raw)
      ? "absolute paths are not allowed"
      : "parent-directory traversal (`..`) is not allowed";
    return (
      `${field} contains ${JSON.stringify(String(unsafe).slice(0, 240))}: ${problem}. ` +
      `files, dirs, and exclusive are repo-relative Git claims. For work outside the project repo, ` +
      `leave those arrays empty and claim the external workspace in surfaces, for example ` +
      `\"surfaces\":[\"filesystem:/absolute/workspace\"]`
    );
  }
  return null;
}

export function touchSetPath(runDir) {
  return path.join(runDir, "touch-set.json");
}

// Validate + normalise a parsed touch-set object (schema version 1). Returns the
// normalised touch-set, or null when it is missing/invalid (wrong version, not an
// object). Content may be sparse — an empty prediction is a valid schema; it
// simply scores `none` against everything.
export function validateTouchSet(obj) {
  if (touchSetValidationIssue(obj)) return null;
  return {
    version: 1,
    cardId: typeof obj.cardId === "string" ? obj.cardId : null,
    runId: typeof obj.runId === "string" ? obj.runId : null,
    project: typeof obj.project === "string" ? obj.project : null,
    predictedAt: typeof obj.predictedAt === "string" ? obj.predictedAt : null,
    files: normPaths(obj.files),
    dirs: normPaths(obj.dirs),
    surfaces: normStrings(obj.surfaces),
    exclusive: normPaths(obj.exclusive),
    notes: typeof obj.notes === "string" ? obj.notes : ""
  };
}

// Read + validate with a reason suitable for a retry prompt / card timeline.
// The public readTouchSet compatibility helper below intentionally keeps its
// historical `TouchSet | null` shape for every existing coordination caller.
export function inspectTouchSet(runDir) {
  if (!runDir || typeof runDir !== "string") {
    return { touchSet: null, issue: "the card has no run directory" };
  }
  const file = touchSetPath(runDir);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const issue = err?.code === "ENOENT"
      ? "touch-set.json is missing"
      : `touch-set.json is unreadable or invalid JSON: ${String(err?.message || err).slice(0, 240)}`;
    return { touchSet: null, issue };
  }
  const issue = touchSetValidationIssue(parsed);
  return issue
    ? { touchSet: null, issue }
    : { touchSet: validateTouchSet(parsed), issue: null };
}

// Read + validate a card's touch-set from <runDir>/touch-set.json. Best-effort:
// a missing/unreadable/invalid file returns null (the caller treats a null as
// "this run has not declared a touch-set yet").
export function readTouchSet(runDir) {
  return inspectTouchSet(runDir).touchSet;
}

// ── overlap scorer (Q2) ────────────────────────────────────────────────────

function underDir(file, dir) {
  if (!dir) return false;
  return file === dir || file.startsWith(dir + "/");
}

// Directory claims that overlap by a prefix relation (equal, or one under the
// other). Returns the shorter (broader) claim of each overlapping pair, deduped.
function dirOverlaps(aDirs, bDirs) {
  const out = new Set();
  for (const da of aDirs) {
    for (const db of bDirs) {
      if (da === db || da.startsWith(db + "/") || db.startsWith(da + "/")) {
        out.add(da.length <= db.length ? da : db);
      }
    }
  }
  return [...out];
}

// Pure overlap grade between two touch-sets. Returns the grade plus the concrete
// shared paths/surfaces so the caller can explain the decision honestly.
//   heavy  - a shared exclusive lease, OR >= heavyFiles shared exact files, OR
//            shared files >= heavyRatio of the smaller file set.
//   medium - >= 1 shared exact file, >= 1 shared surface, or one card's file
//            falls under the other's dir claim.
//   light  - dir claims overlap (prefix) but no shared files/surfaces.
//   none   - otherwise.
export function scoreOverlap(a, b, thresholds = DEFAULT_COORDINATION.thresholds) {
  const heavyFiles = Number.isFinite(thresholds?.heavyFiles) ? thresholds.heavyFiles : DEFAULT_COORDINATION.thresholds.heavyFiles;
  const heavyRatio = Number.isFinite(thresholds?.heavyRatio) ? thresholds.heavyRatio : DEFAULT_COORDINATION.thresholds.heavyRatio;

  const aFiles = (a?.files || []).map(normPath);
  const bFiles = (b?.files || []).map(normPath);
  const aDirs = (a?.dirs || []).map(normPath);
  const bDirs = (b?.dirs || []).map(normPath);
  const aExcl = new Set((a?.exclusive || []).map(normPath));
  const bExcl = new Set((b?.exclusive || []).map(normPath));
  const aSurf = new Set(normStrings(a?.surfaces));
  const bSurf = new Set(normStrings(b?.surfaces));

  const bFileSet = new Set(bFiles);
  const sharedFiles = [...new Set(aFiles.filter((f) => bFileSet.has(f)))];
  const sharedSurfaces = [...aSurf].filter((s) => bSurf.has(s));
  const sharedExclusive = [...aExcl].filter((f) => bExcl.has(f));
  const sharedDirs = dirOverlaps(aDirs, bDirs);
  const fileUnderDir =
    aFiles.some((f) => bDirs.some((d) => underDir(f, d))) ||
    bFiles.some((f) => aDirs.some((d) => underDir(f, d)));

  const smaller = Math.min(aFiles.length, bFiles.length) || 1;
  const ratio = sharedFiles.length / smaller;

  let grade = "none";
  if (
    sharedExclusive.length > 0 ||
    sharedFiles.length >= heavyFiles ||
    (sharedFiles.length > 0 && ratio >= heavyRatio)
  ) {
    grade = "heavy";
  } else if (sharedFiles.length >= 1 || sharedSurfaces.length >= 1 || fileUnderDir) {
    grade = "medium";
  } else if (sharedDirs.length > 0) {
    grade = "light";
  }
  return { grade, sharedFiles, sharedDirs, sharedSurfaces, sharedExclusive };
}

// ── repo resolution + intents ledger (Q1 registration, Q5 resolver) ─────────

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}
function coordDir() {
  return path.join(garrisonHome(), "coord");
}
function intentDir() {
  return path.join(coordDir(), "intents");
}

// Stable short slug for the per-repo ledger file. This reimplements the CONTRACT
// in fittings/seed/coord-mcp/scripts/lib/repo.mjs (sha1 of the absolute repo path,
// first 16 hex chars) rather than importing across fittings — the two must stay
// byte-identical so a coord-mcp session and the kanban engine key the same repo to
// the same ledger file.
function repoSlug(repoPath) {
  return crypto.createHash("sha1").update(path.resolve(repoPath)).digest("hex").slice(0, 16);
}
function intentPath(repoPath) {
  return path.join(intentDir(), `${repoSlug(repoPath)}.jsonl`);
}

// Shared file protocol with coord-mcp's intent-store.mjs. Every ledger mutation
// takes the same Lamport bakery-ticket lock, and every rewrite is temp+rename. A
// ticket owns a unique pathname, so ticket cleanup can remove only that generation.
// The elected owner also holds a PID-prefixed legacy bridge so already-running
// pre-ticket writers remain mutually exclusive during rollout. Keep the path,
// prefix, record, bridge, and ordering protocol compatible with intent-store.mjs.
const INTENT_LOCK_TIMEOUT_MS = 5000;
const INTENT_LOCK_STALE_MS = 30000;
const INTENT_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const MUTATION_CHOOSING_PREFIX = "choosing-";
const MUTATION_TICKET_PREFIX = "ticket-";
const MUTATION_RECORD_SUFFIX = ".json";
function intentOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === "EPERM"; }
}

function mutationLockToken() {
  return `${process.pid}-${crypto.randomBytes(16).toString("hex")}`;
}
function mutationRecordName(prefix, token) {
  return `${prefix}${token}${MUTATION_RECORD_SUFFIX}`;
}
function mutationTokenFromName(name, prefix) {
  if (!name.startsWith(prefix) || !name.endsWith(MUTATION_RECORD_SUFFIX)) return null;
  const token = name.slice(prefix.length, -MUTATION_RECORD_SUFFIX.length);
  return /^[0-9]+-[0-9a-f]{32}$/.test(token) ? token : null;
}
function activeMutationLockRecords(dir, prefix, staleMs) {
  let names;
  try { names = readdirSync(dir); }
  catch { return []; }
  const active = [];
  for (const name of names) {
    const token = mutationTokenFromName(name, prefix);
    if (!token) continue;
    const recordFile = path.join(dir, name);
    let row = null;
    let stat = null;
    try {
      row = JSON.parse(readFileSync(recordFile, "utf8"));
      stat = statSync(recordFile);
    } catch {
      try { stat = statSync(recordFile); } catch { continue; }
    }
    const valid =
      row &&
      row.token === token &&
      Number.isInteger(row.pid) &&
      row.pid > 0 &&
      (prefix !== MUTATION_TICKET_PREFIX || Number.isSafeInteger(row.number) && row.number > 0);
    if (valid && intentOwnerAlive(row.pid)) {
      active.push(row);
      continue;
    }
    if (valid || stat && Date.now() - stat.mtimeMs > staleMs) {
      try {
        // recordFile contains the unique generation token. Delayed cleanup can
        // never name a successor acquisition.
        rmSync(recordFile, { force: true });
        continue;
      } catch {
        active.push({ token, invalid: true });
        continue;
      }
    }
    // A fresh partial record blocks until readable or stale; never fail open in
    // the O_EXCL-create -> record-write visibility window.
    active.push({ token, invalid: true });
  }
  return active;
}
function legacyMutationLockBlocks(lock, staleMs) {
  try {
    const raw = readFileSync(lock, "utf8");
    const stat = statSync(lock);
    let pid;
    try { pid = Number.parseInt(JSON.parse(raw)?.pid, 10); }
    catch { pid = Number.parseInt(raw, 10); }
    if (Number.isInteger(pid) && intentOwnerAlive(pid)) return true;
    if (Number.isInteger(pid) || Date.now() - stat.mtimeMs > staleMs) {
      try {
        // No current owner exists, so the elected ticket may replace this stale
        // legacy generation with its own PID-prefixed bridge.
        rmSync(lock, { force: true });
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
function legacyMutationBridgeRecord(token) {
  // Pre-ticket writers parse the leading PID; new writers compare the complete
  // record before release so they never intentionally unlink another generation.
  return `${process.pid}:${token}`;
}
function tryAcquireLegacyMutationBridge(lock, token) {
  const record = legacyMutationBridgeRecord(token);
  try {
    writeFileSync(lock, record, { flag: "wx" });
    return record;
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
}
function releaseLegacyMutationBridge(lock, record) {
  if (!record) return;
  try {
    if (readFileSync(lock, "utf8") !== record) return;
    rmSync(lock, { force: true });
  } catch {
    // A missing/replaced bridge no longer belongs to this generation.
  }
}
function withMutationTicketLock({ lock, ticketDir, timeoutMs, staleMs, label }, fn) {
  mkdirSync(ticketDir, { recursive: true });
  const token = mutationLockToken();
  const choosingFile = path.join(ticketDir, mutationRecordName(MUTATION_CHOOSING_PREFIX, token));
  const ticketFile = path.join(ticketDir, mutationRecordName(MUTATION_TICKET_PREFIX, token));
  const deadline = Date.now() + timeoutMs;
  let ticketCreated = false;
  let legacyBridge = null;
  try {
    writeFileSync(choosingFile, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
    const existing = activeMutationLockRecords(ticketDir, MUTATION_TICKET_PREFIX, staleMs);
    const number = existing.reduce(
      (max, row) => Number.isSafeInteger(row.number) ? Math.max(max, row.number) : max,
      0
    ) + 1;
    writeFileSync(ticketFile, JSON.stringify({ pid: process.pid, token, number }), { flag: "wx" });
    ticketCreated = true;
    rmSync(choosingFile, { force: true });

    for (;;) {
      const choosing = activeMutationLockRecords(ticketDir, MUTATION_CHOOSING_PREFIX, staleMs);
      const tickets = activeMutationLockRecords(ticketDir, MUTATION_TICKET_PREFIX, staleMs);
      const owner = tickets
        .filter((row) => Number.isSafeInteger(row.number))
        .sort((a, b) => a.number - b.number || a.token.localeCompare(b.token))[0];
      const ownTicketPresent = tickets.some((row) => row.token === token);
      const everyTicketReadable = tickets.every((row) => Number.isSafeInteger(row.number));
      if (
        choosing.length === 0 &&
        everyTicketReadable &&
        ownTicketPresent &&
        owner?.token === token &&
        !legacyMutationLockBlocks(lock, staleMs)
      ) {
        // The ticket protocol elects one new-code owner; the legacy bridge makes
        // that owner visible to an old process that still uses `<resource>.lock`.
        legacyBridge = tryAcquireLegacyMutationBridge(lock, token);
        if (legacyBridge) return fn();
      }
      if (Date.now() > deadline) throw new Error(`${label} lock timeout`);
      Atomics.wait(INTENT_LOCK_WAIT, 0, 0, 10);
    }
  } finally {
    releaseLegacyMutationBridge(lock, legacyBridge);
    try { rmSync(choosingFile, { force: true }); } catch { /* best-effort */ }
    if (ticketCreated) {
      try { rmSync(ticketFile, { force: true }); } catch { /* best-effort */ }
    }
  }
}
function withIntentLedgerLock(file, fn) {
  mkdirSync(path.dirname(file), { recursive: true });
  return withMutationTicketLock({
    lock: `${file}.lock`,
    ticketDir: `${file}.lock.tickets`,
    timeoutMs: INTENT_LOCK_TIMEOUT_MS,
    staleMs: INTENT_LOCK_STALE_MS,
    label: `coordination intent ledger ${file}`
  }, fn);
}
function atomicRewriteIntentLedger(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

// Resolve a card's project label to an absolute repo path (Q5). Precedence:
// board.projects[label].path, then an absolute-path label that exists on disk,
// then a dev-root name lookup (the SAME source the project picker uses via
// discover.listProjects). Unresolvable -> null (the caller degrades honestly:
// no ledger row / no fence, never a park).
export function repoPathForProject(project, board) {
  if (!project || typeof project !== "string") return null;
  const label = project.trim();
  if (!label) return null;
  const fromBoard = board?.projects?.[label]?.path;
  if (fromBoard && typeof fromBoard === "string" && existsSync(fromBoard)) return path.resolve(fromBoard);
  if (path.isAbsolute(label) && existsSync(label)) return path.resolve(label);
  try {
    const match = listProjects(readDevRoot()).find((p) => p.name === label);
    if (match) return match.path;
  } catch {
    /* discovery best-effort */
  }
  return null;
}

// Register a card's touch-set as a coord-mcp intent row (the outward-facing
// registry non-kanban sessions read). Wire format = intent-store.mjs's row
// ({repo, session, area, files, reason, ts}) plus extra keys those readers
// ignore (cardId, runId, kind). session = "kanban:<cardId>" so removal on
// terminal is deterministic. Returns the row, or null when the repo is
// unresolvable / the write fails (the ledger is convenience, never load-bearing
// for the engine's own overlap computation, which reads live touch-sets).
export function registerTouchSetIntent({ repoPath, card, touchSet, now = () => new Date().toISOString() }) {
  if (!repoPath) return null;
  const ts = typeof now === "function" ? now() : now;
  const row = {
    repo: repoPath,
    session: `kanban:${card.id}`,
    area: card.title || "",
    files: [...(touchSet.files || []), ...(touchSet.dirs || [])],
    reason: `kanban card ${card.id} (${card.project || "no-project"})`,
    ts: ts || new Date().toISOString(),
    cardId: card.id,
    runId: card.runId || null,
    kind: "touch-set"
  };
  try {
    const file = intentPath(repoPath);
    withIntentLedgerLock(file, () => appendFileSync(file, JSON.stringify(row) + "\n"));
    return row;
  } catch {
    return null;
  }
}

// Refresh one card's outward touch-set claim after a human-held pause. Replace
// only that card's prior touch-set rows (preserving its mail rows and every other
// session) before appending the current claim with a fresh timestamp. This keeps
// coord-mcp's 3-7 day lookback honest without accumulating stale duplicate claims.
export function refreshCardTouchSetIntent({ repoPath, card, touchSet, now = () => new Date().toISOString() }) {
  if (!repoPath || !card?.id || !touchSet) return null;
  const file = intentPath(repoPath);
  const session = `kanban:${card.id}`;
  const ts = typeof now === "function" ? now() : now;
  const row = {
    repo: repoPath,
    session,
    area: card.title || "",
    files: [...(touchSet.files || []), ...(touchSet.dirs || [])],
    reason: `kanban card ${card.id} (${card.project || "no-project"})`,
    ts: ts || new Date().toISOString(),
    cardId: card.id,
    runId: card.runId || null,
    kind: "touch-set"
  };
  try {
    withIntentLedgerLock(file, () => {
      let lines = [];
      try {
        lines = readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
      } catch {
        lines = [];
      }
      const kept = lines.filter((line) => {
        try {
          const prior = JSON.parse(line);
          return prior.session !== session || prior.kind !== "touch-set";
        } catch {
          return false;
        }
      });
      // One atomic rewrite, not rewrite-then-append: a failed append must not
      // erase this card's old claim and leave the resumed card invisible.
      atomicRewriteIntentLedger(file, [...kept, JSON.stringify(row)].join("\n") + "\n");
    });
    return row;
  } catch {
    return null;
  }
}

// Re-register a card's touch-set IF it GREW since its last ledger row (Q5:
// "the fence re-reads touch-set.json each time; growth triggers re-registration").
// Compares the current files+dirs against the most recent touch-set row for this
// card's session; appends a fresh row only when new claims appeared. Returns
// { grown, added } so the caller can record an honest event. A card never yet
// registered (no prior row) is left to the plan-completion registration.
export function reregisterTouchSetIfGrown({ repoPath, card, touchSet, now = () => new Date().toISOString() }) {
  if (!repoPath || !touchSet) return { grown: false, added: [] };
  try {
    const file = intentPath(repoPath);
    return withIntentLedgerLock(file, () => {
      let rows = [];
      try {
        rows = readFileSync(file, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      } catch {
        rows = [];
      }
      const session = `kanban:${card.id}`;
      const prior = rows.filter((r) => r.session === session && r.kind === "touch-set").pop();
      if (!prior) return { grown: false, added: [] };
      const current = [...(touchSet.files || []), ...(touchSet.dirs || [])].map(normPath);
      const priorSet = new Set((prior.files || []).map(normPath));
      const added = current.filter((p) => !priorSet.has(p));
      if (added.length === 0) return { grown: false, added: [] };
      const ts = typeof now === "function" ? now() : now;
      const row = {
        repo: repoPath,
        session,
        area: card.title || "",
        files: [...(touchSet.files || []), ...(touchSet.dirs || [])],
        reason: `kanban card ${card.id} (${card.project || "no-project"})`,
        ts: ts || new Date().toISOString(),
        cardId: card.id,
        runId: card.runId || null,
        kind: "touch-set"
      };
      appendFileSync(file, JSON.stringify(row) + "\n");
      return { grown: true, added };
    });
  } catch {
    return { grown: false, added: [] };
  }
}

// Strict removal primitive used by the durable post-commit cleanup queue. A
// missing ledger is a successful no-op; storage/locking failures are surfaced so
// the queue remains pending for the next repair sweep.
function removeCardIntentsStrict({ repoPath, cardId }) {
  if (!repoPath || !cardId) return;
  const file = intentPath(repoPath);
  withIntentLedgerLock(file, () => {
    let txt;
    try {
      txt = readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    const session = `kanban:${cardId}`;
    const kept = txt
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => {
        try {
          return JSON.parse(l).session !== session;
        } catch {
          return false; // drop unparseable rows
        }
      });
    atomicRewriteIntentLedger(file, kept.join("\n") + (kept.length ? "\n" : ""));
  });
}

// Compatibility best-effort API for advisory callers. Lifecycle closure uses
// cleanupCardCoordination below, which calls the strict primitive and journals
// failures before attempting removal.
export function removeCardIntents(args) {
  try {
    removeCardIntentsStrict(args);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// Append an outward-facing mail row to the intents ledger (Q9 step 3) so a
// non-kanban coord-mcp session's digest surfaces the notice. Wire-compatible with
// intent-store rows; kind:"mail" + toCardId are extra keys those readers ignore.
// Best-effort; a null repo or write failure is silent (mail evidence lives in the
// runDir records regardless).
export function appendMailLedgerRow({ repoPath, fromCard, toCard, subject, body, now = () => new Date().toISOString() }) {
  if (!repoPath) return null;
  const ts = typeof now === "function" ? now() : now;
  const row = {
    repo: repoPath,
    session: `kanban:${fromCard.id}`,
    area: subject || "",
    files: [],
    reason: String(body || "").slice(0, 500),
    ts: ts || new Date().toISOString(),
    kind: "mail",
    cardId: fromCard.id,
    toCardId: toCard?.id || null
  };
  try {
    const file = intentPath(repoPath);
    withIntentLedgerLock(file, () => appendFileSync(file, JSON.stringify(row) + "\n"));
    return row;
  } catch {
    return null;
  }
}

// ── path-claim coverage (shared by the scorer, fences, attribution) ─────────

// Does a touch-set claim COVER a repo-relative file path? True when the file
// equals a claimed exact file, or falls under a claimed dir prefix. Paths are
// normalised (posix, repo-relative) both sides.
export function claimCovers(touchSet, file) {
  if (!touchSet || !file) return false;
  const f = normPath(file);
  const files = (touchSet.files || []).map(normPath);
  if (files.includes(f)) return true;
  const dirs = (touchSet.dirs || []).map(normPath);
  return dirs.some((d) => underDir(f, d));
}

// ── D6 exclusive leases (local file, O_EXCL, TTL) ───────────────────────────
//
// A card whose touch-set declares `exclusive` paths takes a local lease on each
// before it dispatches implement. The lease file is the PRIMARY record (works
// with agent-mail absent — A1); an agent-mail file_reservation mirror is a
// best-effort extra handled by the mail layer. sha1(path) keys the file so any
// path maps to one lease file per repo.
function leaseDirFor(repoPath) {
  return path.join(coordDir(), "leases", repoSlug(repoPath));
}
function sha1Hex(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}
function leasePathFor(repoPath, claimPath) {
  return path.join(leaseDirFor(repoPath), `${sha1Hex(normPath(claimPath))}.json`);
}
function readLease(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function readLeaseForMutation(file) {
  try {
    const lease = JSON.parse(readFileSync(file, "utf8"));
    const expires = typeof lease?.expiresAt === "string" ? Date.parse(lease.expiresAt) : NaN;
    if (!lease || typeof lease !== "object" || typeof lease.cardId !== "string" || !lease.cardId || !Number.isFinite(expires)) {
      throw new Error("invalid coordination lease record");
    }
    return lease;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    // Corrupt or unreadable ownership evidence is contention, never absence.
    // The caller converts this into an unavailable/fail-closed result.
    throw new Error(`coordination lease is unreadable: ${file}`, { cause: err });
  }
}
function leaseExpired(lease, nowMs) {
  const exp = lease?.expiresAt ? Date.parse(lease.expiresAt) : NaN;
  return !Number.isFinite(exp) || exp <= nowMs;
}

// Every lease mutation is a small compare-and-swap transaction protected by a
// stable sibling lock. The old read -> unlink/overwrite sequence let two expired-
// lease contenders both believe they won, and let a stale release unlink the
// successor that landed between its read and rm. Atomic lease-file replacement
// keeps lockless readers from observing torn JSON; ownerToken protects a stale
// rollback/renew/release from acting on a newer generation of the same card.
const LEASE_LOCK_TIMEOUT_MS = 5000;
const LEASE_LOCK_STALE_MS = 30000;
function withLeaseMutationLock(file, fn) {
  mkdirSync(path.dirname(file), { recursive: true });
  return withMutationTicketLock({
    lock: `${file}.lock`,
    ticketDir: `${file}.lock.tickets`,
    timeoutMs: LEASE_LOCK_TIMEOUT_MS,
    staleMs: LEASE_LOCK_STALE_MS,
    label: `coordination lease ${file}`
  }, fn);
}
function atomicWriteLease(file, lease) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(lease), "utf8");
    renameSync(tmp, file);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* renamed or best-effort */ }
  }
}

// Try to take exclusive leases on `paths` for a card. Each path is compared and
// replaced under its mutation lock. A same-card lease advances to this call's new
// owner token; an expired foreign lease is replaced; a live foreign lease blocks.
// On a later-path block, token-conditional rollback restores each prior record so
// the call never leaves a partial set or deletes a successor generation. Storage,
// lock, or parse failures return `{ok:false, unavailable:true}`: missing ownership
// evidence is never permission to dispatch without the exclusive lease.
export function acquireLeases({ repoPath, card, paths, ttlMinutes = DEFAULT_COORDINATION.leaseTtlMinutes, now = () => new Date().toISOString() }) {
  if (!repoPath || !Array.isArray(paths) || paths.length === 0) return { ok: true, acquired: [], ownerToken: null };
  const nowStr = typeof now === "function" ? now() : now;
  const nowMs = Date.parse(nowStr) || Date.now();
  const expiresAt = new Date(nowMs + Math.max(1, ttlMinutes) * 60_000).toISOString();
  const ownerToken = crypto.randomUUID();
  const acquired = [];
  const mutations = [];
  try {
    mkdirSync(leaseDirFor(repoPath), { recursive: true });
  } catch {
    return { ok: false, acquired: [], ownerToken: null, unavailable: true };
  }
  const record = (p) => ({
    path: normPath(p),
    cardId: card.id,
    runId: card.runId || null,
    holder: `kanban:${card.id}`,
    ownerToken,
    acquiredAt: nowStr,
    expiresAt
  });
  for (const p of paths) {
    const file = leasePathFor(repoPath, p);
    let result;
    try {
      result = withLeaseMutationLock(file, () => {
        const prior = readLeaseForMutation(file);
        if (prior && prior.cardId !== card.id && !leaseExpired(prior, nowMs)) {
          return { ok: false, heldBy: prior.cardId || null, path: normPath(p) };
        }
        atomicWriteLease(file, record(p));
        return { ok: true, prior };
      });
    } catch {
      rollbackLeaseMutations(mutations, ownerToken);
      return { ok: false, acquired: [], ownerToken: null, unavailable: true };
    }
    if (!result.ok) {
      rollbackLeaseMutations(mutations, ownerToken);
      return { ...result, ownerToken: null };
    }
    acquired.push(p);
    mutations.push({ file, prior: result.prior });
  }
  return { ok: true, acquired, ownerToken };
}

function rollbackLeaseMutations(mutations, ownerToken) {
  for (const { file, prior } of [...mutations].reverse()) {
    try {
      withLeaseMutationLock(file, () => {
        const cur = readLeaseForMutation(file);
        if (!cur || cur.ownerToken !== ownerToken) return;
        if (prior) atomicWriteLease(file, prior);
        else rmSync(file, { force: true });
      });
    } catch {
      /* best-effort; token check prevents deleting a successor */
    }
  }
}

// Renew (extend the TTL of) the leases a card already holds — called at each fence
// so a long implement phase does not let its own leases expire under it.
export function renewLeases({ repoPath, card, paths, ownerToken = card?.leaseOwnerToken || null, ttlMinutes = DEFAULT_COORDINATION.leaseTtlMinutes, now = () => new Date().toISOString() }) {
  if (!repoPath || !Array.isArray(paths) || paths.length === 0) return;
  const nowStr = typeof now === "function" ? now() : now;
  const nowMs = Date.parse(nowStr) || Date.now();
  const expiresAt = new Date(nowMs + Math.max(1, ttlMinutes) * 60_000).toISOString();
  for (const p of paths) {
    const file = leasePathFor(repoPath, p);
    try {
      withLeaseMutationLock(file, () => {
        const cur = readLeaseForMutation(file);
        if (!cur || cur.cardId !== card.id) return;
        if (ownerToken && cur.ownerToken !== ownerToken) return;
        atomicWriteLease(file, { ...cur, expiresAt });
      });
    } catch { /* best-effort */ }
  }
}

// Strict release primitive for durable lifecycle cleanup. ownerToken narrows a
// run-specific cleanup; lifecycle closure intentionally omits it to remove every
// generation for the closed card. Missing lease storage is a successful no-op;
// mutation/locking failures are thrown for the retry queue to retain.
function releaseLeasesStrict({ repoPath, cardId, ownerToken = null }) {
  if (!repoPath || !cardId) return;
  let entries = [];
  try {
    entries = readdirSync(leaseDirFor(repoPath), { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  const errors = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const file = path.join(leaseDirFor(repoPath), e.name);
    try {
      withLeaseMutationLock(file, () => {
        let cur;
        try {
          cur = JSON.parse(readFileSync(file, "utf8"));
        } catch (err) {
          if (err?.code === "ENOENT") return;
          throw err;
        }
        if (!cur || cur.cardId !== cardId) return;
        if (ownerToken && cur.ownerToken !== ownerToken) return;
        rmSync(file, { force: true });
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, `failed to release coordination leases for ${cardId}`);
}

export function releaseLeases(args) {
  try {
    releaseLeasesStrict(args);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// Post-commit intent/lease cleanup cannot be rolled back with the card write. Put
// a board-local retry record on disk BEFORE attempting it; a transient failure is
// then both visible (`postCommitError` + this sidecar) and recoverable on the next
// waiting/tick sweep. The card lifecycle lock serializes queue mutation for this
// card, including after Delete because its lock lives outside cards/<id>.
function cleanupQueueDir(root) {
  return path.join(root, ".coordination-cleanup");
}
function cleanupQueueFile(root, cardId) {
  return path.join(cleanupQueueDir(root), `${sha1Hex(cardId)}.json`);
}
function readCleanupQueueRecord(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return null; }
}
function readCleanupQueueRecordForMutation(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`coordination cleanup journal is unreadable: ${file}`, { cause: err });
  }
}
function atomicWriteCleanupQueue(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record), "utf8");
    renameSync(tmp, file);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* renamed or best-effort */ }
  }
}
function cleanupCardFile(root, cardId) {
  return path.join(root, "cards", cardId, "card.json");
}
function readCardStateForCleanup(root, cardId) {
  try {
    const card = JSON.parse(readFileSync(cleanupCardFile(root, cardId), "utf8"));
    if (!card || typeof card !== "object" || card.id !== cardId) {
      throw new Error("invalid card record");
    }
    return card;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    // An unreadable card is unknown state, not proof that closure still applies.
    throw new Error(`coordination cleanup card state is unreadable: ${cardId}`, { cause: err });
  }
}
function cleanupStateGuard(card) {
  return card == null
    ? { kind: "card-state", deleted: true }
    : {
        kind: "card-state",
        deleted: false,
        cardCreatedAt: typeof card.created === "string" ? card.created : null,
        listId: card.list || null,
        abandoned: card.abandoned === true,
        coordinationSeq: Number.isSafeInteger(card.coordinationSeq) && card.coordinationSeq >= 0
          ? card.coordinationSeq
          : 0,
        // Kept for diagnostics and for the exact-revision compatibility fallback
        // used by version-2 sidecars written before coordinationSeq existed.
        rev: Number.isInteger(card.rev) ? card.rev : null,
        runId: card.runId || null,
        runSeq: Number.isInteger(card.runSeq) ? card.runSeq : null
      };
}
function cleanupGuardStillApplies(record, card) {
  const guard = record?.guard;
  if (!guard) {
    // Version-1 release-all sidecars predate lifecycle guards. Preserve their
    // useful cleanup only while the card is observably closed; never apply one
    // to an active successor generation.
    if (record?.version === 1 && (record.removeIntents || record.leaseOwnerTokens === null)) {
      return card == null || card.abandoned === true || card.list === "done";
    }
    return true;
  }
  if (guard.kind !== "card-state") return false;
  if (card == null) return true; // a later Delete makes every prior release safe
  if (guard.deleted) return false; // the id was recreated after Delete
  // Release-all and intent removal are card-id scoped, so they must stay bound to
  // the exact coordination lifecycle that queued them. Benign annotation edits
  // advance rev but preserve coordinationSeq, while reopening/re-dispatching and
  // later returning to the same list advances coordinationSeq and supersedes the
  // old cleanup. Older version-2 sidecars have no sequence, so retain their
  // conservative exact-revision behavior during migration.
  const sameCardIdentity =
    typeof guard.cardCreatedAt === "string"
      ? card.created === guard.cardCreatedAt
      : true;
  const sameCoordinationGeneration = Number.isSafeInteger(guard.coordinationSeq)
    ? (Number.isSafeInteger(card.coordinationSeq) && card.coordinationSeq >= 0 ? card.coordinationSeq : 0) === guard.coordinationSeq
    : Number.isInteger(guard.rev) && card.rev === guard.rev;
  return (
    sameCardIdentity &&
    sameCoordinationGeneration &&
    card.list === guard.listId &&
    (card.abandoned === true) === guard.abandoned &&
    (card.runId || null) === guard.runId &&
    (Number.isInteger(card.runSeq) ? card.runSeq : null) === guard.runSeq
  );
}
function mergeCleanupQueueRecord(existing, { cardId, repoPaths, removeIntents, ownerToken, guard = null }) {
  const priorRepos = Array.isArray(existing?.repoPaths) ? existing.repoPaths : [];
  const repos = [...new Set([...priorRepos, ...(repoPaths || [])].filter((repo) => typeof repo === "string" && repo))];
  const releaseAll = existing?.leaseOwnerTokens === null || ownerToken == null;
  const priorTokens = Array.isArray(existing?.leaseOwnerTokens) ? existing.leaseOwnerTokens : [];
  const leaseOwnerTokens = releaseAll
    ? null
    : [...new Set([...priorTokens, ownerToken].filter((token) => typeof token === "string" && token))];
  return {
    version: 3,
    cardId,
    repoPaths: repos,
    removeIntents: Boolean(existing?.removeIntents || removeIntents),
    leaseOwnerTokens,
    guard: guard || existing?.guard || null,
    queuedAt: existing?.queuedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
function cleanupOperationError(result, label) {
  if (result && result.ok === false) throw result.error || new Error(`${label} failed`);
}
function performCoordinationCleanup(record, operations = {}) {
  const remove = operations.removeCardIntents || removeCardIntentsStrict;
  const release = operations.releaseLeases || releaseLeasesStrict;
  const errors = [];
  for (const repoPath of record.repoPaths || []) {
    if (record.removeIntents) {
      try { cleanupOperationError(remove({ repoPath, cardId: record.cardId }), "intent cleanup"); }
      catch (error) { errors.push(error); }
    }
    const tokens = record.leaseOwnerTokens === null ? [null] : (record.leaseOwnerTokens || []);
    for (const ownerToken of tokens) {
      try { cleanupOperationError(release({ repoPath, cardId: record.cardId, ownerToken }), "lease cleanup"); }
      catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, `coordination cleanup failed for ${record.cardId}`);
}

export function cleanupCardCoordination({ root, cardId, repoPaths, removeIntents = false, ownerToken = null }, operations = {}) {
  const repos = [...new Set((repoPaths || []).filter(Boolean))];
  if (!root || !cardId || repos.length === 0) return { ok: true, skipped: true };
  const file = cleanupQueueFile(root, cardId);
  const currentCard = readCardStateForCleanup(root, cardId);
  let existing = readCleanupQueueRecordForMutation(file);
  if (existing && !cleanupGuardStillApplies(existing, currentCard)) {
    // A card-state change supersedes a card-id-wide cleanup operation. Drop it
    // before merging any cleanup belonging to the current lifecycle state.
    rmSync(file, { force: true });
    existing = null;
  }
  // Owner-token cleanup is generation-safe on its own. Card-id-wide intent
  // removal or lease release-all needs an exact durable card-state guard.
  const guard = removeIntents || ownerToken == null ? cleanupStateGuard(currentCard) : null;
  const record = mergeCleanupQueueRecord(existing, {
    cardId,
    repoPaths: repos,
    removeIntents,
    ownerToken,
    guard
  });
  // Refuse to perform unjournaled post-commit cleanup: if this write fails, the
  // caller receives postCommitError and no destructive side effect has happened.
  atomicWriteCleanupQueue(file, record);
  try {
    performCoordinationCleanup(record, operations);
    rmSync(file, { force: true });
    return { ok: true };
  } catch (error) {
    console.error(`[kanban-loop] coordination cleanup queued for retry (${cardId}):`, error?.message || error);
    throw error;
  }
}

export async function repairPendingCoordinationCleanups({ root }, operations = {}) {
  const repaired = [];
  const pending = [];
  const superseded = [];
  let entries;
  try {
    entries = readdirSync(cleanupQueueDir(root), { withFileTypes: true });
  } catch (err) {
    if (err?.code !== "ENOENT") pending.push({ cardId: null, error: err });
    return { repaired, pending, superseded };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(cleanupQueueDir(root), entry.name);
    const initial = readCleanupQueueRecord(file);
    if (!initial?.cardId || !Array.isArray(initial.repoPaths)) {
      pending.push({ cardId: initial?.cardId || null, error: new Error(`invalid coordination cleanup record: ${file}`) });
      continue;
    }
    try {
      await withCardLock(root, initial.cardId, async () => {
        const record = readCleanupQueueRecordForMutation(file);
        if (!record) return;
        const currentCard = readCardStateForCleanup(root, record.cardId);
        if (!cleanupGuardStillApplies(record, currentCard)) {
          rmSync(file, { force: true });
          superseded.push(record.cardId);
          return;
        }
        try {
          performCoordinationCleanup(record, operations);
          rmSync(file, { force: true });
          repaired.push(record.cardId);
        } catch (error) {
          pending.push({ cardId: record.cardId, error });
        }
      });
    } catch (error) {
      pending.push({ cardId: initial.cardId, error });
    }
  }
  return { repaired, pending, superseded };
}

// Is any of `paths` currently leased by a DIFFERENT, non-expired card? Returns the
// holder cardId (the release predicate for a lease-waiter uses this: null => free).
export function leaseHeldByOther({ repoPath, cardId, paths, now = () => new Date().toISOString() }) {
  if (!repoPath || !Array.isArray(paths)) return null;
  const nowMs = Date.parse(typeof now === "function" ? now() : now) || Date.now();
  for (const p of paths) {
    const cur = readLease(leasePathFor(repoPath, p));
    if (cur && cur.cardId !== cardId && !leaseExpired(cur, nowMs)) return cur.cardId;
  }
  return null;
}

// ── availability probe + serialize gate (Q8, D9) ────────────────────────────

let _availCache = { at: 0, val: null };

// Reset the availability cache (tests toggle GARRISON_HOME / the policy between
// cases and need a fresh probe).
export function resetCoordinationCache() {
  _availCache = { at: 0, val: null };
}

// Is the coordination substrate usable? Coordination is AVAILABLE iff (a) the
// policy is not corrupt (matching the engine's corrupt-policy fail-safe posture),
// and (b) the file substrate works — the coord dir is creatable and an O_EXCL
// probe file can be written + removed under it. agent-mail being down does NOT
// make coordination unavailable (that is a mail-transport concern handled in S2);
// D9 fires only when coordination STATE cannot be persisted at all. Cached ~5s so
// a tick over many cards probes once.
export function coordinationAvailability(now = Date.now) {
  const t = typeof now === "function" ? now() : now;
  if (_availCache.val && t - _availCache.at < 5000) return _availCache.val;
  let val;
  try {
    if (policyLoadState() === "corrupt") {
      val = { ok: false, reason: "policy-corrupt" };
    } else {
      const dir = coordDir();
      mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.probe-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      const fd = openSync(probe, "wx");
      closeSync(fd);
      rmSync(probe, { force: true });
      val = { ok: true, reason: null };
    }
  } catch {
    val = { ok: false, reason: "substrate-unwritable" };
  }
  _availCache = { at: t, val };
  return val;
}

function listById(board, listId) {
  return (board?.lists || []).find((l) => l.id === listId) || null;
}

function isTerminalList(list, listId) {
  return Boolean(list && (list.terminal || listId === "done"));
}

// `needs-attention` is a human ownership boundary. It is deliberately NOT a
// terminal coordination state: all runs share one checkout/branch, and a run
// can park after leaving partial edits in that checkout. Until a human resumes
// or explicitly abandons/closes it, its overlap and lease waiters must remain
// held rather than being released into possibly dirty shared state.
function isParkedForHuman(card) {
  return card?.status === "needs-attention" || card?.list === "needs-attention";
}

// Manual and interactive columns are also human-held. A previously-started card
// moved there can still own partial same-checkout work, so its waiters must not
// auto-release merely because an exclusive lease file aged out. Terminal columns
// are closure and are intentionally excluded here.
export function isHumanHeld(card, board) {
  if (isParkedForHuman(card)) return true;
  const list = listById(board, card?.list);
  if (!list) return Boolean(card); // stranded/removed list cannot progress autonomously
  return Boolean(list && !isTerminalList(list, card?.list) && list.kind !== "agent");
}

// A card is LIVE (occupies the project's one serialize slot / counts as an
// overlap candidate) when it is running, waiting on another card, or has a minted
// runDir and sits on a non-terminal list. Terminal/never-started cards are not
// live.
function isLiveCard(c, board) {
  if (!c) return false;
  if (c.abandoned) return false; // an abandoned card holds no slot and blocks no one
  if (c.waitingOn) return true;
  if (c.status === "running") return true;
  if (c.runDir) {
    const list = listById(board, c.list);
    if (!isTerminalList(list, c.list)) return true;
  }
  return false;
}

// Live same-project peers of a card (excluding itself) — the overlap/attribution
// candidate set. Exported so the engine can compute "other live cards share the
// project" without re-deriving liveness.
export function liveSameProjectCards(allCards, card, board) {
  return (allCards || []).filter(
    (c) => c && c.id !== card.id && (c.project || null) === (card.project || null) && isLiveCard(c, board)
  );
}

// Serialize gate (Q8): when coordination is ENABLED but UNAVAILABLE (and
// serializeWhenUnavailable), a project may run only ONE live card at a time —
// the oldest ULID wins. Returns {allowed} for the oldest live same-project card
// (including this one) and {allowed:false, reason} for every younger one. The
// oldest is always allowed, so there is no deadlock. The caller only invokes
// this in the degraded state; in the available state overlap ordering (the
// touch-set path) governs instead.
export function serializeGate(cards, card, board) {
  const others = (cards || []).filter(
    (c) => c.id !== card.id && (c.project || null) === (card.project || null) && isLiveCard(c, board)
  );
  if (others.length === 0) return { allowed: true, reason: null };
  const live = [card, ...others];
  const oldest = live.reduce((a, b) => (String(a.id) <= String(b.id) ? a : b));
  if (oldest.id === card.id) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason: `serialized: coordination degraded, one live card per project (waiting behind ${oldest.id})`
  };
}

// ── stability point (Q3) ─────────────────────────────────────────────────────

// Fold the stability point into a phase transition. The predicate is
// review -> (not implement) with no prior stabilityAt: the FIRST clean review is
// the point at which a run's shape is stable enough for medium-overlap waiters to
// start. Returns { stabilityAt, event } to fold into the SAME CAS write as the
// move, or null when the predicate is not met (idempotent via the !stabilityAt
// guard). Called at all three engine seams so the predicate lives in one place.
//
// INTENTIONAL (D2): the engine folds this on EVERY clean-review transition,
// unconditional on the coordination section being present. The stability event is
// a plain, honest fact about the run ("first review passed") that belongs on the
// card timeline whether or not any other run is waiting on it; only the
// plan-completion WAIT decision (applyPlanCompletionCoordination) is gated on
// coordination being active. So a stabilityAt recorded now is already correct if a
// later run turns coordination on and needs to wait on this one.
export function stabilityFields(card, phase, effectiveNext, now = () => new Date().toISOString()) {
  const ts = typeof now === "function" ? now() : now;
  if (phase === "review" && effectiveNext !== "implement" && !card?.stabilityAt) {
    return {
      stabilityAt: ts,
      event: {
        at: ts,
        kind: "stability",
        message: "Stability point: first review passed — overlapping cards waiting on stability may start"
      }
    };
  }
  return null;
}

// ── plan-completion coordination (Q2 point 2, Q4 wait) ──────────────────────

const GRADE_RANK = { none: 0, light: 1, medium: 2, heavy: 3 };
function gradeRank(g) {
  return GRADE_RANK[g] ?? 0;
}

function short(card) {
  const title = card?.title || card?.id || "card";
  const tail = String(card?.id || "").slice(-6);
  return tail ? `${title} (${tail})` : String(title);
}

// Total order key for two runs: earlier planCompletedAt first; a run that has NOT
// completed plan (no planCompletedAt) sorts as latest; ties break on runId ULID
// (lexical). The ULID suffix is random (not monotonic within a millisecond), so a
// same-ms tie is arbitrary but still deterministic - the order stays total and acyclic.
function orderAtMs(planCompletedAt) {
  const ms = planCompletedAt ? Date.parse(planCompletedAt) : NaN;
  return Number.isFinite(ms) ? ms : Infinity;
}
function compareOrder(aAt, aRun, bAt, bRun) {
  const am = orderAtMs(aAt);
  const bm = orderAtMs(bAt);
  if (am !== bm) return am - bm;
  return String(aRun || "").localeCompare(String(bRun || ""));
}

function summarizeShared(s) {
  const parts = [];
  if (s.sharedExclusive?.length) parts.push(`exclusive [${s.sharedExclusive.join(", ")}]`);
  if (s.sharedFiles?.length) parts.push(`files [${s.sharedFiles.join(", ")}]`);
  if (s.sharedSurfaces?.length) parts.push(`surfaces [${s.sharedSurfaces.join(", ")}]`);
  if (s.sharedDirs?.length) parts.push(`dirs [${s.sharedDirs.join(", ")}]`);
  return parts.join("; ") || "shared paths";
}

// Decide what a card's plan-completion means for coordination. Called by the
// engine in the plan seam of processCard / advanceCardPhase (plan is never
// batched). Side effects: reads the card's + peers' touch-sets, and registers the
// card's touch-set into the intents ledger. Returns one of:
//   { kind: "park", reason, planCompletedAt }        — no valid touch-set (enforced)
//   { kind: "wait", waitingOn, planCompletedAt, selfEvents, blockerWrites }
//   { kind: "advance", planCompletedAt, selfEvents, blockerWrites }
// or null when coordination is disabled/unavailable (the engine advances as
// normal; the serialize gate covers the unavailable case at dispatch time).
//
// `nextList` is the engine's already-rail-resolved forward target ("implement"),
// used as the deferred advance target (waitingOn.thenTo) so a wait releases to the
// exact list the card would have moved to.
//
// Concurrency note: the total order keys on planCompletedAt, which we stamp = now
// here. Two runs whose plans complete in the SAME tick each read the other as
// "not yet completed" (no planCompletedAt on disk when each computed its peers),
// so in that narrow cross-process window neither waits and both proceed in
// parallel. That is graceful degradation, not deadlock — the ULID tie-break keeps
// the order total, and the worst case is a missed wait that fences (S2) and
// attribution still cover, never two runs each blocked on the other.
export function applyPlanCompletionCoordination({ board, card, allCards, policy, nextList = "implement", now = () => new Date().toISOString() }) {
  const config = coordinationConfig(policy);
  if (!config.enabled) return null;
  if (!coordinationAvailability().ok) return null;
  const nowStr = typeof now === "function" ? now() : now;

  // 1. touch-set is REQUIRED evidence when coordination is enabled (Q1).
  const inspected = inspectTouchSet(card.runDir);
  const ts = inspected.touchSet;
  if (!ts) {
    return {
      kind: "park",
      planCompletedAt: nowStr,
      reason:
        `coordination is enabled but no valid touch-set.json was written under ${card.runDir} ` +
        `(schema version 1, listing the files/dirs this run will touch). Validation: ${inspected.issue}. ` +
        `The plan phase must predict ` +
        `the touch-set so overlapping runs can be ordered — re-run Plan so the skill writes it.`
    };
  }

  // 2. register the touch-set as an outward-facing intent (best-effort).
  const repoPath = repoPathForProject(card.project, board);
  registerTouchSetIntent({ repoPath, card, touchSet: ts, now: nowStr });

  // 3. gather LIVE same-project peers that have already declared a touch-set (i.e.
  //    completed their plan). A peer with no touch-set has not completed plan yet,
  //    so THIS card is the earlier one relative to it — it does not block us; that
  //    peer will wait on us when its own plan completes.
  const myAt = nowStr;
  const myRun = card.runId || card.id;
  let blocker = null; // { card, grade, shared }
  const selfEvents = [];
  const blockerWrites = [];
  const mails = []; // courtesy notices (Q9), sent by the engine after the CAS save
  for (const c of allCards || []) {
    if (!c || c.id === card.id) continue;
    if ((c.project || null) !== (card.project || null)) continue;
    if (!isLiveCard(c, board)) continue;
    const peerTs = readTouchSet(c.runDir);
    if (!peerTs) continue;
    const s = scoreOverlap(ts, peerTs, config.thresholds);
    if (s.grade === "none") continue;
    // Only EARLIER peers can block us (total order).
    const peerAt = c.planCompletedAt || null;
    const peerRun = c.runId || c.id;
    const peerIsEarlier = compareOrder(peerAt, peerRun, myAt, myRun) < 0;
    if (!peerIsEarlier) continue;
    if (s.grade === "light") {
      // Proceed in parallel; record the courtesy on both cards (the mail itself
      // is S2/Q9 — here we leave the honest timeline event).
      selfEvents.push({
        at: nowStr,
        kind: "coordination",
        message: `Light overlap with ${short(c)} (${summarizeShared(s)}) — proceeding in parallel`
      });
      blockerWrites.push({
        cardId: c.id,
        event: {
          at: nowStr,
          kind: "coordination",
          message: `Light overlap with ${short(card)} — both proceeding in parallel`
        }
      });
      mails.push({
        toCardId: c.id,
        subject: `Light overlap: ${short(card)}`,
        body: `Card ${card.id} (${card.title || "untitled"}) is proceeding in parallel; light overlap (${summarizeShared(s)}). No action needed — heads up.`
      });
      continue;
    }
    // medium/heavy: keep the STRONGEST constraint; among equal grades keep the
    // EARLIEST peer (the one we are most clearly downstream of).
    if (
      !blocker ||
      gradeRank(s.grade) > gradeRank(blocker.grade) ||
      (gradeRank(s.grade) === gradeRank(blocker.grade) &&
        compareOrder(c.planCompletedAt, peerRun, blocker.card.planCompletedAt, blocker.card.runId || blocker.card.id) < 0)
    ) {
      blocker = { card: c, grade: s.grade, shared: s };
    }
  }

  if (!blocker) {
    return { kind: "advance", planCompletedAt: nowStr, selfEvents, blockerWrites, mails };
  }

  // medium -> wait until the blocker's stability point; heavy -> until terminal.
  const until = blocker.grade === "heavy" ? "terminal" : "stability";
  const sharedSummary = summarizeShared(blocker.shared);
  const reason =
    `${blocker.grade} overlap with card ${blocker.card.id} (${blocker.card.title || "untitled"}) ` +
    `on ${sharedSummary}; waiting until ${until}.`;
  const waitingOn = {
    cardId: blocker.card.id,
    cardTitle: blocker.card.title || null,
    grade: blocker.grade,
    reason,
    until,
    thenTo: nextList,
    rerun: false,
    since: nowStr
  };
  selfEvents.push({
    at: nowStr,
    kind: "coordination",
    message: `Plan complete; waiting on ${short(blocker.card)} (${blocker.grade} overlap) until ${until}`,
    detail: reason
  });
  blockerWrites.push({
    cardId: blocker.card.id,
    addBlocking: card.id,
    event: {
      at: nowStr,
      kind: "coordination",
      message: `Card ${short(card)} is waiting on this card (${blocker.grade} overlap, until ${until})`,
      detail: reason
    }
  });
  return { kind: "wait", planCompletedAt: nowStr, waitingOn, selfEvents, blockerWrites, mails };
}

// ── waiting re-evaluation (Q3/Q4 release) ────────────────────────────────────

// Bounded event append (mirrors engine.withEvent's cap without importing engine —
// keeps this module's dependency one-directional).
const MAX_EVENTS = 60;
function appendEvent(card, event) {
  const events = Array.isArray(card?.events) ? card.events.slice() : [];
  events.push(event);
  return events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
}

// Why (if at all) a waiting card's release predicate has cleared. Returns a
// human release reason string, or null when it must keep waiting.
//
// The blocker CLOSING supersedes every `until`: a blocker that is deleted,
// abandoned, or has reached a terminal list will not produce any further
// autonomous signal (stability point OR fix fence), so a waiter keyed to one of
// those would be stranded forever — skipped by every tick, silently. Terminal
// supersedes stability (a medium waiter whose blocker went straight to Done
// without a dispatched review still releases). Only when the blocker is still
// alive-and-progressing do we consult the `until`:
//   until "stability" — the blocker has recorded its stabilityAt.
//   until "terminal"  — handled by the disappearance rule above (a still-live
//                       blocker is by definition not terminal, so it keeps waiting).
//   until "fence"     — the interference-fence release (S2/Q6): the offender has
//                       recorded a fence NEWER than the one noted at detection
//                       (offenderFenceSha) — i.e. its fix landed.
//   until "lease"     — the exclusive lease(s) the waiter wants are no longer held
//                       by any other live card (consulted from the lease files, not
//                       the holder card's lifecycle).
function releaseReason(waitingOn, blocker, board, waiterCard) {
  const until = waitingOn?.until;
  // A human-held list is NOT closure. On this same-branch engine the card may have
  // partial edits in the shared checkout, so releasing any overlap (including an
  // expired lease) would let another run build on unreviewed state. Resume the
  // blocker, or use the explicit human Abandon/Delete release override, before
  // autonomous waiters can move. Normal parking never asserts checkout cleanliness.
  if (blocker && isHumanHeld(blocker, board) && !blocker.abandoned) return null;
  // A closed lease owner cannot be allowed to strand a waiter behind its stale
  // lease file. The release seam below retries owner-scoped lease cleanup; if a
  // different live card acquired the path meanwhile, Implement will atomically
  // discover that holder and establish a new wait.
  if (until === "lease") {
    if (!blocker) return "lease holder no longer exists (deleted)";
    if (blocker.abandoned) return "lease holder was abandoned";
    if (isTerminalList(listById(board, blocker.list), blocker.list)) return "lease holder reached terminal";
    // A live Implement owner still logically owns its exclusive paths even if a
    // lease file is momentarily missing/expired. Releasing from file state alone
    // would let a stale reevaluator fan work into the same checkout. Once it moves
    // past Implement, the file predicate below can authorize the next holder.
    const blockerList = listById(board, blocker.list);
    if (blocker.list === "implement" || blockerList?.phase === "implement") return null;
  }
  // Lease: the truth is the lease files, not a blocker card. Check directly.
  if (until === "lease") {
    const repoPath = repoPathForProject(waiterCard?.project, board);
    const ts = readTouchSet(waiterCard?.runDir);
    const paths = ts?.exclusive || [];
    if (!repoPath || paths.length === 0) return "exclusive lease no longer applies";
    return leaseHeldByOther({ repoPath, cardId: waiterCard.id, paths }) ? null : "exclusive lease is now free";
  }
  // Closure (deleted / abandoned / terminal) supersedes every other `until`.
  if (!blocker) return "blocker no longer exists (deleted)";
  if (blocker.abandoned) return "blocker was abandoned";
  if (isTerminalList(listById(board, blocker.list), blocker.list)) {
    return until === "stability"
      ? "blocker reached terminal without a stability point"
      : until === "fence"
        ? "offender reached terminal (no fix fence to wait for)"
        : "blocker reached terminal";
  }
  if (until === "stability") return blocker.stabilityAt ? "blocker reached its stability point" : null;
  if (until === "terminal") return null; // still live -> not terminal yet
  if (until === "fence") {
    const fences = Array.isArray(blocker.fences) ? blocker.fences : [];
    const latest = fences.length ? fences[fences.length - 1].sha : null;
    return latest && latest !== waitingOn.offenderFenceSha ? "offender landed a new fence (its fix)" : null;
  }
  return null;
}

// Re-evaluate every waiting card against its blocker and release the ones whose
// predicate has cleared: CAS-move the card to waitingOn.thenTo (or re-dispatch in
// place when rerun), clear waitingOn, and record a released event on BOTH cards.
// Called at the top of tick()/tickList() (and before the board's dispatch paths).
// Returns { released: [{ id, to }] }.
export async function reevaluateWaiting({ root, board, cards, now = () => new Date().toISOString() }) {
  const released = [];
  // Retry post-commit closure cleanup (including for already-deleted cards) from
  // its board-local sidecar before evaluating any waiter that depends on it.
  await repairPendingCoordinationCleanups({ root });
  // Build cohorts from a fresh disk scan, not the caller's tick snapshot. Two
  // concurrent reevaluators must choose the same successor leader even if one
  // caller began with an older card array; otherwise each could release a
  // different overlapping waiter from the same closing blocker.
  const diskCards = await loadAllCards(root);
  const observedCards = diskCards.length ? diskCards : (cards || []);
  const waiters = observedCards
    .filter((card) => card?.waitingOn && !isHumanHeld(card, board))
    .sort((a, b) => {
      const blocker = String(a.waitingOn.cardId).localeCompare(String(b.waitingOn.cardId));
      if (blocker) return blocker;
      return compareOrder(
        a.planCompletedAt || a.waitingOn.since,
        a.runId || a.id,
        b.planCompletedAt || b.waitingOn.since,
        b.runId || b.id
      );
    });

  // Build an overlap-aware successor chain per closing blocker. Among waiters
  // that may safely run in parallel, keep multiple leaders; every medium/heavy
  // (or evidence-missing) overlap points at the earliest selected leader it
  // overlaps. Thus one closing card can release independent work, but never fans
  // two overlapping runs into the shared checkout in the same reevaluation.
  const predecessor = new Map();
  const groups = new Map();
  for (const card of waiters) {
    const blockerId = card.waitingOn.cardId;
    if (!groups.has(blockerId)) groups.set(blockerId, []);
    groups.get(blockerId).push(card);
  }
  const thresholds = coordinationConfig(loadPolicy()).thresholds;
  for (const group of groups.values()) {
    const touchSets = group.map((card) => readTouchSet(card.runDir));
    const parent = group.map((_, i) => i);
    const find = (i) => {
      let root = i;
      while (parent[root] !== root) root = parent[root];
      while (parent[i] !== i) {
        const next = parent[i];
        parent[i] = root;
        i = next;
      }
      return root;
    };
    const union = (a, b) => {
      const ar = find(a);
      const br = find(b);
      if (ar !== br) parent[br] = ar;
    };
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        // Missing evidence is never permission to fan out. Treat it as a heavy
        // overlap so repair/Plan must make the relationship explicit later.
        const overlap = touchSets[i] && touchSets[j]
          ? scoreOverlap(touchSets[i], touchSets[j], thresholds)
          : { grade: "heavy" };
        if (gradeRank(overlap.grade) >= gradeRank("medium")) union(i, j);
      }
    }
    // One earliest leader per transitive overlap component. Followers retain an
    // honest overlap grade, then re-chain to the leader's terminal edge below so
    // a stale stability marker from an earlier pass cannot wake the component.
    const leaders = new Map();
    for (let i = 0; i < group.length; i++) {
      const component = find(i);
      const leaderIndex = leaders.get(component);
      if (leaderIndex == null) {
        leaders.set(component, i);
        continue;
      }
      const direct = touchSets[i] && touchSets[leaderIndex]
        ? scoreOverlap(touchSets[i], touchSets[leaderIndex], thresholds).grade
        : "heavy";
      predecessor.set(group[i].id, {
        card: group[leaderIndex],
        grade: direct === "medium" ? "medium" : "heavy"
      });
    }
  }

  async function recordWaiterAction(card, action) {
    if (!action || action.kind === "not-ready" || action.kind === "rechain-failed") return;
    if (action.kind === "release") released.push({ id: card.id, to: action.target });

    // Cross-card timeline/index writes stay outside the blocker lock (avoids a
    // nested self-lock), and are advisory: waitingOn is the authoritative edge.
    if (action.blocker) {
      await updateCardCAS(root, action.blocker.id, (bc) => {
        const blocking = Array.isArray(bc.blocking) ? bc.blocking.filter((x) => x !== card.id) : [];
        return {
          ...bc,
          blocking,
          events: appendEvent(bc, {
            at: typeof now === "function" ? now() : now,
            kind: "coordination",
            message: action.kind === "release"
              ? `Card ${short(card)} released (was waiting on this card)`
              : `Card ${short(card)} re-chained behind ${short(action.predecessor)}`
          })
        };
      }).catch(() => {});
    }
    if (action.kind === "rechain") {
      await updateCardCAS(root, action.predecessor.id, (bc) => {
        const blocking = Array.isArray(bc.blocking) ? bc.blocking.slice() : [];
        if (!blocking.includes(card.id)) blocking.push(card.id);
        return { ...bc, blocking };
      }).catch(() => {});
    }
  }

  // DURABLE successor ordering: followers are re-chained BEFORE their component
  // leader is released. A crash after any follower write leaves the leader on the
  // original blocker, which is conservative and self-heals next pass. A failed
  // follower CAS blocks that leader for this pass, so no in-memory "released set"
  // is required to bridge two non-atomic writes.
  const blockedLeaders = new Set();
  for (const card of waiters.filter((candidate) => predecessor.has(candidate.id))) {
    const w = card.waitingOn;
    const pred = predecessor.get(card.id);
    const action = await withCardLock(root, w.cardId, async () => {
      let blocker = null;
      try {
        blocker = await loadCard(root, w.cardId);
        blocker.id = w.cardId;
      } catch {
        blocker = null;
      }
      const ownReason = releaseReason(w, blocker, board, card);
      const leaderReason = releaseReason(pred.card.waitingOn, blocker, board, pred.card);
      if (!ownReason && !leaderReason) return { kind: "not-ready" };

      const nowStr = typeof now === "function" ? now() : now;
      const until = "terminal";
      const chainedWaiting = {
        ...w,
        cardId: pred.card.id,
        cardTitle: pred.card.title || null,
        grade: pred.grade,
        until,
        since: nowStr,
        reason: `Re-chained behind ${pred.card.id} (${pred.card.title || "untitled"}) before releasing the overlap component successor; waiting until ${until}.`
      };
      const events = appendEvent(card, {
        at: nowStr,
        kind: "coordination",
        message: `Re-chained behind ${short(pred.card)} (${pred.grade} overlap) until ${until}`,
        detail: chainedWaiting.reason
      });
      const res = await saveCardCAS(
        root,
        { ...card, status: "ok", runningSince: null, waitingOn: chainedWaiting, events },
        card.rev ?? 0,
        nowStr
      );
      return res.ok
        ? { kind: "rechain", blocker, predecessor: pred.card, card: res.card }
        : { kind: "rechain-failed", predecessor: pred.card };
    });
    if (action?.kind === "rechain-failed") blockedLeaders.add(pred.card.id);
    await recordWaiterAction(card, action);
  }

  // Only component leaders (and independent waiters) can release. Every follower
  // that was ready either durably points at its leader now, or blocked that leader.
  for (const snapshot of waiters.filter((candidate) => !predecessor.has(candidate.id))) {
    if (blockedLeaders.has(snapshot.id)) continue;
    // Follower bookkeeping above appends to the leader's advisory `blocking`
    // index, which legitimately advances its revision. Reload before the release
    // CAS so that durable follower-first ordering does not make its own leader
    // snapshot stale. A concurrently changed wait edge is skipped this pass.
    let card;
    try {
      card = await loadCard(root, snapshot.id);
      card.id = snapshot.id;
    } catch {
      continue;
    }
    if (
      !card.waitingOn ||
      isHumanHeld(card, board) ||
      card.waitingOn.cardId !== snapshot.waitingOn.cardId
    ) continue;
    const w = card.waitingOn;
    const action = await withCardLock(root, w.cardId, async () => {
      let blocker = null;
      try {
        blocker = await loadCard(root, w.cardId);
        blocker.id = w.cardId;
      } catch {
        blocker = null;
      }
      const reason = releaseReason(w, blocker, board, card);
      if (!reason) return null;

      // Retry owner-scoped closure cleanup only after observing committed closure
      // under the lifecycle lock. The sidecar carries a closed-state guard, so a
      // later reopen supersedes this release-all operation.
      if (!blocker || blocker.abandoned || isTerminalList(listById(board, blocker.list), blocker.list)) {
        const repos = new Set([
          repoPathForProject(card.project, board),
          repoPathForProject(blocker?.project, board)
        ].filter(Boolean));
        try {
          cleanupCardCoordination({
            root,
            cardId: w.cardId,
            repoPaths: [...repos],
            removeIntents: true,
            ownerToken: null
          });
        } catch {
          // The closure is committed but its holds are not yet durably cleared.
          // Keep this waiter closed until the queued repair succeeds.
          return null;
        }
      }

      const nowStr = typeof now === "function" ? now() : now;
      const target = w.rerun ? card.list : w.thenTo || card.list;
      const events = appendEvent(card, {
        at: nowStr,
        kind: "coordination",
        message: `Released from waiting on ${w.cardTitle || w.cardId} → ${target} (${reason})`,
        detail: w.reason || null
      });
      const res = await saveCardCAS(
        root,
        { ...card, list: target, status: "ok", runningSince: null, waitingOn: null, events },
        card.rev ?? 0,
        nowStr
      );
      return res.ok ? { kind: "release", blocker, target, card: res.card } : null;
    });
    await recordWaiterAction(card, action);
  }
  return { released };
}

// Apply a cross-card blocker write (used by the engine after it CAS-saves the
// primary card). Adds the `addBlocking` id to the target's `blocking` list and
// appends the event — via the CAS-retry helper so a concurrent write can't clobber
// it. Exported so the engine keeps the write in ONE place.
export async function applyBlockerWrite(root, write, now = () => new Date().toISOString()) {
  if (!write || !write.cardId) return null;
  return updateCardCAS(root, write.cardId, (bc) => {
    const blocking = Array.isArray(bc.blocking) ? bc.blocking.slice() : [];
    if (write.addBlocking && !blocking.includes(write.addBlocking)) blocking.push(write.addBlocking);
    return { ...bc, blocking, events: write.event ? appendEvent(bc, write.event) : bc.events };
  }).catch(() => null);
}

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
  rmSync
} from "node:fs";
import { saveCardCAS, updateCardCAS } from "./board.mjs";
import { policyLoadState } from "./policy.mjs";
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
  serializeWhenUnavailable: true
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

export function touchSetPath(runDir) {
  return path.join(runDir, "touch-set.json");
}

// Validate + normalise a parsed touch-set object (schema version 1). Returns the
// normalised touch-set, or null when it is missing/invalid (wrong version, not an
// object). Content may be sparse — an empty prediction is a valid schema; it
// simply scores `none` against everything.
export function validateTouchSet(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.version !== 1) return null;
  // Reject any absolute / traversal path in a path-bearing field — an invalid
  // touch-set fails the same way a wrong version does (null), which the engine
  // treats as "no valid touch-set" and parks the plan honestly (Q1 enforcement).
  for (const field of ["files", "dirs", "exclusive"]) {
    const v = obj[field];
    if (Array.isArray(v) && v.some((x) => typeof x === "string" && isUnsafePath(x))) return null;
  }
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

// Read + validate a card's touch-set from <runDir>/touch-set.json. Best-effort:
// a missing/unreadable/invalid file returns null (the caller treats a null as
// "this run has not declared a touch-set yet").
export function readTouchSet(runDir) {
  if (!runDir || typeof runDir !== "string") return null;
  try {
    return validateTouchSet(JSON.parse(readFileSync(touchSetPath(runDir), "utf8")));
  } catch {
    return null;
  }
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
    mkdirSync(intentDir(), { recursive: true });
    appendFileSync(intentPath(repoPath), JSON.stringify(row) + "\n");
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
  let rows = [];
  try {
    rows = readFileSync(intentPath(repoPath), "utf8")
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
  registerTouchSetIntent({ repoPath, card, touchSet, now });
  return { grown: true, added };
}

// Drop every ledger row a card owns (session "kanban:<cardId>") — called when the
// card reaches a terminal list or is abandoned/deleted, mirroring coord-mcp's
// removeIntentsBySession. Best-effort; a missing ledger is a no-op.
export function removeCardIntents({ repoPath, cardId }) {
  if (!repoPath || !cardId) return;
  const file = intentPath(repoPath);
  let txt;
  try {
    txt = readFileSync(file, "utf8");
  } catch {
    return; // no ledger for this repo yet
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
  try {
    mkdirSync(intentDir(), { recursive: true });
    writeFileSync(file, kept.map((l) => l).join("\n") + (kept.length ? "\n" : ""));
  } catch {
    /* best-effort */
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
    mkdirSync(intentDir(), { recursive: true });
    appendFileSync(intentPath(repoPath), JSON.stringify(row) + "\n");
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
function leaseExpired(lease, nowMs) {
  const exp = lease?.expiresAt ? Date.parse(lease.expiresAt) : NaN;
  return !Number.isFinite(exp) || exp <= nowMs;
}

// Try to take exclusive leases on `paths` for a card. O_EXCL create; a same-card
// lease is renewed; an EXPIRED foreign lease is broken and taken; a live foreign
// lease blocks (returns {ok:false, heldBy}). On a block, any lease acquired in
// THIS call is rolled back so a card never holds a partial set. Returns
// {ok:true, acquired:[paths]} or {ok:false, heldBy, path}.
export function acquireLeases({ repoPath, card, paths, ttlMinutes = DEFAULT_COORDINATION.leaseTtlMinutes, now = () => new Date().toISOString() }) {
  if (!repoPath || !Array.isArray(paths) || paths.length === 0) return { ok: true, acquired: [] };
  const nowStr = typeof now === "function" ? now() : now;
  const nowMs = Date.parse(nowStr) || Date.now();
  const expiresAt = new Date(nowMs + Math.max(1, ttlMinutes) * 60_000).toISOString();
  const acquired = [];
  try {
    mkdirSync(leaseDirFor(repoPath), { recursive: true });
  } catch {
    return { ok: true, acquired: [] }; // substrate down -> serialize gate covers it, don't block here
  }
  const record = (p) => JSON.stringify({ path: normPath(p), cardId: card.id, runId: card.runId || null, holder: `kanban:${card.id}`, acquiredAt: nowStr, expiresAt });
  for (const p of paths) {
    const file = leasePathFor(repoPath, p);
    try {
      writeFileSync(file, record(p), { flag: "wx" });
      acquired.push(p);
      continue;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        // unexpected error — roll back and treat as unavailable (don't block)
        rollbackLeases(repoPath, card.id, acquired);
        return { ok: true, acquired: [] };
      }
    }
    // exists — inspect the holder
    const cur = readLease(file);
    if (cur && cur.cardId === card.id) {
      try { writeFileSync(file, record(p)); } catch { /* renew best-effort */ }
      acquired.push(p);
      continue;
    }
    if (!cur || leaseExpired(cur, nowMs)) {
      // Take over an absent/expired lease by unlink-then-O_EXCL create, so two
      // processes racing the same expired lease cannot both "take" it: whoever
      // loses the exclusive create (EEXIST) treats it as held-by-other.
      try { rmSync(file, { force: true }); } catch { /* already gone */ }
      try {
        writeFileSync(file, record(p), { flag: "wx" });
        acquired.push(p);
        continue;
      } catch {
        const winner = readLease(file);
        rollbackLeases(repoPath, card.id, acquired);
        return { ok: false, heldBy: winner?.cardId || null, path: normPath(p) };
      }
    }
    // held by another live card — roll back and report
    rollbackLeases(repoPath, card.id, acquired);
    return { ok: false, heldBy: cur?.cardId || null, path: normPath(p) };
  }
  return { ok: true, acquired };
}

function rollbackLeases(repoPath, cardId, paths) {
  for (const p of paths) {
    const file = leasePathFor(repoPath, p);
    const cur = readLease(file);
    if (cur && cur.cardId === cardId) {
      try { rmSync(file, { force: true }); } catch { /* best-effort */ }
    }
  }
}

// Renew (extend the TTL of) the leases a card already holds — called at each fence
// so a long implement phase does not let its own leases expire under it.
export function renewLeases({ repoPath, card, paths, ttlMinutes = DEFAULT_COORDINATION.leaseTtlMinutes, now = () => new Date().toISOString() }) {
  if (!repoPath || !Array.isArray(paths) || paths.length === 0) return;
  const nowStr = typeof now === "function" ? now() : now;
  const nowMs = Date.parse(nowStr) || Date.now();
  const expiresAt = new Date(nowMs + Math.max(1, ttlMinutes) * 60_000).toISOString();
  for (const p of paths) {
    const file = leasePathFor(repoPath, p);
    const cur = readLease(file);
    if (cur && cur.cardId === card.id) {
      try { writeFileSync(file, JSON.stringify({ ...cur, expiresAt })); } catch { /* best-effort */ }
    }
  }
}

// Release every lease a card holds in a repo (advance past implement, terminal,
// abandon). Best-effort; scans the repo's lease dir and removes the card's files.
export function releaseLeases({ repoPath, cardId }) {
  if (!repoPath || !cardId) return;
  let entries = [];
  try {
    entries = readdirSync(leaseDirFor(repoPath), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const file = path.join(leaseDirFor(repoPath), e.name);
    const cur = readLease(file);
    if (cur && cur.cardId === cardId) {
      try { rmSync(file, { force: true }); } catch { /* best-effort */ }
    }
  }
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
  const ts = readTouchSet(card.runDir);
  if (!ts) {
    return {
      kind: "park",
      planCompletedAt: nowStr,
      reason:
        `coordination is enabled but no valid touch-set.json was written under ${card.runDir} ` +
        `(schema version 1, listing the files/dirs this run will touch). The plan phase must predict ` +
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
// The blocker DISAPPEARING supersedes every `until`: a blocker that is deleted,
// abandoned, or has reached a terminal list will never produce any further signal
// (stability point OR fix fence), so a waiter keyed to one of those would be
// stranded forever — skipped by every tick, silently. Terminal strictly
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
  // Lease: the truth is the lease files, not a blocker card. Check directly.
  if (until === "lease") {
    const repoPath = repoPathForProject(waiterCard?.project, board);
    const ts = readTouchSet(waiterCard?.runDir);
    const paths = ts?.exclusive || [];
    if (!repoPath || paths.length === 0) return "exclusive lease no longer applies";
    return leaseHeldByOther({ repoPath, cardId: waiterCard.id, paths }) ? null : "exclusive lease is now free";
  }
  // Disappearance (deleted / abandoned / terminal) supersedes every other `until`.
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
  const byId = new Map((cards || []).map((c) => [c.id, c]));
  for (const card of cards || []) {
    if (!card.waitingOn) continue;
    const w = card.waitingOn;
    const blocker = byId.get(w.cardId) || null;
    const reason = releaseReason(w, blocker, board, card);
    if (!reason) continue;
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
    if (!res.ok) continue; // lost the race — a later tick re-evaluates it
    released.push({ id: card.id, to: target });
    // Best-effort released event on the blocker + drop it from `blocking`.
    if (blocker) {
      await updateCardCAS(root, blocker.id, (bc) => {
        const blocking = Array.isArray(bc.blocking) ? bc.blocking.filter((x) => x !== card.id) : [];
        return {
          ...bc,
          blocking,
          events: appendEvent(bc, {
            at: typeof now === "function" ? now() : now,
            kind: "coordination",
            message: `Card ${short(card)} released (was waiting on this card)`
          })
        };
      }).catch(() => {});
    }
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

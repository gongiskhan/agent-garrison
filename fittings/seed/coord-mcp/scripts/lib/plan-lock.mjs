// Per-repo planning mutex with TTL + heartbeat.
//
// Self-contained file mutex (MIT, dependency-free) so the highest-stakes
// coordination guarantee — only one session plans a repo at a time — works even
// when agent_mail is down. TTL + heartbeat means a crashed or abandoned
// planning session auto-releases; a forgotten plan-mode session can never block
// everyone forever.
//
// Lock file: ~/.garrison/coord/plan-locks/<repoSlug>.json
//   { repo, session, summary, startedAt, heartbeatAt, expiresAt, ttlMs }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoSlug } from "./repo.mjs";

// Read at CALL time (not module-load) so the config / env is honored at runtime.
function defaultTtlMs() {
  const n = Number(process.env.COORD_PLAN_LOCK_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000; // 15 min
}

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}
function lockDir() {
  return path.join(garrisonHome(), "coord", "plan-locks");
}
function lockPath(repo) {
  return path.join(lockDir(), `${repoSlug(repo)}.json`);
}

function readLock(repo) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(repo), "utf8"));
  } catch {
    return null;
  }
}

function expired(lock, now) {
  if (!lock || !lock.expiresAt) return true;
  const t = new Date(lock.expiresAt).getTime();
  return Number.isNaN(t) || t <= now.getTime();
}

// Status without mutation. { held, stale, lock }.
export function lockStatus(repo, now = new Date()) {
  const l = readLock(repo);
  if (!l) return { held: false, stale: false, lock: null };
  if (expired(l, now)) return { held: false, stale: true, lock: l };
  return { held: true, stale: false, lock: l };
}

// Try to acquire. Free / stale / same-session -> granted. Held by a DIFFERENT
// live session -> { acquired:false, reason:"held", holder }.
export function acquireLock(repo, session, summary, now = new Date(), ttlMs = defaultTtlMs()) {
  fs.mkdirSync(lockDir(), { recursive: true });
  const p = lockPath(repo);
  const base = {
    repo,
    session,
    summary: String(summary || ""),
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    ttlMs
  };

  // Fast path — ATOMIC exclusive create when the repo is unlocked. Under
  // concurrent contention exactly ONE fresh acquirer wins (O_EXCL via "wx"); the
  // rest get EEXIST and fall through to the read path. This makes the common race
  // (two new sessions racing on an unlocked repo) impossible to double-acquire.
  try {
    fs.writeFileSync(p, JSON.stringify(base, null, 2), { flag: "wx" });
    return { acquired: true, lock: base, recovered: false };
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
  }

  // A lock file exists. If it is unreadable/partial, a concurrent creator is
  // mid-write (the window between the "wx" create and the payload write) — treat
  // it as CONTENDED, never as free, so a partial read can never double-grant.
  const cur = readLock(repo);
  if (cur === null) {
    return { acquired: false, reason: "contended" };
  }
  // Live + held by someone else -> WAIT.
  if (!expired(cur, now) && cur.session !== session) {
    return { acquired: false, reason: "held", holder: cur };
  }
  // Same-session re-acquire (preserve startedAt) OR takeover of a stale/expired
  // lock. The residual race here (two takers of the SAME stale lock both writing)
  // is self-correcting: the file ends with one holder, and the loser discovers it
  // on its next heartbeat/plan_status (returns not-holder). Acceptable for a local
  // single-user advisory tool — never data corruption.
  const startedAt = cur && cur.session === session && cur.startedAt ? cur.startedAt : now.toISOString();
  const recovered = Boolean(cur && expired(cur, now) && cur.session !== session);
  const lock = { ...base, startedAt };
  fs.writeFileSync(p, JSON.stringify(lock, null, 2));
  return { acquired: true, lock, recovered };
}

// Extend the lock if this session still holds it AND it has not expired. An
// expired lock can NOT be resurrected by a heartbeat — it must auto-release and be
// re-acquired (possibly by another session) via acquireLock, or staleness would
// never self-heal.
export function heartbeat(repo, session, now = new Date()) {
  const l = readLock(repo);
  if (!l || l.session !== session) return { ok: false, reason: "not-holder" };
  if (expired(l, now)) return { ok: false, reason: "expired" };
  const ttlMs = l.ttlMs || defaultTtlMs();
  l.heartbeatAt = now.toISOString();
  l.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  fs.writeFileSync(lockPath(repo), JSON.stringify(l, null, 2));
  return { ok: true, lock: l };
}

// Release if this session holds it AND it has not expired. An EXPIRED lock is NOT
// unlinked here — it is taken over by acquireLock instead. This closes the race
// where an old holder, after its lock expired and a new session took over, would
// otherwise delete the new holder's lock (Codex CO3 r4).
export function releaseLock(repo, session, now = new Date()) {
  const l = readLock(repo);
  if (!l) return { released: false, reason: "not-held" };
  if (l.session !== session) return { released: false, reason: "held-by-other", holder: l };
  if (expired(l, now)) return { released: false, reason: "expired" };
  fs.rmSync(lockPath(repo), { force: true });
  return { released: true };
}

// Force-remove a repo's planning lock regardless of holder/expiry — the
// admin/"release-lock" action surfaced (guarded by a confirm) in the Coordination
// view, for clearing a stale or abandoned lock. Returns whether a lock existed.
//
// Removes the slug-derived file AND any lock file whose STORED repo field matches:
// the state view lists locks by scanning the dir and reporting their stored repo,
// so release must honour that same identity or a lock written under a different
// slug scheme (e.g. a pre-fix cwd-resolved name key) becomes unreleasable.
export function forceReleaseLock(repo) {
  const targets = new Set([lockPath(repo)]);
  try {
    for (const f of fs.readdirSync(lockDir())) {
      if (!f.endsWith(".json") || f.endsWith(".waiters.json")) continue;
      const p = path.join(lockDir(), f);
      try {
        const l = JSON.parse(fs.readFileSync(p, "utf8"));
        if (l && l.repo === repo) targets.add(p);
      } catch {
        /* unreadable/partial lock file — not identifiable, leave it alone */
      }
    }
  } catch {
    /* no lock dir yet */
  }
  let existed = false;
  for (const p of targets) {
    if (fs.existsSync(p)) existed = true;
    fs.rmSync(p, { force: true });
    fs.rmSync(p.replace(/\.json$/, ".waiters.json"), { force: true });
  }
  return { released: existed, repo };
}

// ---- waiters (for the "B waits" surface + observability layer 5) ----
// Map { session: { summary, since } } per repo. A session that gets WAIT records
// itself; it clears on acquire. Stale entries (older than freshMs) are ignored,
// so a crashed waiter never lingers.
function waitersPath(repo) {
  return path.join(lockDir(), `${repoSlug(repo)}.waiters.json`);
}
function readWaitersRaw(repo) {
  try {
    const o = JSON.parse(fs.readFileSync(waitersPath(repo), "utf8"));
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
export function recordWaiter(repo, session, summary, now = new Date()) {
  fs.mkdirSync(lockDir(), { recursive: true });
  const w = readWaitersRaw(repo);
  if (!w[session]) w[session] = { summary: String(summary || ""), since: now.toISOString() };
  else w[session].summary = String(summary || w[session].summary);
  fs.writeFileSync(waitersPath(repo), JSON.stringify(w, null, 2));
}
export function clearWaiter(repo, session) {
  const w = readWaitersRaw(repo);
  if (w[session]) {
    delete w[session];
    fs.writeFileSync(waitersPath(repo), JSON.stringify(w, null, 2));
  }
}
export function readWaiters(repo, now = new Date(), freshMs = 5 * 60 * 1000) {
  const w = readWaitersRaw(repo);
  return Object.entries(w)
    .filter(([, v]) => v && v.since && now.getTime() - new Date(v.since).getTime() <= freshMs)
    .map(([session, v]) => ({ session, summary: v.summary, since: v.since }));
}

// Per-repo planning mutex — a lease on the state service, keyed
// `plan:<repoKey>`, with TTL + heartbeat.
//
// This replaces the file mutex under ~/.garrison/coord/plan-locks. The file
// mutex could only ever serialize planners on ONE box, and its stale-holder
// recovery leaned on process.kill(pid, 0), which is meaningless across hosts.
// The service does the whole job in one transaction: exactly one of two
// simultaneous acquirers is granted, the loser is told who holds it, and a
// crashed planner auto-releases at expiry. There is deliberately NO local
// fallback — an unreachable service is a loud error, never a lock that only
// this machine believes in.
//
// Fencing: a grant carries a monotonic `fence`. Re-entry by the same holder
// renews and KEEPS the fence; a takeover mints a new one.
import crypto from "node:crypto";
import { stateClient, StateApiError } from "./state.mjs";

// Read at CALL time (not module-load) so the config / env is honored at runtime.
export function defaultTtlMs() {
  const n = Number(process.env.COORD_PLAN_LOCK_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000; // 15 min
}

export function planLeaseKey(repoKey) {
  return `plan:${repoKey}`;
}

// The holder token is DERIVED from the session id rather than randomly minted
// per process, for two concrete reasons:
//   1. this MCP server can be restarted mid-session (Claude Code re-spawns it);
//      a fresh random token would make the session WAIT on a lease it already
//      holds, until the TTL expired.
//   2. the admin force-release (`coord release-lock`, the Coordination view's
//      button) has no other way to present the holder's token — the service
//      exposes no unconditional break verb.
// It carries exactly the authority today's file lock did: releaseLock(repo,
// session) already trusted whoever knew the session id.
export function holderTokenFor(session) {
  return crypto.createHash("sha256").update(`coord/plan/${session}`).digest("hex").slice(0, 32);
}

function lockFromLease(lease) {
  if (!lease) return null;
  const meta = lease.meta || {};
  return {
    repo: meta.repoKey ?? null,
    session: lease.holder,
    summary: meta.summary ?? "",
    startedAt: meta.startedAt ?? lease.acquiredAt,
    expiresAt: lease.expiresAt,
    fence: lease.fence
  };
}

// Status without mutation. { held, stale, lock } — the same shape the file
// mutex reported, so plan_status and the Coordination view are unchanged.
export async function planLeaseStatus(repoKey) {
  const lease = await stateClient().getLease(planLeaseKey(repoKey));
  if (!lease) return { held: false, stale: false, lock: null };
  if (lease.expired) return { held: false, stale: true, lock: lockFromLease(lease) };
  return { held: true, stale: false, lock: lockFromLease(lease) };
}

// Try to acquire. Free / expired / same-session -> granted. Held by a DIFFERENT
// live session -> { acquired:false, reason:"held", holder }.
export async function acquirePlanLease(repoKey, session, summary, now = new Date(), ttlMs = defaultTtlMs()) {
  const client = stateClient();
  const key = planLeaseKey(repoKey);
  // Read first purely so a takeover can be REPORTED as one (recoveredStaleLock)
  // and so a same-session re-entry preserves its original startedAt. The grant
  // decision itself is the service's single atomic statement, not this read.
  const prior = await client.getLease(key);
  const startedAt =
    prior && prior.holder === session && prior.meta && prior.meta.startedAt ? prior.meta.startedAt : now.toISOString();

  const res = await client.acquireLease({
    key,
    holder: session,
    holderToken: holderTokenFor(session),
    ttlMs,
    meta: { repoKey, summary: String(summary || ""), startedAt }
  });

  if (!res.granted) {
    const meta = res.meta || {};
    return {
      acquired: false,
      reason: "held",
      holder: {
        session: res.holder,
        summary: meta.summary ?? "",
        startedAt: meta.startedAt ?? null,
        expiresAt: res.expiresAt ?? null
      }
    };
  }
  return {
    acquired: true,
    lock: { repo: repoKey, session, summary: String(summary || ""), startedAt, expiresAt: res.expiresAt, fence: res.fence },
    recovered: Boolean(prior && prior.expired && prior.holder !== session)
  };
}

// Extend the lease if this session still holds it AND it has not expired. An
// expired lease can NOT be resurrected by a heartbeat — the service refuses,
// which is what lets staleness self-heal into a takeover.
export async function renewPlanLease(repoKey, session, ttlMs = defaultTtlMs()) {
  try {
    const res = await stateClient().renewLease({ key: planLeaseKey(repoKey), holderToken: holderTokenFor(session), ttlMs });
    return { ok: true, lock: { repo: repoKey, session, expiresAt: res.expiresAt } };
  } catch (err) {
    if (err instanceof StateApiError && err.status === 409) {
      const holder = err.body && err.body.holder;
      return { ok: false, reason: holder && holder !== session ? "not-holder" : "expired" };
    }
    throw err;
  }
}

// Release if this session's token still matches the stored one. A holder whose
// lease already lapsed AND was taken over matches nothing, so it can never
// delete the new holder's lease — the token closes that race structurally.
export async function releasePlanLease(repoKey, session) {
  const client = stateClient();
  const key = planLeaseKey(repoKey);
  const res = await client.releaseLease({ key, holderToken: holderTokenFor(session) });
  if (res.released) return { released: true };
  const current = await client.getLease(key);
  if (!current) return { released: false, reason: "not-held" };
  return { released: false, reason: "held-by-other", holder: lockFromLease(current) };
}

// Force-release regardless of holder — the admin action surfaced (behind a
// confirm) in the Coordination view, for clearing an abandoned lease. The
// holder's token is derivable from its session id, which is exactly why the
// token is derived rather than random.
export async function forceReleasePlanLease(repoKey) {
  const client = stateClient();
  const key = planLeaseKey(repoKey);
  const lease = await client.getLease(key);
  if (!lease) return { released: false, repo: repoKey, reason: "not-held" };
  const res = await client.releaseLease({ key, holderToken: holderTokenFor(lease.holder) });
  // A lease minted by something OTHER than coord-mcp does not carry a token
  // derived from its holder, so the delete matches nothing. Say so — a release
  // button that reports success while the lock stands is the worst outcome here.
  if (!res.released) return { released: false, repo: repoKey, reason: "foreign-holder", holder: lease.holder };
  return { released: true, repo: repoKey };
}

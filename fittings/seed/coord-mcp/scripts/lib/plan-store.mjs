// Per-repo plan ledger — records each released plan so the NEXT planner
// inherits it, wherever on the mesh that planner runs. This sidesteps the
// unreliable global-plans association problem (Claude Code plans live in
// ~/.claude/plans with random, non-repo-keyed names): coord-mcp owns a
// repo-keyed record of what each planning session declared.
//
// Ledger: the state service's append-only `plans` table, keyed by the mesh repo
// key. Row payloads carry a `kind` so one table serves two append-only records:
//
//   plan        { kind:"plan", summary, startedAt, releasedAt }
//   wait        { kind:"wait", summary }         a session that got WAIT
//   wait-clear  { kind:"wait-clear" }            force-release drops earlier waits
//
// The waiters live here rather than in a store of their own because a waiter IS
// a declared-but-ungranted plan, and because `plans` is the only repo-scoped,
// newest-first enumerable surface the service exposes (leases have no list
// verb, and `events` only reads forward from a sequence).
import { stateClient } from "./state.mjs";
import { withinLookback } from "./lookback.mjs";

const LEDGER_LIMIT = 100;
const WAITER_FRESH_MS = 5 * 60 * 1000;

// Newest-first, with the payload flattened onto the row so a plan row keeps the
// legacy { repo, session, summary, startedAt, releasedAt } shape its consumers
// (read-bundle, the CLI, the Coordination view) already read.
async function ledger(repoKey, limit = LEDGER_LIMIT) {
  const rows = await stateClient().listPlans(repoKey, limit);
  return rows.map((r) => ({
    seq: r.seq,
    repo: r.repoKey,
    session: r.session,
    at: r.at,
    kind: "plan",
    ...(r.payload && typeof r.payload === "object" ? r.payload : {})
  }));
}

export async function recordPlan(repoKey, entry) {
  await stateClient().appendPlan({
    repoKey,
    session: entry.session || "unknown",
    payload: {
      kind: "plan",
      summary: String(entry.summary || ""),
      startedAt: entry.startedAt || null,
      releasedAt: entry.releasedAt || null
    }
  });
}

// Plan rows only, newest first.
export async function readPlans(repoKey) {
  return (await ledger(repoKey)).filter((r) => r.kind === "plan");
}

export async function lastReleasedPlan(repoKey) {
  return (await readPlans(repoKey)).find((p) => p.releasedAt) ?? null;
}

export async function recentPlans(repoKey, now = new Date()) {
  return (await readPlans(repoKey)).filter((p) => withinLookback(p.releasedAt || p.startedAt || p.at, now));
}

// ---- waiters (the "B waits" surface + observability layer 5) ----
// A session that gets WAIT records itself. There is no delete verb: a waiter
// ages out after freshMs, and a session that later HOLDS the lease is filtered
// out by the caller, so a crashed waiter never lingers.
export async function recordWaiter(repoKey, session, summary) {
  await stateClient().appendPlan({
    repoKey,
    session: session || "unknown",
    payload: { kind: "wait", summary: String(summary || "") }
  });
}

// Force-release drops every waiter recorded so far: append-only, so the newest
// wait-clear row is a floor the reader applies rather than a deletion.
export async function clearWaiters(repoKey, session = "force-release") {
  await stateClient().appendPlan({ repoKey, session, payload: { kind: "wait-clear" } });
}

export async function readWaiters(repoKey, now = new Date(), { freshMs = WAITER_FRESH_MS, exclude = null } = {}) {
  const rows = await ledger(repoKey);
  const clearSeq = rows.find((r) => r.kind === "wait-clear")?.seq ?? 0; // newest-first
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (r.kind !== "wait" || r.seq <= clearSeq) continue;
    if (r.session === exclude || seen.has(r.session)) continue;
    seen.add(r.session);
    const since = r.at;
    const t = new Date(since).getTime();
    if (Number.isNaN(t) || now.getTime() - t > freshMs) continue;
    out.push({ session: r.session, summary: r.summary ?? "", since });
  }
  return out;
}

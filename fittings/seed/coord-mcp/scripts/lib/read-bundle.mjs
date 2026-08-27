// The planning read-bundle — what the NEXT planner inherits the instant it
// acquires the lease, so it plans with full knowledge instead of blind:
//   (a) the plan the session that just released the lease produced
//   (b) all recent plans for this repo within the lookback window
//   (c) the in-flight intents / lease of currently-running sessions
// Mechanical (state-service reads) — NO model call (stays within PTY). Because
// the ledger is now mesh-wide, (a) and (b) can have been written on another
// machine: a planner on the Air inherits a planner on dev-madrid.
import { planLeaseStatus } from "./plan-lease.mjs";
import { lastReleasedPlan, recentPlans } from "./plan-store.mjs";
import { recentIntents } from "./intent-store.mjs";
import { lookbackDays } from "./lookback.mjs";

export async function buildReadBundle(repoKey, now = new Date()) {
  const [releasedPlan, plans, lock, intents] = await Promise.all([
    lastReleasedPlan(repoKey), // (a)
    recentPlans(repoKey, now), // (b)
    planLeaseStatus(repoKey), // (c)
    recentIntents(repoKey, now)
  ]);
  return {
    repo: repoKey,
    lookbackDays: lookbackDays(now),
    releasedPlan,
    recentPlans: plans,
    inFlight: { lock, intents }
  };
}

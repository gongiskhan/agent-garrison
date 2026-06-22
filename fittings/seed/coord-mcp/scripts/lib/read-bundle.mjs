// The planning read-bundle — what the NEXT planner inherits the instant it
// acquires the lock, so it plans with full knowledge instead of blind:
//   (a) the plan the session that just released the lock produced
//   (b) all recent plans for this repo within the lookback window
//   (c) the in-flight intents / decisions / leases of currently-running sessions
// Mechanical (file scans + a bd query) — NO model call (stays within PTY).
import { lockStatus } from "./plan-lock.mjs";
import { lastReleasedPlan, recentPlans } from "./plan-store.mjs";
import { recentIntents } from "./intent-store.mjs";
import { readBeadsInflight } from "./beads.mjs";
import { lookbackDays } from "./lookback.mjs";

export function buildReadBundle(repo, now = new Date()) {
  return {
    repo,
    lookbackDays: lookbackDays(now),
    releasedPlan: lastReleasedPlan(repo), // (a)
    recentPlans: recentPlans(repo, now), // (b)
    inFlight: {
      // (c)
      lock: lockStatus(repo, now),
      intents: recentIntents(repo, now),
      beads: readBeadsInflight(repo)
    }
  };
}

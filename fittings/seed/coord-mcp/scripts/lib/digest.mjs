// Repo-scoped coordination digest injected by the SessionStart/UserPromptSubmit
// hook. Surfaces (a) the planning-lock state, (b) recent conflicting/active intents
// (channel 1), and (c) active agent_mail FILE LEASES (channel 2) — so a session
// that coordinates ONLY by taking a lease still shows up to others. Plus a standing
// NUDGE. Capped at a few hundred tokens. Async because leases are fetched live
// (graceful: leases degrade to [] if agent_mail is down — never an error path).
//
// Shares the SAME readers as coord-state.mjs (recentIntents/conflictsFor,
// lockStatus, fetchActiveLeases) so the digest can never disagree with the CLI/UI.
import { conflictsFor, recentIntents } from "./intent-store.mjs";
import { lockStatus } from "./plan-lock.mjs";
import { fetchActiveLeases } from "./agentmail.mjs";

const MAX_BYTES = 1200; // a few hundred tokens

export const NUDGE =
  "[coord] Before a SUBSTANTIAL task (anything touching shared structure/architecture or other in-flight work), call begin_planning(repo, summary) and honor a WAIT. Declare intent (declare_intent) for architectural work so other sessions see it. When unsure, treat it as substantial and plan.";

// Does an agent_mail lease's path pattern overlap this session's working set?
export function leaseOverlaps(lease, mine) {
  const pat = String(lease.pathPattern || "");
  if (!pat) return false;
  const lit = pat.replace(/\*+.*$/, "").replace(/\/+$/, ""); // literal prefix before the first glob
  const hay = [mine && mine.area, ...((mine && mine.files) || [])].filter(Boolean).map(String);
  return hay.some((h) => (lit && h.includes(lit)) || (h && pat.includes(h)));
}

// mine = { session, area, files }. With a working set, surfaces HARD conflicts
// (overlapping intents OR leases); without one, surfaces recent intents + active
// leases as AWARENESS.
export async function buildDigest(repo, mine, now = new Date()) {
  const session = mine && mine.session;
  const lock = lockStatus(repo, now);
  const hasWorkingSet = Boolean(mine && (mine.area || (mine.files && mine.files.length)));
  const conflicts = hasWorkingSet ? conflictsFor(repo, mine, now) : [];
  const conflictKeys = new Set(conflicts.map((c) => `${c.session}|${c.ts}`));
  const awareness = recentIntents(repo, now)
    .filter((i) => i.session !== session && !conflictKeys.has(`${i.session}|${i.ts}`))
    .slice(0, 5);

  // Channel 2: active file leases (graceful — [] if agent_mail is down).
  let leases = [];
  try {
    leases = await fetchActiveLeases(repo);
  } catch {
    leases = [];
  }
  const leaseConflicts = hasWorkingSet ? leases.filter((l) => leaseOverlaps(l, mine)) : [];
  const leaseConflictIds = new Set(leaseConflicts.map((l) => l.id));
  const leaseAwareness = leases.filter((l) => !leaseConflictIds.has(l.id)).slice(0, 5);

  const lines = [];
  if (lock.held && lock.lock && lock.lock.session !== session) {
    lines.push(`PLANNING LOCK held by ${lock.lock.session} since ${lock.lock.startedAt} — "${truncate(lock.lock.summary, 120)}". If you intend to plan this repo, begin_planning will return WAIT.`);
  }
  for (const c of conflicts.slice(0, 5)) {
    lines.push(`CONFLICT (intent): ${c.session} is working on ${c.area || (c.files || []).join(", ")} — "${truncate(c.reason, 100)}" (${c.ts})`);
  }
  for (const l of leaseConflicts.slice(0, 5)) {
    lines.push(`CONFLICT (lease): ${l.agent} holds ${l.exclusive ? "an EXCLUSIVE " : "a "}lease on ${l.pathPattern} — "${truncate(l.reason, 80)}"`);
  }
  for (const a of awareness) {
    lines.push(`ACTIVE INTENT: ${a.session} on ${a.area || (a.files || []).join(", ")} — "${truncate(a.reason, 100)}" (${a.ts})`);
  }
  for (const l of leaseAwareness) {
    lines.push(`FILE LEASE: ${l.agent} holds ${l.pathPattern} — "${truncate(l.reason, 80)}"`);
  }

  let body = lines.join("\n");
  if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES) + "\n…(truncated)";

  const text = [NUDGE, body].filter(Boolean).join("\n\n");
  return {
    text,
    bytes: Buffer.byteLength(text),
    conflicts,
    awareness,
    leases,
    leaseConflicts,
    lock,
    hasConflicts: conflicts.length > 0 || leaseConflicts.length > 0
  };
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

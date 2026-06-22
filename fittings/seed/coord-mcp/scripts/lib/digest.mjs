// Repo-scoped coordination digest injected by the SessionStart/UserPromptSubmit
// hook (CO4). Surfaces (a) the planning-lock state, (b) recent conflicting intents
// whose area overlaps the session's working set, and (c) an agent_mail-leases note
// when the server is up. Plus a standing NUDGE to declare intent + call
// begin_planning before substantial work. Capped at a few hundred tokens.
import { conflictsFor, recentIntents } from "./intent-store.mjs";
import { lockStatus } from "./plan-lock.mjs";

const MAX_BYTES = 1200; // a few hundred tokens

export const NUDGE =
  "[coord] Before a SUBSTANTIAL task (anything touching shared structure/architecture or other in-flight work), call begin_planning(repo, summary) and honor a WAIT. Declare intent (declare_intent) for architectural work so other sessions see it. When unsure, treat it as substantial and plan.";

// mine = { session, area, files }. With a working set (area/files) the digest
// surfaces HARD conflicts (overlapping intents by other sessions). Without one
// (e.g. SessionStart, where the working set isn't known yet) it surfaces recent
// intents by other sessions as AWARENESS so the agent knows who else is active.
export function buildDigest(repo, mine, now = new Date()) {
  const session = mine && mine.session;
  const lock = lockStatus(repo, now);
  const hasWorkingSet = Boolean(mine && (mine.area || (mine.files && mine.files.length)));
  const conflicts = hasWorkingSet ? conflictsFor(repo, mine, now) : [];
  // Always surface awareness of OTHER sessions' recent intents (minus the ones
  // already shown as hard conflicts), so a session sees who else is active even
  // without a precise working set.
  const conflictKeys = new Set(conflicts.map((c) => `${c.session}|${c.ts}`));
  const awareness = recentIntents(repo, now)
    .filter((i) => i.session !== session && !conflictKeys.has(`${i.session}|${i.ts}`))
    .slice(0, 5);

  const lines = [];
  if (lock.held && lock.lock && lock.lock.session !== session) {
    lines.push(
      `PLANNING LOCK held by ${lock.lock.session} since ${lock.lock.startedAt} — "${truncate(lock.lock.summary, 120)}". If you intend to plan this repo, begin_planning will return WAIT.`
    );
  }
  for (const c of conflicts.slice(0, 5)) {
    lines.push(`CONFLICT: ${c.session} is working on ${c.area || (c.files || []).join(", ")} — "${truncate(c.reason, 100)}" (${c.ts})`);
  }
  for (const a of awareness) {
    lines.push(`ACTIVE INTENT: ${a.session} on ${a.area || (a.files || []).join(", ")} — "${truncate(a.reason, 100)}" (${a.ts})`);
  }

  let body = lines.join("\n");
  if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES) + "\n…(truncated)";

  const text = [NUDGE, body].filter(Boolean).join("\n\n");
  return {
    text,
    bytes: Buffer.byteLength(text),
    conflicts,
    awareness,
    lock,
    hasConflicts: conflicts.length > 0
  };
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

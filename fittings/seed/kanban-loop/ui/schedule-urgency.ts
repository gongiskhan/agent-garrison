// How close a scheduled card is to its instant — the three states the card
// front paints.
//
// A hold that is merely "not yet" and a hold that is about to fire read the same
// on a board you scan rather than read, which is exactly when a schedule matters.
// So the chip has THREE states, not two: quiet while the instant is far off,
// amber for the last few minutes before it, alarm once it has arrived.
//
// Kept pure and separate from main.tsx so the boundaries are testable without a
// browser and without freezing the clock: `now` is always passed in.

export type ScheduleUrgency = "none" | "soon" | "due";

/** How long before the instant the chip turns amber. "A few minutes" as the card
 *  asked — long enough to look up and do something, short enough that a card
 *  scheduled for tomorrow is not shouting all day. */
export const SOON_WINDOW_MS = 10 * 60_000;

export function scheduleUrgency(
  at: string | null | undefined,
  now: number,
  opts?: { enabled?: boolean | null; soonWindowMs?: number }
): ScheduleUrgency {
  if (!at) return "none";
  // A PAUSED recurring schedule has an instant but no intent to fire it. It is
  // never urgent — that is what pausing meant.
  if (opts?.enabled === false) return "none";
  const t = Date.parse(at);
  // Unparseable counts as DUE, deliberately: a broken instant surfaces as the
  // loudest state rather than hiding behind a quiet chip. (This is the rule the
  // two-state `scheduleDue` already had; it survives the third state.)
  if (!Number.isFinite(t)) return "due";
  if (t <= now) return "due";
  const window = opts?.soonWindowMs ?? SOON_WINDOW_MS;
  return t - now <= window ? "soon" : "none";
}

/** The minimum a card front needs for its two schedule instants. */
export interface ScheduledCardLike {
  scheduledFor?: string | null;
  schedule?: {
    nextAt?: string | null;
    enabled?: boolean | null;
    dueOffsetMinutes?: number | null;
  } | null;
}

/** The RELEASE instant — when the card stops being held and lands on its list. */
export function releaseInstant(card: ScheduledCardLike): string | null {
  return card.schedule?.nextAt ?? card.scheduledFor ?? null;
}

/** The DEADLINE instant — release plus the card's deadline offset. Mirrors
 *  `scheduleDueAt` in lib/schedules.mjs; with no offset the two instants are the
 *  same value, so a card that predates the split reads exactly as before. */
export function dueInstant(card: ScheduledCardLike): string | null {
  const release = releaseInstant(card);
  if (!release) return null;
  const offset = card.schedule?.dueOffsetMinutes;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset <= 0) return release;
  const t = Date.parse(release);
  if (!Number.isFinite(t)) return release; // an unparseable instant stays visible
  return new Date(t + offset * 60_000).toISOString();
}

/** True when the card carries a deadline distinct from its release instant —
 *  the case where the front paints TWO chips instead of one. */
export function hasSplitDeadline(card: ScheduledCardLike): boolean {
  const offset = card.schedule?.dueOffsetMinutes;
  return typeof offset === "number" && Number.isInteger(offset) && offset > 0 && !!releaseInstant(card);
}

/** The editors let a person pick a due DATE; the schedule stores an OFFSET from
 *  the release instant. This is the conversion, and it is deliberately strict:
 *  a due time at or before the release instant is no deadline at all (0), and an
 *  unparseable pair never invents one. */
export function dueOffsetFromInstants(releaseIso: string | null, dueIso: string | null): number {
  if (!releaseIso || !dueIso) return 0;
  const release = Date.parse(releaseIso);
  const due = Date.parse(dueIso);
  if (!Number.isFinite(release) || !Number.isFinite(due)) return 0;
  const minutes = Math.round((due - release) / 60_000);
  return minutes > 0 ? minutes : 0;
}

/** The class suffix the chip wears. "" for a quiet schedule, so the existing
 *  `chip sched` styling is untouched when nothing is imminent. */
export function urgencyClass(urgency: ScheduleUrgency): string {
  return urgency === "none" ? "" : ` ${urgency}`;
}

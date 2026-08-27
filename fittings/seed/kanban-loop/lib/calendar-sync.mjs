// Two-way Google Calendar sync for scheduled cards.
//
// THE MODEL — one card, at most one Calendar event.
//
// A recurring card does NOT export an RRULE. Garrison's recurrence rules do not
// map losslessly onto RRULE, and a partial translation is worse than none: the
// calendar would then show a series that is quietly wrong. Instead the card owns
// exactly ONE event which is MOVED to wherever its next occurrence is. The
// calendar always tells the truth about the next occurrence and never lies about
// the ones after it.
//
// CONFLICTS — last write wins, by timestamp. `schedule.updatedAt` is the local
// stamp, Calendar's own `updated` is the remote one. The `calendar` receipt on
// the schedule records what we last pushed (`signature`) and the remote stamp we
// last agreed with (`remoteUpdated`), which is what lets this distinguish "the
// remote changed" from "the remote is exactly what we put there".
//
// WHAT PULLS BACK, AND WHAT DOES NOT:
//   - A remote DELETE (or a cancelled event) disables the card's schedule. That
//     is an unambiguous human intent and it applies to every schedule kind.
//   - A remote MOVE applies to a `once` schedule: the release instant becomes
//     the event's new start, and the deadline offset follows its duration.
//   - A remote MOVE on a RECURRING card is refused and re-pushed. The card's
//     next occurrence is computed from its rule, so accepting the move would
//     last exactly until the next sweep recomputed it. Overwriting silently is
//     the failure mode; the refusal is recorded on the card so it is visible.
//
// The gate is the CONNECTION, not a config flag: with Google not connected the
// auth resolution returns awaiting_connector and every sweep is a no-op. The
// card asked for exactly that — "when the google workspace is connected".

import path from "node:path";
import { scheduleNextAt, scheduleDueAt, scheduleSyncSignature } from "./schedules.mjs";
import { loadAllCards, updateCardCAS, withFileLock } from "./board.mjs";
import { withEvent } from "./engine.mjs";

// A zero-length calendar event is not a thing. A card with no deadline offset
// (due == release) gets a nominal block so it shows up as an appointment rather
// than a point.
export const DEFAULT_EVENT_MINUTES = 30;

// Stamped into every event this sync owns. The pull side lists ONLY events
// carrying this marker, so a hand-made event in the same calendar is never
// touched, and `garrisonCardId` maps an event back to its card.
export const OWNER_PROPERTY = "garrisonKanban";
export const OWNER_VALUE = "1";
export const CARD_PROPERTY = "garrisonCardId";

/** The window a card should occupy in the calendar, or null when it should not
 *  appear at all. */
export function cardEventWindow(card) {
  const release = scheduleNextAt(card);
  if (!release) return null;
  const start = Date.parse(release);
  if (!Number.isFinite(start)) return null;
  const dueIso = scheduleDueAt(card);
  const due = Date.parse(dueIso ?? release);
  const end = Number.isFinite(due) && due > start ? due : start + DEFAULT_EVENT_MINUTES * 60000;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** Should this card have a calendar event right now? A card whose schedule is
 *  paused, spent, or which has landed somewhere terminal, should not. */
export function cardShouldSync(card, { terminalLists = new Set(["done", "archived"]) } = {}) {
  if (!card || card.schedule?.enabled === false) return false;
  if (terminalLists.has(card.list)) return false;
  return Boolean(cardEventWindow(card));
}

export function cardSignature(card) {
  const window = cardEventWindow(card);
  return scheduleSyncSignature({
    title: card?.title ?? "",
    releaseAt: window?.start ?? "",
    dueAt: window?.end ?? ""
  });
}

/** What the push side owes the calendar for one card: create, update, delete or
 *  nothing. Pure — the caller performs it. */
export function pushIntent(card, options = {}) {
  const link = card?.schedule?.calendar ?? null;
  const wanted = cardShouldSync(card, options);
  if (!wanted) {
    // An event exists for a card that should no longer have one. Deleting is
    // right for a paused/spent/terminal card: leaving a stale block on someone's
    // calendar is a lie about their day.
    return link ? { action: "delete", eventId: link.eventId, calendarId: link.calendarId } : { action: "none" };
  }
  const window = cardEventWindow(card);
  const signature = cardSignature(card);
  if (!link) return { action: "create", window, signature };
  if (link.signature === signature) return { action: "none" };
  return { action: "update", eventId: link.eventId, calendarId: link.calendarId, window, signature };
}

/** The body of the event a card describes. */
export function eventArgsForCard(card, { calendarId = "primary", boardUrl = null } = {}) {
  const window = cardEventWindow(card);
  if (!window) return null;
  const lines = [];
  if (card.description) lines.push(String(card.description).slice(0, 2000));
  if (boardUrl) lines.push(`${boardUrl.replace(/\/$/, "")}/#card=${card.id}`);
  lines.push("— scheduled by Garrison. Moving or deleting this event changes the card.");
  return {
    calendar_id: calendarId,
    summary: card.title || "(untitled card)",
    description: lines.join("\n\n"),
    start: window.start,
    end: window.end,
    private_properties: { [OWNER_PROPERTY]: OWNER_VALUE, [CARD_PROPERTY]: card.id }
  };
}

// ── the pull side ──────────────────────────────────────────────────────────

export function eventCardId(event) {
  const value = event?.extendedProperties?.private?.[CARD_PROPERTY];
  return typeof value === "string" && value ? value : null;
}

/**
 * Does this sync own the event? Checked LOCALLY, on the event body, even though
 * the listing already filters by the same marker at the API.
 *
 * That redundancy is the point. The only irreversible thing this code does is
 * delete an event, and the reaper deletes on the strength of "no card claims
 * it" — so if a query parameter were ever dropped, mistyped, or ignored by the
 * API, an unfiltered listing would mean deleting every event in someone's
 * calendar. One `if` is a cheap price for that not being possible.
 */
export function eventIsOurs(event) {
  return event?.extendedProperties?.private?.[OWNER_PROPERTY] === OWNER_VALUE && Boolean(eventCardId(event));
}

/**
 * Last-write-wins. Returns what the remote event means for this card:
 *   "unchanged" — the remote is exactly what we last agreed with.
 *   "cancelled" — the human deleted it in Calendar.
 *   "remote"    — the human moved it and their edit is newer than ours.
 *   "local"     — our edit is newer; the remote loses and gets re-pushed.
 */
export function resolveConflict(card, event) {
  if (!event) return "unchanged";
  if (event.status === "cancelled") return "cancelled";
  const link = card?.schedule?.calendar ?? null;
  const remote = Date.parse(event.updated ?? "");
  if (!Number.isFinite(remote)) return "unchanged";
  // Nothing has happened in Calendar since our own write landed.
  if (link?.remoteUpdated && Date.parse(link.remoteUpdated) >= remote) return "unchanged";
  const remoteWindow = {
    start: event.start?.dateTime ?? null,
    end: event.end?.dateTime ?? null
  };
  const ours = cardEventWindow(card);
  // A remote `updated` bump that did not actually move the event (Calendar
  // touches events for reasons of its own — a reminder change, a colour) is not
  // a conflict. Only a genuine time difference is.
  if (ours && remoteWindow.start && remoteWindow.end
    && Date.parse(remoteWindow.start) === Date.parse(ours.start)
    && Date.parse(remoteWindow.end) === Date.parse(ours.end)) return "unchanged";
  const local = Date.parse(card?.schedule?.updatedAt ?? "");
  if (Number.isFinite(local) && local > remote) return "local";
  return "remote";
}

/**
 * Apply a remote move, returning the card's new schedule (or null when the move
 * cannot be represented). Only a `once` schedule can absorb one — see the header
 * note on recurring cards.
 *
 * Takes the whole CARD, not just the schedule, because the sync receipt it
 * writes has to record the signature of the resulting card — including its
 * title. A receipt written from the schedule alone could never match what the
 * push side computes, so every following sweep would fire a pointless update.
 */
export function applyRemoteMove(card, event, { now = new Date().toISOString() } = {}) {
  const schedule = card?.schedule;
  if (!schedule || schedule.kind !== "once") return null;
  const startMs = Date.parse(event?.start?.dateTime ?? "");
  if (!Number.isFinite(startMs)) return null;
  const endMs = Date.parse(event?.end?.dateTime ?? "");
  // The event's duration IS the deadline offset. A nominal-length event means
  // the card never had a split deadline, so it keeps not having one.
  const durationMinutes = Number.isFinite(endMs) && endMs > startMs
    ? Math.round((endMs - startMs) / 60000)
    : 0;
  const dueOffsetMinutes = durationMinutes === DEFAULT_EVENT_MINUTES ? 0 : durationMinutes;
  const at = new Date(startMs).toISOString();
  const next = { ...schedule, at, nextAt: at, updatedAt: now };
  if (dueOffsetMinutes > 0) next.dueOffsetMinutes = dueOffsetMinutes;
  else delete next.dueOffsetMinutes;
  next.calendar = {
    ...schedule.calendar,
    remoteUpdated: typeof event.updated === "string" ? event.updated : schedule.calendar?.remoteUpdated,
    signature: cardSignature({ ...card, schedule: next }),
    syncedAt: now
  };
  return next;
}

/** A remote deletion disables the schedule rather than deleting the card. The
 *  card is work; the event was only its shadow. */
export function applyRemoteCancel(schedule, { now = new Date().toISOString() } = {}) {
  if (!schedule) return null;
  const next = { ...schedule, enabled: false, updatedAt: now };
  delete next.calendar;
  return next;
}

// ── the driver ─────────────────────────────────────────────────────────────

/**
 * One full sync beat. `call(action, args)` performs a Google connector action
 * and returns the connector's `{ ok, result, awaiting_connector }` envelope; the
 * caller supplies it (see connectorCaller below) so this is testable without a
 * network, a vault, or a child process.
 *
 * Pull runs BEFORE push, so a human's edit in Calendar is read before anything
 * here has a chance to overwrite it.
 */
export async function syncCalendarOnce({
  cards,
  call,
  saveSchedule,
  calendarId = "primary",
  boardUrl = null,
  terminalLists = new Set(["done", "archived"]),
  now = () => new Date().toISOString(),
  log = () => {}
}) {
  const stamp = now();
  const report = { pushed: 0, updated: 0, deleted: 0, pulled: 0, cancelled: 0, refused: 0, errors: [] };
  const byId = new Map(cards.map((card) => [card.id, card]));
  const fail = (cardId, error) => {
    report.errors.push({ cardId, error: error instanceof Error ? error.message : String(error) });
  };

  // ── PULL ────────────────────────────────────────────────────────────────
  // Only events this sync owns are listed, so a hand-made event sharing the
  // calendar is never read, moved or deleted.
  //
  // The listing runs EVERY beat, even with no linked card, because it is also
  // the only way an orphan is ever reaped. A card can lose its link between two
  // beats — its schedule is cleared, or the card itself is deleted — and there
  // is then nothing left on this side pointing at the event. Without this pass
  // that event would sit on someone's calendar forever.
  const linked = cards.filter((card) => card.schedule?.calendar?.eventId);
  {
    // The FULL owned listing, across pages. Completeness is load-bearing: two
    // paths below act on ABSENCE — the orphan reap deletes an event no card
    // claims, and a linked card whose event is missing is treated as remotely
    // cancelled. Acting on absence from a TRUNCATED listing would delete real
    // events and pause real schedules, so an incomplete listing (a failed page,
    // or more pages than the cap) skips the whole pull pass for this beat.
    const items = [];
    let listingComplete = false;
    let pageToken = null;
    let listedOnce = null;
    for (let page = 0; page < 20; page += 1) {
      const listed = await call("calendar.list_events", {
        calendar_id: calendarId,
        private_extended_property: [`${OWNER_PROPERTY}=${OWNER_VALUE}`],
        show_deleted: true,
        max: 250,
        ...(pageToken ? { page_token: pageToken } : {})
      });
      listedOnce = listed;
      if (listed.awaiting_connector) return { ...report, skipped: "not-connected" };
      if (!listed.ok) break;
      items.push(...(listed.result?.items ?? []));
      pageToken = listed.result?.nextPageToken ?? null;
      if (!pageToken) {
        listingComplete = true;
        break;
      }
    }
    if (!listingComplete) fail(null, listedOnce?.error ?? "calendar.list_events incomplete — pull pass skipped this beat");
    else {
      const events = new Map();
      const owning = new Set(linked.map((card) => card.schedule.calendar.eventId));
      for (const event of items) {
        // Anything this sync does not own is invisible to it — not read, not
        // moved, and above all not deleted.
        if (!eventIsOurs(event)) continue;
        const cardId = eventCardId(event);
        events.set(cardId, event);
        if (event.status === "cancelled" || owning.has(event.id)) continue;
        // An owned event no card claims: its card was deleted, or its schedule
        // was cleared. Either way the work it stood for is gone.
        try {
          const res = await call("calendar.delete_event", { calendar_id: calendarId, event_id: event.id });
          if (res.ok) report.deleted += 1;
          else fail(cardId, res.error ?? "orphan calendar.delete_event failed");
        } catch (error) {
          fail(cardId, error);
        }
      }
      for (const card of linked) {
        const event = events.get(card.id);
        // An event that vanished from the listing entirely is the same intent as
        // a cancelled one: it is no longer on the calendar.
        const verdict = event ? resolveConflict(card, event) : "cancelled";
        if (verdict === "unchanged" || verdict === "local") continue;
        try {
          if (verdict === "cancelled") {
            await saveSchedule(card.id, applyRemoteCancel(card.schedule, { now: stamp }), {
              kind: "calendar-sync",
              message: "Schedule paused — its Google Calendar event was deleted"
            }, { baseline: card.schedule?.updatedAt ?? null });
            report.cancelled += 1;
            continue;
          }
          // verdict === "remote"
          const moved = applyRemoteMove(card, event, { now: stamp });
          if (!moved) {
            // A recurring card's next occurrence comes from its rule. Accepting
            // the move would survive exactly until the next recompute, so it is
            // refused out loud and the push pass puts the event back.
            await saveSchedule(card.id, {
              ...card.schedule,
              calendar: { ...card.schedule.calendar, signature: "", remoteUpdated: event.updated ?? null }
            }, {
              kind: "calendar-sync",
              message: "Ignored a Google Calendar move — a recurring card's time comes from its rule; the event was put back"
            }, { applyCalendarOnly: true });
            report.refused += 1;
            continue;
          }
          await saveSchedule(card.id, moved, {
            kind: "calendar-sync",
            message: `Rescheduled from Google Calendar to ${moved.nextAt}`
          }, { baseline: card.schedule?.updatedAt ?? null });
          byId.set(card.id, { ...card, schedule: moved });
          report.pulled += 1;
        } catch (error) {
          fail(card.id, error);
        }
      }
    }
  }

  // ── PUSH ────────────────────────────────────────────────────────────────
  for (const card of byId.values()) {
    let intent;
    try { intent = pushIntent(card, { terminalLists }); }
    catch (error) { fail(card.id, error); continue; }
    if (intent.action === "none") continue;
    try {
      if (intent.action === "delete") {
        const res = await call("calendar.delete_event", { calendar_id: intent.calendarId, event_id: intent.eventId });
        if (res.awaiting_connector) return { ...report, skipped: "not-connected" };
        if (!res.ok) { fail(card.id, res.error ?? "calendar.delete_event failed"); continue; }
        const next = { ...card.schedule };
        delete next.calendar;
        await saveSchedule(card.id, next, null, { applyCalendarOnly: true });
        report.deleted += 1;
        continue;
      }
      const args = eventArgsForCard(card, { calendarId: intent.calendarId ?? calendarId, boardUrl });
      if (!args) continue;
      const res = intent.action === "create"
        ? await call("calendar.create_event", args)
        : await call("calendar.update_event", { ...args, calendar_id: intent.calendarId, event_id: intent.eventId });
      if (res.awaiting_connector) return { ...report, skipped: "not-connected" };
      if (!res.ok) {
        // A vanished event is not an error on update — the card simply needs a
        // new one, which the next sweep creates once the link is dropped.
        if (intent.action === "update" && /\b(404|410)\b/.test(String(res.error ?? ""))) {
          const next = { ...card.schedule };
          delete next.calendar;
          await saveSchedule(card.id, next, null, { applyCalendarOnly: true });
          continue;
        }
        fail(card.id, res.error ?? `calendar.${intent.action}_event failed`);
        continue;
      }
      const event = res.result ?? {};
      await saveSchedule(card.id, {
        ...card.schedule,
        calendar: {
          eventId: event.id ?? intent.eventId,
          calendarId: intent.calendarId ?? calendarId,
          signature: intent.signature,
          syncedAt: stamp,
          remoteUpdated: typeof event.updated === "string" ? event.updated : null
        }
      }, intent.action === "create"
        ? { kind: "calendar-sync", message: "Added to Google Calendar" }
        : null, { applyCalendarOnly: true });
      if (intent.action === "create") report.pushed += 1;
      else report.updated += 1;
    } catch (error) {
      fail(card.id, error);
    }
  }
  if (report.errors.length) log(`kanban-loop: calendar sync had ${report.errors.length} error(s)`);
  return report;
}

/**
 * The real `call` — a Google connector action with a Vault-scoped access token.
 *
 * The auth resolution and the connector child both come from the automations
 * fitting's leaf module, imported dynamically by its sibling path. Dynamic
 * because that fitting being absent must mean "calendar sync is unavailable",
 * not "the kanban board fails to load".
 */
export async function connectorCaller() {
  let invoke;
  try {
    invoke = await import("../../automations/lib/connector-invoke.mjs");
  } catch {
    return null; // the automations fitting is not installed — no sync, no error
  }
  let authEnv;
  try {
    authEnv = await invoke.defaultConnectorAuthEnv("google");
  } catch {
    return null; // the backend is down; the next beat tries again
  }
  if (authEnv.__awaiting_connector) return null; // Google is not connected
  const scriptPath = invoke.connectorScriptPath("google");
  return async (action, args) => invoke.defaultRunConnector({ scriptPath, action, args, authEnv });
}

/**
 * Board-bound entry point — what the tick calls.
 *
 * Every schedule write takes the schedule-sweep lock, but the NETWORK calls
 * deliberately happen outside it. Holding the lock that the due-sweep needs
 * across a round trip to Google would let one slow API call stall the clock
 * that releases cards onto To Do.
 */
export async function syncCalendar(root, {
  call = null,
  terminalLists = new Set(["done", "archived"]),
  calendarId = process.env.KANBAN_CALENDAR_ID || "primary",
  boardUrl = process.env.KANBAN_BOARD_URL || null,
  now = () => new Date().toISOString(),
  log = () => {}
} = {}) {
  if (process.env.GARRISON_KANBAN_CALENDAR_SYNC === "off") return { skipped: "disabled" };
  const invoke = call ?? (await connectorCaller());
  if (!invoke) return { skipped: "not-connected" };
  const cards = await loadAllCards(root);
  const saveSchedule = async (cardId, schedule, event, opts = {}) =>
    withFileLock(path.join(root, ".schedule-sweep.lock"), "schedule sweep", () =>
      updateCardCAS(root, cardId, (current) => {
        if (!current.schedule) return null;
        let nextSchedule;
        if (opts.applyCalendarOnly) {
          // RECEIPT writes: the network call already happened, so the link must
          // land on whatever the schedule looks like NOW. Writing the snapshot
          // schedule wholesale here used to revert any human edit that landed
          // during the Google round trip.
          nextSchedule = { ...current.schedule };
          if (schedule?.calendar) nextSchedule.calendar = schedule.calendar;
          else delete nextSchedule.calendar;
        } else {
          // TIME/STATE writes computed from the beat-start snapshot: a schedule
          // the human edited while the round trip was in flight WINS — this
          // write is skipped and the next beat recomputes against live state.
          // (The comment used to claim this and the code did the opposite: the
          // only guard was !current.schedule.)
          if ((current.schedule.updatedAt ?? null) !== (opts.baseline ?? null)) return null;
          nextSchedule = schedule;
        }
        const next = { ...current, schedule: nextSchedule };
        if (event) next.events = withEvent(current, { at: now(), ...event });
        return next;
      }));
  return syncCalendarOnce({ cards, call: invoke, saveSchedule, calendarId, boardUrl, terminalLists, now, log });
}

// Two-way Google Calendar sync for scheduled cards (checklist item 6).
//
// What these pin, in order of how much damage getting them wrong would do:
//   1. A hand-made event in the same calendar is NEVER touched.
//   2. An orphaned event — its card deleted or its schedule cleared — is reaped.
//   3. Last-write-wins actually compares both stamps, and a remote `updated`
//      bump that did not move the event is not a conflict.
//   4. A recurring card refuses a remote move instead of accepting one that the
//      next recompute would silently undo.
//   5. Google is not connected → every path is a no-op, never an error.
import { describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { cardEventWindow, cardShouldSync, cardSignature, pushIntent, eventArgsForCard, eventCardId, eventIsOurs, resolveConflict, applyRemoteMove, applyRemoteCancel, syncCalendarOnce, DEFAULT_EVENT_MINUTES, OWNER_PROPERTY, OWNER_VALUE, CARD_PROPERTY } from "../fittings/seed/kanban-loop/lib/calendar-sync.mjs";
// @ts-ignore — pure .mjs
import { normaliseCardSchedule, scheduleValidationError } from "../fittings/seed/kanban-loop/lib/schedules.mjs";

const RELEASE = "2026-05-04T09:00:00.000Z";
const NOW = "2026-05-01T00:00:00.000Z";

const card = (over: any = {}) => ({
  id: "CARD1",
  title: "Ship the thing",
  list: "scheduled",
  schedule: { kind: "once", enabled: true, at: RELEASE, nextAt: RELEASE, timezone: "Europe/Lisbon", action: "notify" },
  ...over
});

const ownedEvent = (over: any = {}) => ({
  id: "ev1",
  status: "confirmed",
  updated: "2026-05-02T00:00:00.000Z",
  start: { dateTime: RELEASE },
  end: { dateTime: "2026-05-04T09:30:00.000Z" },
  extendedProperties: { private: { [OWNER_PROPERTY]: OWNER_VALUE, [CARD_PROPERTY]: "CARD1" } },
  ...over
});

describe("the window a card occupies", () => {
  it("spans release → due when the card has a split deadline", () => {
    const c = card({ schedule: { kind: "once", enabled: true, nextAt: RELEASE, dueOffsetMinutes: 480 } });
    expect(cardEventWindow(c)).toEqual({ start: RELEASE, end: "2026-05-04T17:00:00.000Z" });
  });

  it("gets a nominal block rather than zero length when due == release", () => {
    const w = cardEventWindow(card());
    expect(w.start).toBe(RELEASE);
    expect(Date.parse(w.end) - Date.parse(w.start)).toBe(DEFAULT_EVENT_MINUTES * 60000);
  });

  it("is null for a card with no schedule at all", () => {
    expect(cardEventWindow(card({ schedule: null }))).toBeNull();
  });
});

describe("which cards belong on the calendar", () => {
  it("a live scheduled card does", () => {
    expect(cardShouldSync(card())).toBe(true);
  });

  it("a PAUSED schedule does not — a stale block is a lie about your day", () => {
    expect(cardShouldSync(card({ schedule: { kind: "once", enabled: false, nextAt: RELEASE } }))).toBe(false);
  });

  it("a spent recurring schedule (no next occurrence) does not", () => {
    expect(cardShouldSync(card({ schedule: { kind: "cron", enabled: true, nextAt: null } }))).toBe(false);
  });

  it("a card that landed on a terminal list does not", () => {
    expect(cardShouldSync(card({ list: "done" }))).toBe(false);
    expect(cardShouldSync(card({ list: "archived" }))).toBe(false);
  });
});

describe("push intent", () => {
  it("creates when there is no link yet", () => {
    expect(pushIntent(card()).action).toBe("create");
  });

  it("does nothing when the pushed signature still matches", () => {
    const c = card();
    const linked = card({ schedule: { ...c.schedule, calendar: { eventId: "ev1", calendarId: "primary", signature: cardSignature(c) } } });
    expect(pushIntent(linked).action).toBe("none");
  });

  it("updates when the TITLE changed, not only when the time did", () => {
    // The signature covers every field that is pushed, so renaming a card moves
    // its calendar entry too. A time-only diff would have missed this.
    const c = card();
    const sig = cardSignature(c);
    const renamed = card({ title: "Ship something else", schedule: { ...c.schedule, calendar: { eventId: "ev1", calendarId: "primary", signature: sig } } });
    expect(pushIntent(renamed).action).toBe("update");
  });

  it("deletes a linked event once the card stops qualifying", () => {
    const c = card({ list: "done", schedule: { kind: "once", enabled: true, nextAt: RELEASE, calendar: { eventId: "ev1", calendarId: "primary", signature: "x" } } });
    expect(pushIntent(c)).toMatchObject({ action: "delete", eventId: "ev1" });
  });

  it("does nothing for an unscheduled card that never had an event", () => {
    expect(pushIntent(card({ schedule: null })).action).toBe("none");
  });
});

describe("the event body", () => {
  it("stamps the ownership marker and the card id", () => {
    const args = eventArgsForCard(card(), { calendarId: "primary" });
    expect(args.private_properties).toEqual({ [OWNER_PROPERTY]: OWNER_VALUE, [CARD_PROPERTY]: "CARD1" });
    expect(args.summary).toBe("Ship the thing");
  });

  it("round-trips the card id back out of an event", () => {
    expect(eventCardId(ownedEvent())).toBe("CARD1");
    expect(eventCardId({ id: "someone-elses" })).toBeNull();
  });

  it("ownership is asserted on the event body, not trusted from the API filter", () => {
    // The reaper deletes on the strength of "no card claims this". If a dropped
    // query parameter ever returned an unfiltered listing, this local check is
    // the only thing between that and wiping someone's calendar.
    expect(eventIsOurs(ownedEvent())).toBe(true);
    expect(eventIsOurs({ id: "lunch" })).toBe(false);
    expect(eventIsOurs({ id: "x", extendedProperties: { private: { [CARD_PROPERTY]: "CARD1" } } })).toBe(false);
    expect(eventIsOurs({ id: "x", extendedProperties: { private: { [OWNER_PROPERTY]: OWNER_VALUE } } })).toBe(false);
  });
});

describe("last-write-wins", () => {
  const linkedCard = (over: any = {}, sched: any = {}) => card({
    schedule: {
      kind: "once", enabled: true, at: RELEASE, nextAt: RELEASE, timezone: "Europe/Lisbon",
      calendar: { eventId: "ev1", calendarId: "primary", signature: "", remoteUpdated: "2026-05-01T00:00:00.000Z" },
      ...sched
    },
    ...over
  });

  it("is unchanged when the remote stamp is the one we last agreed with", () => {
    const c = linkedCard({}, { calendar: { eventId: "ev1", calendarId: "primary", signature: "", remoteUpdated: "2026-05-02T00:00:00.000Z" } });
    expect(resolveConflict(c, ownedEvent())).toBe("unchanged");
  });

  it("is unchanged when the remote bumped `updated` WITHOUT moving the event", () => {
    // Calendar touches events for its own reasons (a reminder, a colour). Only a
    // real time difference is a conflict; treating every bump as one would
    // reschedule cards at random.
    const c = linkedCard();
    expect(resolveConflict(c, ownedEvent({ updated: "2026-05-03T00:00:00.000Z" }))).toBe("unchanged");
  });

  it("the REMOTE wins when the human moved the event more recently", () => {
    const c = linkedCard({}, { updatedAt: "2026-05-01T12:00:00.000Z" });
    const moved = ownedEvent({ updated: "2026-05-02T12:00:00.000Z", start: { dateTime: "2026-05-05T09:00:00.000Z" }, end: { dateTime: "2026-05-05T09:30:00.000Z" } });
    expect(resolveConflict(c, moved)).toBe("remote");
  });

  it("the LOCAL edit wins when it is the newer one", () => {
    const c = linkedCard({}, { updatedAt: "2026-05-03T12:00:00.000Z" });
    const moved = ownedEvent({ updated: "2026-05-02T12:00:00.000Z", start: { dateTime: "2026-05-05T09:00:00.000Z" }, end: { dateTime: "2026-05-05T09:30:00.000Z" } });
    expect(resolveConflict(c, moved)).toBe("local");
  });

  it("a cancelled event is a deletion regardless of stamps", () => {
    expect(resolveConflict(linkedCard(), ownedEvent({ status: "cancelled" }))).toBe("cancelled");
  });
});

describe("applying a remote change", () => {
  it("moves a once-schedule and derives the deadline offset from the duration", () => {
    const c = card({ schedule: { kind: "once", enabled: true, at: RELEASE, nextAt: RELEASE, calendar: { eventId: "ev1" } } });
    const moved = applyRemoteMove(c, ownedEvent({
      updated: "2026-05-02T12:00:00.000Z",
      start: { dateTime: "2026-05-06T10:00:00.000Z" },
      end: { dateTime: "2026-05-06T18:00:00.000Z" }
    }), { now: NOW });
    expect(moved.nextAt).toBe("2026-05-06T10:00:00.000Z");
    expect(moved.at).toBe("2026-05-06T10:00:00.000Z");
    expect(moved.dueOffsetMinutes).toBe(480);
    expect(moved.updatedAt).toBe(NOW);
  });

  it("keeps a card deadline-less when the event is only the nominal block", () => {
    const c = card({ schedule: { kind: "once", enabled: true, nextAt: RELEASE, calendar: { eventId: "ev1" } } });
    const moved = applyRemoteMove(c, ownedEvent({ start: { dateTime: "2026-05-06T10:00:00.000Z" }, end: { dateTime: "2026-05-06T10:30:00.000Z" } }), { now: NOW });
    expect(moved.dueOffsetMinutes).toBeUndefined();
  });

  it("writes a receipt whose signature MATCHES what push would compute", () => {
    // Otherwise every sweep after a pull would fire a pointless update.
    const c = card({ schedule: { kind: "once", enabled: true, nextAt: RELEASE, calendar: { eventId: "ev1", calendarId: "primary", signature: "stale" } } });
    const moved = applyRemoteMove(c, ownedEvent({ start: { dateTime: "2026-05-06T10:00:00.000Z" }, end: { dateTime: "2026-05-06T18:00:00.000Z" } }), { now: NOW });
    expect(pushIntent({ ...c, schedule: moved }).action).toBe("none");
  });

  it("REFUSES a move on a recurring card — its time comes from the rule", () => {
    const c = card({ schedule: { kind: "cron", cron: "0 9 * * 1", enabled: true, nextAt: RELEASE, calendar: { eventId: "ev1" } } });
    expect(applyRemoteMove(c, ownedEvent(), { now: NOW })).toBeNull();
  });

  it("a remote deletion PAUSES the schedule, it does not delete the card", () => {
    const next = applyRemoteCancel(card().schedule, { now: NOW });
    expect(next.enabled).toBe(false);
    expect(next.calendar).toBeUndefined();
    expect(next.nextAt).toBe(RELEASE); // the time is remembered, just not armed
  });
});

// ── the driver, against a fake connector ───────────────────────────────────

function harness(cards: any[], items: any[] = [], overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  const saved: any[] = [];
  const call = async (action: string, args: any) => {
    calls.push({ action, args });
    if (overrides[action]) return overrides[action](args);
    if (action === "calendar.list_events") return { ok: true, result: { items } };
    if (action === "calendar.create_event") return { ok: true, result: { id: "new-ev", updated: "2026-05-02T00:00:00.000Z" } };
    if (action === "calendar.update_event") return { ok: true, result: { id: args.event_id, updated: "2026-05-02T00:00:00.000Z" } };
    if (action === "calendar.delete_event") return { ok: true, result: { deleted: true } };
    return { ok: false, error: `unexpected ${action}` };
  };
  const saveSchedule = async (cardId: string, schedule: any, event: any) => { saved.push({ cardId, schedule, event }); };
  return { calls, saved, run: (extra: any = {}) => syncCalendarOnce({ cards, call, saveSchedule, now: () => NOW, ...extra }) };
}

describe("the sync beat", () => {
  it("creates an event for a newly scheduled card and records the link", async () => {
    const h = harness([card()]);
    const report = await h.run();
    expect(report.pushed).toBe(1);
    expect(h.calls.some((c) => c.action === "calendar.create_event")).toBe(true);
    expect(h.saved[0].schedule.calendar).toMatchObject({ eventId: "new-ev", calendarId: "primary" });
    expect(h.saved[0].schedule.calendar.signature).toBe(cardSignature(card()));
  });

  it("NEVER touches an event it does not own", async () => {
    // The listing is already ownership-filtered at the API, but an event with no
    // garrisonCardId reaching this code must still be left completely alone.
    const foreign = { id: "someone-elses-lunch", status: "confirmed", updated: "2026-05-02T00:00:00.000Z" };
    const h = harness([], [foreign]);
    const report = await h.run();
    expect(h.calls.filter((c) => c.action === "calendar.delete_event")).toHaveLength(0);
    expect(report.deleted).toBe(0);
  });

  it("passes the ownership filter to the listing so foreign events are never even read", async () => {
    const h = harness([card()]);
    await h.run();
    const listed = h.calls.find((c) => c.action === "calendar.list_events");
    expect(listed.args.private_extended_property).toEqual([`${OWNER_PROPERTY}=${OWNER_VALUE}`]);
  });

  it("REAPS an orphan whose card was deleted between beats", async () => {
    // No card claims ev1 any more. Nothing on this side points at it, so this
    // pass is the only thing that can ever remove it.
    const h = harness([], [ownedEvent()]);
    const report = await h.run();
    expect(report.deleted).toBe(1);
    expect(h.calls.find((c) => c.action === "calendar.delete_event").args.event_id).toBe("ev1");
  });

  it("reaps an orphan whose card had its schedule cleared", async () => {
    const h = harness([card({ schedule: null })], [ownedEvent()]);
    expect((await h.run()).deleted).toBe(1);
  });

  it("does NOT reap an event a card still claims", async () => {
    const c = card({ schedule: { kind: "once", enabled: true, nextAt: RELEASE, calendar: { eventId: "ev1", calendarId: "primary", signature: "", remoteUpdated: "2026-05-02T00:00:00.000Z" } } });
    const h = harness([c], [ownedEvent()]);
    const report = await h.run();
    expect(report.deleted).toBe(0);
  });

  it("pulls a remote move back onto a once-card", async () => {
    const c = card({ schedule: { kind: "once", enabled: true, at: RELEASE, nextAt: RELEASE, updatedAt: "2026-05-01T00:00:00.000Z", calendar: { eventId: "ev1", calendarId: "primary", signature: "", remoteUpdated: "2026-05-01T00:00:00.000Z" } } });
    const moved = ownedEvent({ updated: "2026-05-02T12:00:00.000Z", start: { dateTime: "2026-05-07T14:00:00.000Z" }, end: { dateTime: "2026-05-07T14:30:00.000Z" } });
    const h = harness([c], [moved]);
    const report = await h.run();
    expect(report.pulled).toBe(1);
    expect(h.saved[0].schedule.nextAt).toBe("2026-05-07T14:00:00.000Z");
    expect(h.saved[0].event.kind).toBe("calendar-sync");
  });

  it("does not re-push a card it just pulled", async () => {
    // The pulled schedule feeds the push pass, so its receipt has to already
    // agree with it — a pull followed by an update would be a write loop.
    const c = card({ schedule: { kind: "once", enabled: true, at: RELEASE, nextAt: RELEASE, updatedAt: "2026-05-01T00:00:00.000Z", calendar: { eventId: "ev1", calendarId: "primary", signature: "", remoteUpdated: "2026-05-01T00:00:00.000Z" } } });
    const moved = ownedEvent({ updated: "2026-05-02T12:00:00.000Z", start: { dateTime: "2026-05-07T14:00:00.000Z" }, end: { dateTime: "2026-05-07T14:30:00.000Z" } });
    const h = harness([c], [moved]);
    await h.run();
    expect(h.calls.filter((call) => call.action === "calendar.update_event")).toHaveLength(0);
  });

  it("pauses a card whose event was deleted in Calendar", async () => {
    const c = card({ schedule: { kind: "once", enabled: true, nextAt: RELEASE, calendar: { eventId: "ev1", calendarId: "primary", signature: "", remoteUpdated: "2026-05-01T00:00:00.000Z" } } });
    const h = harness([c], [ownedEvent({ status: "cancelled" })]);
    const report = await h.run();
    expect(report.cancelled).toBe(1);
    expect(h.saved[0].schedule.enabled).toBe(false);
  });

  it("treats an event that vanished from the listing as a deletion too", async () => {
    const c = card({ schedule: { kind: "once", enabled: true, nextAt: RELEASE, calendar: { eventId: "ev1", calendarId: "primary", signature: "", remoteUpdated: "2026-05-01T00:00:00.000Z" } } });
    const h = harness([c], []);
    expect((await h.run()).cancelled).toBe(1);
  });

  it("refuses a remote move on a recurring card and puts the event back", async () => {
    const c = card({
      schedule: {
        kind: "cron", cron: "0 9 * * 1", enabled: true, nextAt: RELEASE, timezone: "Europe/Lisbon",
        calendar: { eventId: "ev1", calendarId: "primary", signature: "matching", remoteUpdated: "2026-05-01T00:00:00.000Z" }
      }
    });
    const moved = ownedEvent({ updated: "2026-05-02T12:00:00.000Z", start: { dateTime: "2026-05-09T14:00:00.000Z" }, end: { dateTime: "2026-05-09T14:30:00.000Z" } });
    const h = harness([c], [moved]);
    const report = await h.run();
    expect(report.refused).toBe(1);
    // The refusal blanks the signature, which is what makes the push pass put
    // the correct time back rather than leaving the human's move standing.
    expect(h.saved[0].schedule.calendar.signature).toBe("");
    expect(h.saved[0].event.message).toMatch(/recurring/i);
  });

  it("drops the link when an update finds the event gone, so the next beat recreates it", async () => {
    const c = card({ schedule: { kind: "once", enabled: true, nextAt: RELEASE, calendar: { eventId: "ev1", calendarId: "primary", signature: "stale", remoteUpdated: "2026-05-02T00:00:00.000Z" } } });
    const h = harness([c], [ownedEvent()], {
      "calendar.update_event": async () => ({ ok: false, error: "google 404: Not Found" })
    });
    await h.run();
    expect(h.saved.at(-1).schedule.calendar).toBeUndefined();
  });

  it("reports a failure instead of losing it", async () => {
    const h = harness([card()], [], {
      "calendar.create_event": async () => ({ ok: false, error: "google 500: backend error" })
    });
    const report = await h.run();
    expect(report.pushed).toBe(0);
    expect(report.errors[0]).toMatchObject({ cardId: "CARD1" });
  });

  it("stops cleanly the moment Google turns out not to be connected", async () => {
    const h = harness([card()], [], {
      "calendar.list_events": async () => ({ ok: false, awaiting_connector: true })
    });
    const report = await h.run();
    expect(report.skipped).toBe("not-connected");
    expect(h.saved).toHaveLength(0);
  });
});

describe("the schedule fields that carry the sync", () => {
  it("round-trips updatedAt and the calendar link through the normaliser", () => {
    const s = normaliseCardSchedule({
      kind: "once", at: RELEASE, targetList: "todo", timezone: "Europe/Lisbon",
      updatedAt: NOW,
      calendar: { eventId: "ev1", calendarId: "primary", signature: "sig", syncedAt: NOW, remoteUpdated: NOW }
    });
    expect(s.updatedAt).toBe(NOW);
    expect(s.calendar).toMatchObject({ eventId: "ev1", calendarId: "primary", signature: "sig" });
  });

  it("drops a calendar link with no event id rather than persisting a half one", () => {
    const s = normaliseCardSchedule({ kind: "once", at: RELEASE, targetList: "todo", calendar: { calendarId: "primary" } });
    expect(s.calendar).toBeUndefined();
  });

  it("rejects an unparseable updatedAt at the validator", () => {
    expect(scheduleValidationError({ kind: "once", at: RELEASE, targetList: "todo", updatedAt: "whenever" }))
      .toMatch(/updatedAt/);
  });

  it("leaves a schedule with neither field exactly as it was", () => {
    const s = normaliseCardSchedule({ kind: "once", at: RELEASE, targetList: "todo" });
    expect(s.updatedAt).toBeUndefined();
    expect(s.calendar).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { api } from "../fittings/seed/kanban-loop/ui/api";

afterEach(() => vi.unstubAllGlobals());

describe("Kanban Scheduled UI", () => {
  it("calls the explicit Run now occurrence route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      card: { id: "01OCCURRENCE" }, occurrence: true, created: true
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.runScheduleNow("CARD/ONE");
    expect(fetchMock).toHaveBeenCalledWith("/cards/CARD%2FONE/run-now", expect.objectContaining({ method: "POST" }));
  });

  it("exposes schedule target-list selectors on both create and detail editors", () => {
    const source = readFileSync(new URL("../fittings/seed/kanban-loop/ui/main.tsx", import.meta.url), "utf8");
    expect(source.match(/aria-label="Schedule target list"/g)).toHaveLength(2);
    expect(source.match(/filter\(\(list\) => list\.kind === "manual" && !list\.terminal\)/g)).toHaveLength(2);
    expect(source).toContain("targetList: scheduleTarget");
    expect(source).toContain("targetList: schedTargetDraft || scheduleTarget(card)");
  });

  it("keeps Scheduled fixed and routes raw placement through schedule controls", () => {
    const source = readFileSync(new URL("../fittings/seed/kanban-loop/ui/main.tsx", import.meta.url), "utf8");
    expect(source).toContain('disabled: list.id === "scheduled"');
    expect(source).toContain('disabled: listId === "scheduled"');
    expect(source).toContain('if (a.id === "scheduled") return -1;');
    expect(source).toContain("!list.system");
    expect(source).toContain("No scheduled tasks");
  });

  it("renders recurrence controls and Morning delivery receipts", () => {
    const source = readFileSync(new URL("../fittings/seed/kanban-loop/ui/main.tsx", import.meta.url), "utf8");
    for (const label of ["Daily 08:00", "Weekdays 08:00", "Mondays 09:00", "Pause", "Resume", "Run now"]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("legacy cutover pending");
    expect(source).toContain("card.schedule.cutoverPending === true");
    expect(source).toContain('aria-label="Morning briefing delivery status"');
    expect(source).toContain("Web: {card.morningBriefDelivery.web?.status");
    expect(source).toContain("Omi: {card.morningBriefDelivery.omi?.status");
  });

  it("makes template and occurrence provenance navigable card links", () => {
    const source = readFileSync(new URL("../fittings/seed/kanban-loop/ui/main.tsx", import.meta.url), "utf8");
    // The `?card=` reader moved into the pure ui/card-location module (which also
    // learned the `#/cards/<id>` shape every OTHER producer emits); the board's
    // own provenance links still resolve through it.
    expect(source).toContain("const cardId = cardIdFromLocation(window.location);");
    expect(source).toContain('href={scheduleCardHref(card.scheduleTemplateId)}');
    expect(source).toContain('candidate.scheduleTemplateId === detail.card.id');
    expect(source).toContain('href={scheduleCardHref(occurrence.id)}');
    expect(source).toContain('onOpenCard={(cardId) => setOverlay({ kind: "detail", cardId })}');
  });
});

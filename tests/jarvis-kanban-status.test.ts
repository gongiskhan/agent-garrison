import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { deriveStatusLine, timeAgo, rankAndCapCards } from "../fittings/seed/jarvis-os/scripts/kanban-status.mjs";

const NOW = Date.parse("2026-07-06T12:00:00Z");

describe("deriveStatusLine", () => {
  it("running: shows iteration + elapsed + last live-tail line", () => {
    const card = {
      status: "running",
      iterations: 3,
      runningSince: "2026-07-06T11:58:00Z", // 2m ago
      liveTail: ["…", "a compilar o bundle"]
    };
    expect(deriveStatusLine(card, "Implement", NOW)).toBe("A correr — iteração 3 (há 2m) — a compilar o bundle");
  });

  it("running: omits the tail/elapsed when absent", () => {
    expect(deriveStatusLine({ status: "running", iterations: 0 }, "Plan", NOW)).toBe("A correr — iteração 0");
  });

  it("needs-attention: prefers attentionReason, falls back to lastEvent then em-dash", () => {
    expect(deriveStatusLine({ status: "needs-attention", attentionReason: "iteration cap (10)" }, "X", NOW))
      .toBe("Precisa de atenção: iteration cap (10)");
    expect(deriveStatusLine({ status: "needs-attention", lastEvent: { message: "Parked from Plan" } }, "X", NOW))
      .toBe("Precisa de atenção: Parked from Plan");
    expect(deriveStatusLine({ status: "needs-attention" }, "X", NOW)).toBe("Precisa de atenção: —");
  });

  it("dispatch error takes precedence over the plain list line", () => {
    expect(deriveStatusLine({ status: "ok", lastDispatchError: { message: "gateway not reachable" } }, "To Do", NOW))
      .toBe("Falhou o dispatch: gateway not reachable");
  });

  it("idle: list title + last event, or just the list title", () => {
    expect(deriveStatusLine({ status: "ok", lastEvent: { message: "Inferred the project: foo" } }, "Backlog", NOW))
      .toBe("Backlog · Inferred the project: foo");
    expect(deriveStatusLine({ status: "ok" }, "Backlog", NOW)).toBe("Backlog");
  });
});

describe("rankAndCapCards", () => {
  const c = (id: string, status: string, updated: string) => ({ id, status, updated });
  it("orders running → needs-attention → rest, newest-updated first within a group", () => {
    const cards = [
      c("old-ok", "ok", "2026-07-06T10:00:00Z"),
      c("new-ok", "ok", "2026-07-06T11:00:00Z"),
      c("att", "needs-attention", "2026-07-06T09:00:00Z"),
      c("run1", "running", "2026-07-06T08:00:00Z"),
      c("run2", "running", "2026-07-06T12:00:00Z")
    ];
    expect(rankAndCapCards(cards).map((x: { id: string }) => x.id)).toEqual(["run2", "run1", "att", "new-ok", "old-ok"]);
  });
  it("caps to the limit and does not mutate the input", () => {
    const cards = Array.from({ length: 12 }, (_, i) => c(`k${i}`, "ok", `2026-07-06T${String(i).padStart(2, "0")}:00:00Z`));
    const out = rankAndCapCards(cards, 8);
    expect(out).toHaveLength(8);
    expect(out[0].id).toBe("k11"); // newest first
    expect(cards).toHaveLength(12); // input untouched
  });
});

describe("timeAgo", () => {
  it("formats seconds / minutes / hours and rejects bad input", () => {
    expect(timeAgo("2026-07-06T11:59:30Z", NOW)).toBe("30s");
    expect(timeAgo("2026-07-06T11:45:00Z", NOW)).toBe("15m");
    expect(timeAgo("2026-07-06T09:00:00Z", NOW)).toBe("3h");
    expect(timeAgo(null, NOW)).toBeNull();
    expect(timeAgo("not-a-date", NOW)).toBeNull();
  });
});

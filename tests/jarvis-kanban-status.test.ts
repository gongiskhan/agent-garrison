import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { deriveStatusLine, timeAgo } from "../fittings/seed/jarvis-os/scripts/kanban-status.mjs";

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

describe("timeAgo", () => {
  it("formats seconds / minutes / hours and rejects bad input", () => {
    expect(timeAgo("2026-07-06T11:59:30Z", NOW)).toBe("30s");
    expect(timeAgo("2026-07-06T11:45:00Z", NOW)).toBe("15m");
    expect(timeAgo("2026-07-06T09:00:00Z", NOW)).toBe("3h");
    expect(timeAgo(null, NOW)).toBeNull();
    expect(timeAgo("not-a-date", NOW)).toBeNull();
  });
});

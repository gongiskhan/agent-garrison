import { describe, expect, it } from "vitest";
import { faculties } from "@/lib/faculties";

describe("faculty definitions", () => {
  it("renders the 6 role Faculties in order", () => {
    expect(faculties.map((faculty) => faculty.id)).toEqual([
      "orchestrator",
      "channels",
      "gateway",
      "memory",
      "observability",
      "sessions"
    ]);
  });

  it("keeps Tasks out of the selectable Faculty set", () => {
    expect(faculties.map((faculty) => faculty.id)).not.toContain("tasks");
  });

  it("drops the config-projection faculties (now platform primitives in Quarters)", () => {
    const ids = faculties.map((f) => f.id);
    for (const gone of ["skills", "heartbeat", "scheduler", "classifier", "soul"]) {
      expect(ids).not.toContain(gone);
    }
  });

  it("memory is a multi role that accepts the cli shape (trello-data-source rejoined it)", () => {
    const memory = faculties.find((f) => f.id === "memory");
    expect(memory?.cardinality).toBe("multi");
    expect(memory?.shapes).toContain("cli");
  });
});

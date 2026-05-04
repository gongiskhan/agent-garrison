import { describe, expect, it } from "vitest";
import { faculties } from "@/lib/faculties";

describe("faculty definitions", () => {
  it("renders the 13 explicit Faculties in spec order", () => {
    expect(faculties.map((faculty) => faculty.id)).toEqual([
      "heartbeat",
      "scheduler",
      "data-sources",
      "knowledge-base",
      "automations",
      "testing-framework",
      "memory",
      "classifier",
      "gateway",
      "channels",
      "observability",
      "soul",
      "orchestrator"
    ]);
  });

  it("keeps Tasks out of the selectable Faculty set", () => {
    expect(faculties.map((faculty) => faculty.id)).not.toContain("tasks");
  });
});

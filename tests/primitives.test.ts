import { describe, expect, it } from "vitest";
import { primitives } from "@/lib/primitives";

describe("primitive definitions", () => {
  it("renders the 13 explicit primitives in spec order", () => {
    expect(primitives.map((primitive) => primitive.id)).toEqual([
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

  it("keeps Tasks out of the selectable primitive set", () => {
    expect(primitives.map((primitive) => primitive.id)).not.toContain("tasks");
  });
});

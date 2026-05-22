import { describe, expect, it } from "vitest";
import { faculties } from "@/lib/faculties";

describe("faculty definitions", () => {
  it("renders the 22 Faculties in spec order", () => {
    expect(faculties.map((faculty) => faculty.id)).toEqual([
      "heartbeat",
      "scheduler",
      "data-sources",
      "knowledge-base",
      "automations",
      "skills",
      "memory",
      "classifier",
      "gateway",
      "channels",
      "observability",
      "soul",
      "orchestrator",
      "artifact-store",
      "terminal",
      "screen-share",
      "worktree-management",
      "session-view",
      "outposts",
      "sync",
      "monitor",
      "web-channel"
    ]);
  });

  it("keeps Tasks out of the selectable Faculty set", () => {
    expect(faculties.map((faculty) => faculty.id)).not.toContain("tasks");
  });
});

// Where a NEW session lands in the sessions rail.
//
// The rail persists a section's whole visible order on every drop, so one drag
// makes every conversation that existed "placed". A newly started session is in
// nobody's manual order - and with the naive rule (placed first, the rest
// after) it landed BELOW eighty older rows, which is the one place a session
// you just opened must never be. Found live on 2026-08-26 with a real
// 80-key order.

import { describe, expect, it } from "vitest";
import { orderSectionRows } from "../packages/talk/ui/sessions-rail";

const row = (key: string, activity: string | null) => ({ key, activity });

describe("rail section order", () => {
  it("puts a brand-new session above a long manual order", () => {
    const members = [
      row("local:old-a", "2026-08-20T10:00:00Z"),
      row("local:old-b", "2026-08-21T10:00:00Z"),
      row("local:fresh", "2026-08-26T16:00:00Z")
    ];
    const out = orderSectionRows(members, ["local:old-a", "local:old-b"]);
    expect(out.map((r) => r.key)).toEqual(["local:fresh", "local:old-a", "local:old-b"]);
  });

  it("keeps the dragged order exactly, including against recency", () => {
    // The whole point of dragging: the user's sequence wins over the clock.
    const members = [
      row("local:a", "2026-08-01T00:00:00Z"),
      row("local:b", "2026-08-26T00:00:00Z"),
      row("local:c", "2026-08-10T00:00:00Z")
    ];
    const out = orderSectionRows(members, ["local:c", "local:a", "local:b"]);
    expect(out.map((r) => r.key)).toEqual(["local:c", "local:a", "local:b"]);
  });

  it("sorts the unplaced ones by recency, newest first", () => {
    const members = [
      row("local:mid", "2026-08-20T00:00:00Z"),
      row("local:new", "2026-08-26T00:00:00Z"),
      row("local:oldest", null)
    ];
    expect(orderSectionRows(members, []).map((r) => r.key)).toEqual([
      "local:new",
      "local:mid",
      "local:oldest"
    ]);
  });

  it("ignores keys whose row is gone and never drops a member", () => {
    // A deleted conversation leaves its key behind in the stored order; a
    // filter that trusted the key list would render undefined, and one that
    // trusted its length would lose a row.
    const members = [row("local:a", "2026-08-01T00:00:00Z"), row("local:b", "2026-08-02T00:00:00Z")];
    const out = orderSectionRows(members, ["local:deleted", "local:b"]);
    expect(out.map((r) => r.key)).toEqual(["local:a", "local:b"]);
  });

  it("never renders a row twice when the order names it twice", () => {
    // Two rows sharing a React key misbehave in ways that read as a drag bug.
    const members = [row("local:a", null), row("local:b", null)];
    const out = orderSectionRows(members, ["local:a", "local:a"]);
    expect(out.filter((r) => r.key === "local:a")).toHaveLength(1);
    expect(out).toHaveLength(2);
  });
});

import { describe, it, expect } from "vitest";
import { buildSessionRequest, MODE_OPTIONS, DEFAULT_MODE } from "../fittings/seed/dev-env/ui/session-request";

// GARRISON-UNIFY-V1 S7 (D22): the orchestrated path is the DEFAULT; the one
// escape hatch is the explicit, labeled PLAIN option (plain:true, logged
// server-side).
describe("dev-env session request (S7/D22)", () => {
  it("defaults to Joe; offers gary/joe/james + the labeled plain escape hatch", () => {
    expect(DEFAULT_MODE).toBe("joe");
    const vals = MODE_OPTIONS.map((m) => m.value);
    expect(vals).toEqual(expect.arrayContaining(["gary", "joe", "james", "plain"]));
    const plain = MODE_OPTIONS.find((m) => m.value === "plain")!;
    expect(plain.label.toLowerCase()).toContain("plain claude");
    expect(plain.label.toLowerCase()).toContain("debugging garrison");
  });

  it("a mode starts THROUGH the orchestrator (orchestrated is the default — no flag needed)", () => {
    expect(buildSessionRequest({ path: "/x", mode: "joe" })).toEqual({ path: "/x", mode: "joe" });
    expect(buildSessionRequest({ path: "/x", mode: "james" })).toEqual({ path: "/x", mode: "james" });
    // no mode at all → still orchestrated (server resolves the channel default)
    expect(buildSessionRequest({ path: "/x", mode: null })).toEqual({ path: "/x" });
  });

  it("the plain escape hatch sends plain:true (and 'off' maps to it for back-compat)", () => {
    expect(buildSessionRequest({ path: "/x", mode: "plain" })).toEqual({ path: "/x", plain: true });
    expect(buildSessionRequest({ path: "/x", mode: "off" })).toEqual({ path: "/x", plain: true });
  });

  it("resume is the legacy --continue path and never goes orchestrated", () => {
    expect(buildSessionRequest({ path: "/x", resume: true, mode: "joe" })).toEqual({ path: "/x", continue: true });
  });

  it("trims the path", () => {
    expect(buildSessionRequest({ path: "  /x/y  ", mode: "plain" })).toEqual({ path: "/x/y", plain: true });
  });
});

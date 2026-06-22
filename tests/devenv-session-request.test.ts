import { describe, it, expect } from "vitest";
import { buildSessionRequest, MODE_OPTIONS, DEFAULT_MODE } from "../fittings/seed/dev-env/ui/session-request";

describe("dev-env session request (s3c)", () => {
  it("defaults to Joe; offers gary/joe/james + a bare 'off' option", () => {
    expect(DEFAULT_MODE).toBe("joe");
    const vals = MODE_OPTIONS.map((m) => m.value);
    expect(vals).toEqual(expect.arrayContaining(["gary", "joe", "james", "off"]));
  });

  it("a real mode starts THROUGH the orchestrator (orchestrated:true + mode)", () => {
    expect(buildSessionRequest({ path: "/x", mode: "joe" })).toEqual({ path: "/x", orchestrated: true, mode: "joe" });
    expect(buildSessionRequest({ path: "/x", mode: "james" })).toEqual({ path: "/x", orchestrated: true, mode: "james" });
  });

  it("'off' or null → a bare session (no orchestrated/mode)", () => {
    expect(buildSessionRequest({ path: "/x", mode: "off" })).toEqual({ path: "/x" });
    expect(buildSessionRequest({ path: "/x", mode: null })).toEqual({ path: "/x" });
  });

  it("resume is the legacy --continue path and never goes orchestrated", () => {
    expect(buildSessionRequest({ path: "/x", resume: true, mode: "joe" })).toEqual({ path: "/x", continue: true });
  });

  it("trims the path", () => {
    expect(buildSessionRequest({ path: "  /x/y  ", mode: "off" })).toEqual({ path: "/x/y" });
  });
});

import { describe, expect, it } from "vitest";
import { slugify, buildAutomationKickoff, buildAutomationDiscussUrl } from "../fittings/seed/automations/lib/discuss.mjs";

// H1 — chat-to-build authoring (reuses the Kanban Discuss -> web-channel handoff).

describe("discuss-automation handoff (H1)", () => {
  it("slugifies a name into a brief slug", () => {
    expect(slugify("Weekly Report Email!")).toBe("weekly-report-email");
    expect(slugify("")).toBe("automation");
  });

  it("kickoff opens in James mode and points at the brief path", () => {
    const k = buildAutomationKickoff({ name: "Weekly Report" });
    expect(k.startsWith("James,")).toBe(true); // gateway reads mode from the leading "James,"
    expect(k).toContain("~/.garrison/automations/briefs/weekly-report.md");
    expect(k).toContain("What would you like to automate?");
  });

  it("discuss URL targets the web-channel embed in james mode with base64 context+kickoff", () => {
    const url = buildAutomationDiscussUrl({ name: "Weekly Report" });
    expect(url.startsWith("/embed/web-channel-default?")).toBe(true);
    expect(url).toContain("mode=james");
    const params = new URLSearchParams(url.split("?")[1]);
    // context decodes to JSON describing the automations source
    const ctx = JSON.parse(Buffer.from(decodeURIComponent(params.get("context")!), "base64").toString("utf8"));
    expect(ctx.source).toBe("automations");
    expect(ctx.suggestedSlug).toBe("weekly-report");
    // kickoff decodes to the James message
    const kickoff = Buffer.from(decodeURIComponent(params.get("kickoff")!), "base64").toString("utf8");
    expect(kickoff.startsWith("James,")).toBe(true);
  });
});

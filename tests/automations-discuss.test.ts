import { describe, expect, it } from "vitest";
import { slugify, buildAutomationKickoff, buildAutomationDiscussUrl, buildDiscussParams } from "../fittings/seed/automations/lib/discuss.mjs";

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

  it("buildDiscussParams yields james mode + base64 context/kickoff for the postMessage navigate path", () => {
    const p = buildDiscussParams({ name: "Weekly Report" });
    expect(p.mode).toBe("james");
    const ctx = JSON.parse(Buffer.from(p.context, "base64").toString("utf8"));
    expect(ctx.source).toBe("automations");
    expect(ctx.suggestedSlug).toBe("weekly-report");
    expect(Buffer.from(p.kickoff, "base64").toString("utf8").startsWith("James,")).toBe(true);
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

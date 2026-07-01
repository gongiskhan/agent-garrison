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

  it("proportional effort + short replies, ALWAYS asks ≥1 question, never writes the brief on the first turn", () => {
    const k = buildAutomationKickoff({ name: "Weekly Report" }).toLowerCase();
    expect(k).toContain("match your effort");
    expect(k).toContain("short and direct");
    expect(k).toContain("proportional");
    expect(k).toContain("at least one");
    expect(k).toMatch(/do not write the brief|don't write the brief/);
    expect(k).not.toContain("think it through out loud");
  });

  it("buildDiscussParams yields james mode + base64 context/kickoff for the postMessage navigate path", () => {
    const p = buildDiscussParams({ name: "Weekly Report" });
    expect(p.mode).toBe("james");
    const ctx = JSON.parse(Buffer.from(p.context, "base64").toString("utf8"));
    expect(ctx.source).toBe("automations");
    expect(ctx.suggestedSlug).toBe("weekly-report");
    expect(Buffer.from(p.kickoff, "base64").toString("utf8").startsWith("James,")).toBe(true);
    // A STABLE per-automation thread key + title so reopening Discuss returns to
    // the same session; both base64 like context/kickoff.
    expect(Buffer.from(p.thread, "base64").toString("utf8")).toBe("automation-weekly-report");
    expect(Buffer.from(p.title!, "base64").toString("utf8")).toBe("Weekly Report");
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

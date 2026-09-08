import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { slugify, freshAutomationSlug, buildAutomationKickoff, buildAutomationDiscussUrl, buildDiscussParams } from "../fittings/seed/automations/lib/discuss.mjs";

// H1 - chat-to-build authoring (reuses the Kanban Discuss handoff, aimed at the
// shell-hosted Conversations route).

describe("discuss-automation handoff (H1)", () => {
  it("slugifies a name into a brief slug", () => {
    expect(slugify("Weekly Report Email!")).toBe("weekly-report-email");
    expect(slugify("")).toBe("automation");
  });

  it("kickoff is persona-free and points at the brief path", () => {
    const k = buildAutomationKickoff({ name: "Weekly Report" });
    expect(k).toMatch(/^Let's design an automation together/);
    // The path follows GARRISON_HOME when set (the suite pins it to a temp dir
    // so nothing resolves the real home); the literal ~ form is the fallback.
    expect(k).toContain(`${process.env.GARRISON_HOME ?? "~/.garrison"}/automations/briefs/weekly-report.md`.replace("//", "/"));
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

  it("buildDiscussParams yields a Discuss-duty source + base64 context/kickoff", () => {
    const p = buildDiscussParams({ name: "Weekly Report" });
    expect(p.source).toBe("discuss");
    const ctx = JSON.parse(Buffer.from(p.context, "base64").toString("utf8"));
    expect(ctx.source).toBe("automations");
    expect(ctx.suggestedSlug).toBe("weekly-report");
    expect(Buffer.from(p.kickoff, "base64").toString("utf8")).toMatch(/^Let's design/);
    // A STABLE per-automation thread key + title so reopening Discuss returns to
    // the same session; both base64 like context/kickoff.
    expect(Buffer.from(p.thread, "base64").toString("utf8")).toBe("automation-weekly-report");
    expect(Buffer.from(p.title!, "base64").toString("utf8")).toBe("Weekly Report");
  });

  // Regression: the "+ Discuss an automation" button carries NO name. It used to
  // collide every click onto the single thread `automation-automation` (+ brief
  // `automation.md`), so reopening Discuss always landed on the previous, possibly
  // failed, conversation. A new automation must mint a fresh unique slug per click.
  it("freshAutomationSlug mints a distinct, filesystem-safe slug each call", () => {
    const a = freshAutomationSlug();
    const b = freshAutomationSlug();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9-]+$/); // safe as a thread key + brief filename stem
  });

  it("a nameless new-automation Discuss gets a UNIQUE thread + brief per open (no shared 'automation-automation')", () => {
    // Mirrors the /api/automations/discuss-url endpoint: no name -> fresh slug.
    const open1 = buildDiscussParams({ slug: freshAutomationSlug() });
    const open2 = buildDiscussParams({ slug: freshAutomationSlug() });
    const thread1 = Buffer.from(open1.thread, "base64").toString("utf8");
    const thread2 = Buffer.from(open2.thread, "base64").toString("utf8");
    expect(thread1).not.toBe(thread2);
    expect(thread1).not.toBe("automation-automation");
    const brief1 = JSON.parse(Buffer.from(open1.context, "base64").toString("utf8")).briefAbsPath;
    const brief2 = JSON.parse(Buffer.from(open2.context, "base64").toString("utf8")).briefAbsPath;
    expect(brief1).not.toBe(brief2);
    expect(brief1).not.toContain("/automation.md");
  });

  it("discuss URL targets a duty-pinned Conversations thread with base64 context+kickoff", () => {
    const url = buildAutomationDiscussUrl({ name: "Weekly Report" });
    // The talk engine lives in the shell at /talk; an own-port channel embed is
    // not a Discuss destination.
    expect(url.startsWith("/talk?")).toBe(true);
    expect(url).toContain("source=discuss");
    const params = new URLSearchParams(url.split("?")[1]);
    // context decodes to JSON describing the automations source
    const ctx = JSON.parse(Buffer.from(decodeURIComponent(params.get("context")!), "base64").toString("utf8"));
    expect(ctx.source).toBe("automations");
    expect(ctx.suggestedSlug).toBe("weekly-report");
    // kickoff is persona-free; the host thread pins duty=discuss, level=1.
    const kickoff = Buffer.from(decodeURIComponent(params.get("kickoff")!), "base64").toString("utf8");
    expect(kickoff).toMatch(/^Let's design/);
  });

  // Conversations is a shell route, so the embedded UI cannot navigate there itself
  // (a relative URL resolves against the automations own-port origin). It asks the
  // shell over postMessage with the route contract, and the shell only honours
  // routes it allow-lists. The three sides of that contract are pinned together so
  // one cannot move without the others.
  describe("Discuss opens the shell-hosted Conversations route", () => {
    const seed = (rel: string) => readFileSync(new URL(`../fittings/seed/automations/${rel}`, import.meta.url), "utf8");

    it("the server returns route + params, never a channel id, a 409, or a guessed port", () => {
      const server = seed("scripts/server.mjs");
      const handler = server.slice(server.indexOf('"/api/automations/discuss-url"'), server.indexOf('"/api/automations/plan-from-brief"'));
      expect(handler).toContain('route: "/talk"');
      expect(handler).toContain("GARRISON_APP_URL");
      // The standalone page needs the path on its own to build the tailnet form.
      expect(handler).toContain("const path = `/talk?${qs}`;");
      expect(handler).not.toMatch(/127\.0\.0\.1:\d+/);
      expect(handler).not.toContain("409");
      expect(server).not.toContain("readWebChannelStatus");
    });

    it("the UI posts garrison:navigate-route to the top window and resolves the standalone target by page host", () => {
      const html = seed("dist/index.html");
      expect(html).toContain('window.top.postMessage({ type: "garrison:navigate-route", route: r.route, params: r.params }, "*")');
      // The server's `url` is the loopback app address: right only when the page
      // itself is on loopback. Anywhere else the app is at the page host's
      // tailnet root, and handing the browser the loopback URL would be
      // unreachable and mixed content.
      expect(html).toContain('if (!here || here === "127.0.0.1" || here === "localhost") return r.url || "";');
      expect(html).toContain("return r.path ? `https://${here}${r.path}` : \"\";");
      expect(html).not.toContain("window.location.href = r.url");
      expect(html).not.toContain("garrison:navigate-fitting");
      expect(html).not.toContain("r.fittingId");
    });

    it("the shell embed page honours the route message only for allow-listed shell routes", () => {
      const page = readFileSync(new URL("../src/app/embed/[fittingId]/page.tsx", import.meta.url), "utf8");
      expect(page).toContain('data.type === "garrison:navigate-route"');
      expect(page).toContain('new Set(["/talk"])');
      expect(page).toContain("EMBED_SHELL_ROUTES.has(data.route)");
      // The fitting contract stays as it was.
      expect(page).toContain('data.type !== "garrison:navigate-fitting"');
    });
  });
});

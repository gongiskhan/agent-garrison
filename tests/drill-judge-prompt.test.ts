import { describe, expect, it } from "vitest";
import { buildVisionPrompt } from "../src/app/api/automations/vision/prompt";

// Q3/B12 — the Model Router prompt for Drill's judge mode (drillJudge()) and
// the richer-assertion-kind hints added to verify mode (delta 5 graduation).

describe("buildVisionPrompt — verify mode", () => {
  it("lists all 5 assertion kinds and includes a known area anchor when present", () => {
    const prompt = buildVisionPrompt(
      "verify",
      { url: "https://x/chat", title: "Chat", headingText: "Chat", a11y: [{ role: "button", name: "Send" }] },
      { description: "composer is visible", areaHint: { testId: "chat-composer" } },
      "/tmp/vision-check.jpg"
    );
    for (const kind of ["text-contains", "visible", "count", "url-matches", "attribute-equals"]) {
      expect(prompt).toContain(kind);
    }
    expect(prompt).toContain('{"testId":"chat-composer"}');
    expect(prompt).toContain("MUST use the Read tool");
    expect(prompt).toContain("/tmp/vision-check.jpg");
    expect(prompt).toContain("Reply ONLY valid single-line JSON");
  });

  it("omits the anchor line when no areaHint is present", () => {
    const prompt = buildVisionPrompt("verify", { url: "https://x", title: "T", headingText: "H", a11y: [] }, { description: "no console errors" });
    expect(prompt).not.toContain("Known anchor");
  });
});

describe("buildVisionPrompt — judge mode (Q3, drillJudge())", () => {
  it("asks a qualitative question and prefers bodyText over the a11y tree when present", () => {
    const prompt = buildVisionPrompt("judge", { url: "https://x/chat", title: "Chat", bodyText: "Citation [1] points to CT art. 269." },
      { description: "Do citation markers match their source rows in order?" });
    expect(prompt).toContain("QUALITATIVE judgment");
    expect(prompt).toContain("Do citation markers match their source rows in order?");
    expect(prompt).toContain("Citation [1] points to CT art. 269.");
    expect(prompt).toContain('"passed": true|false');
    expect(prompt).not.toContain("assertion"); // judge mode never asks for a deterministic assertion
  });

  it("falls back to the a11y tree when bodyText is absent", () => {
    const prompt = buildVisionPrompt("judge", { url: "https://x", title: "T", a11y: [{ role: "article", name: "Answer" }] }, { description: "is the answer well-formed?" });
    expect(prompt).toContain("Accessible elements");
    expect(prompt).toContain("article: Answer");
  });
});

describe("buildVisionPrompt — action mode (unchanged)", () => {
  it("asks for a single Playwright action", () => {
    const prompt = buildVisionPrompt("action", { url: "https://x", title: "T", headingText: "H", a11y: [{ role: "button", name: "Send" }] }, { description: "click send" });
    expect(prompt).toContain("single Playwright action");
    expect(prompt).toContain("button: Send");
  });
});

describe("buildVisionPrompt - size bounds (oversized-page hardening)", () => {
  it("clips a megabyte-scale a11y node name so the prompt stays inside the gateway envelope", () => {
    const hugeName = "cell ".repeat(400_000); // ~2MB - a table region node's accessible name
    const prompt = buildVisionPrompt("verify",
      { url: "https://x/usage", title: "Usage", headingText: "Utilização", a11y: [{ role: "region", name: hugeName }, { role: "button", name: "Reset" }] },
      { description: "table renders" });
    expect(prompt.length).toBeLessThan(210_000);
    expect(prompt).toContain("[...clipped");
    expect(prompt).toContain("button: Reset"); // later nodes survive the clipping
  });

  it("caps the whole prompt with an explicit marker when everything together is still too large", () => {
    const nodes = Array.from({ length: 80 }, (_, i) => ({ role: "row", name: `${"x".repeat(5000)} ${i}` }));
    const prompt = buildVisionPrompt("action", { url: "https://x", title: "T", headingText: "H", a11y: nodes }, { description: "click" });
    expect(prompt.length).toBeLessThanOrEqual(200_000 + 200);
  });

  it("bounds fixer JSON blobs (failed step + error text)", () => {
    const prompt = buildVisionPrompt("fix",
      { url: "https://x", title: "T", headingText: "H", a11y: [] },
      { description: "d".repeat(50_000), __fix: { failureKind: "timeout", error: "e".repeat(50_000) } });
    expect(prompt.length).toBeLessThan(30_000);
    expect(prompt).toContain("[...clipped");
  });
});

describe("buildVisionPrompt — fix mode", () => {
  it("asks for a bounded plan patch instead of a browser action", () => {
    const prompt = buildVisionPrompt(
      "fix",
      {
        url: "https://x/not-found",
        title: "Not found",
        a11y: [{ role: "link", name: "Go home" }]
      },
      {
        id: "s1",
        type: "verify",
        description: "Clicking Go home reaches the dashboard",
        __fix: { failureKind: "verify_failed", error: "outcome not met" }
      },
      "/tmp/failure.jpg"
    );
    expect(prompt).toContain("PLAN PATCH");
    expect(prompt).toContain("insert_before");
    expect(prompt).toContain("replace_current");
    expect(prompt).toContain("pause_for_user");
    expect(prompt).toContain("browser, verify, navigate, or wait");
    expect(prompt).toContain("outcome not met");
    expect(prompt).toContain("MUST use the Read tool");
    expect(prompt).not.toContain('"kind":"click|fill');
  });
});

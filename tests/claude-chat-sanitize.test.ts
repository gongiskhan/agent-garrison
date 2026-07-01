import { describe, it, expect } from "vitest";
import { sanitizeAssistantText, routeChipLabel } from "../packages/claude-chat/src/sanitize";

describe("claude-chat: sanitizeAssistantText", () => {
  it("lifts the trailing [route: …] badge into meta and removes it from the prose", () => {
    const raw = [
      "Good idea — I'll make that change.",
      "",
      "[route: cc-sonnet-med | rule: row:research | profile: balanced]",
      "[orchestrator-active]",
    ].join("\n");
    const r = sanitizeAssistantText(raw);
    expect(r.text).toBe("Good idea — I'll make that change.");
    expect(r.hadBadges).toBe(true);
    expect(r.meta.route).toBe("cc-sonnet-med");
    expect(r.meta.rule).toBe("row:research");
    expect(r.meta.profile).toBe("balanced");
    expect(r.text).not.toContain("[route:");
    expect(r.text).not.toContain("orchestrator-active");
  });

  it("strips tool-activity progress lines (the 'Searching for N patterns…' counter)", () => {
    const raw = [
      "Searching for 12 patterns, reading 2 files, running 1 shell command…",
      "Searching for 13 patterns, reading 2 files, running 1 shell command…",
      "Here is what I found: the phrase lives in index.html.",
    ].join("\n");
    const r = sanitizeAssistantText(raw);
    expect(r.text).toBe("Here is what I found: the phrase lives in index.html.");
    expect(r.text).not.toContain("Searching for");
    expect(r.text).not.toContain("shell command");
  });

  it("strips a COMBINED thinking+activity progress line ('Thinking for 27s, searching for …')", () => {
    const raw = [
      "Thinking for 27s, searching for 16 patterns, reading 2 files, listing 2 directories, running 1 shell command…",
      "Good, now I have the full picture.",
    ].join("\n");
    const r = sanitizeAssistantText(raw);
    expect(r.text).toBe("Good, now I have the full picture.");
    expect(r.text).not.toContain("Thinking for 27s");
  });

  it("strips the thinking summary + the ⎿ tree block", () => {
    const raw = [
      "Thinking for 6s…",
      "⎿  The user answered tersely. Let me write a concise brief.",
      "Brief written to briefs/x.md. Ready for build.",
    ].join("\n");
    const r = sanitizeAssistantText(raw);
    expect(r.text).toBe("Brief written to briefs/x.md. Ready for build.");
    expect(r.text).not.toContain("Thinking for");
    expect(r.text).not.toContain("The user answered");
  });

  it("never touches legitimate prose (links, footnotes, ellipses, a 'Thinking about' sentence)", () => {
    const raw = [
      "Thinking about it more, the cleaner option wins.",
      "See the [docs](https://example.com) for details [1].",
      "It trails off here…",
      "We run 3 checks and then ship.",
    ].join("\n");
    const r = sanitizeAssistantText(raw);
    expect(r.text).toBe(raw);
    expect(r.hadBadges).toBe(false);
    expect(r.meta.route).toBeUndefined();
  });

  it("collapses the gaps left by stripped noise into single blank lines", () => {
    const raw = [
      "First paragraph.",
      "Searching for 1 pattern…",
      "",
      "Second paragraph.",
    ].join("\n");
    const r = sanitizeAssistantText(raw);
    expect(r.text).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("round-trips empty / null input to an empty result", () => {
    for (const v of ["", null, undefined]) {
      const r = sanitizeAssistantText(v as any);
      expect(r.text).toBe("");
      expect(r.hadBadges).toBe(false);
      expect(r.meta).toEqual({});
    }
  });

  it("handles a badge flowed onto the same line as prose", () => {
    const raw = "All set. [route: cc-haiku-low | rule: cell:other/T0-trivial | profile: balanced] [orchestrator-active]";
    const r = sanitizeAssistantText(raw);
    expect(r.text).toBe("All set.");
    expect(r.meta.route).toBe("cc-haiku-low");
  });
});

describe("claude-chat: routeChipLabel", () => {
  it("maps known model families to a friendly label", () => {
    expect(routeChipLabel({ route: "cc-sonnet-med" })).toBe("Sonnet");
    expect(routeChipLabel({ route: "cc-haiku-low" })).toBe("Haiku");
    expect(routeChipLabel({ route: "cc-opus-high" })).toBe("Opus");
    expect(routeChipLabel({ route: "gemini-pro" })).toBe("Gemini");
  });

  it("falls back to the raw target id and null when absent", () => {
    expect(routeChipLabel({ route: "some-custom-target" })).toBe("some-custom-target");
    expect(routeChipLabel({})).toBeNull();
  });
});

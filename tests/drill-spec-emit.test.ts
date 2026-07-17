import { describe, expect, it } from "vitest";
import { emitAssertionCode, emittableSteps, emitPageSpec } from "../fittings/seed/drill/lib/spec-emit.mjs";

// B8/B12/Q3 — pure spec-generation. Loaded-machine waits (F9) and the 5
// richer deterministic assertion kinds (delta 5) all get real Playwright
// expect() calls; judgment steps emit a drillJudge() call instead.

describe("emitAssertionCode", () => {
  it("text-contains", () => {
    expect(emitAssertionCode({ kind: "text-contains", text: "sent" })).toBe('await expect(page.locator("body")).toContainText("sent");');
  });
  it("visible, by testId", () => {
    expect(emitAssertionCode({ kind: "visible", testId: "answer" })).toBe('await expect(page.getByTestId("answer")).toBeVisible();');
  });
  it("visible, by role+name", () => {
    expect(emitAssertionCode({ kind: "visible", role: "button", name: "Send" })).toBe('await expect(page.getByRole("button", { name: "Send" })).toBeVisible();');
  });
  it("count eq uses toHaveCount; other ops use a manual comparison", () => {
    expect(emitAssertionCode({ kind: "count", selector: "li", op: "eq", value: 3 })).toBe('await expect(page.locator("li")).toHaveCount(3);');
    expect(emitAssertionCode({ kind: "count", selector: "li", op: "gte", value: 2 })).toBe("expect(await (page.locator(\"li\")).count()).toBeGreaterThanOrEqual(2);");
    expect(emitAssertionCode({ kind: "count", selector: "li", op: "lte", value: 5 })).toContain("toBeLessThanOrEqual(5)");
    expect(emitAssertionCode({ kind: "count", selector: "li", op: "gt", value: 1 })).toContain("toBeGreaterThan(1)");
    expect(emitAssertionCode({ kind: "count", selector: "li", op: "lt", value: 9 })).toContain("toBeLessThan(9)");
  });
  it("url-matches: substring mode escapes regex metacharacters; regex mode passes through", () => {
    expect(emitAssertionCode({ kind: "url-matches", pattern: "/chat/thread-1" })).toBe('await expect(page).toHaveURL(new RegExp("/chat/thread-1"));');
    expect(emitAssertionCode({ kind: "url-matches", pattern: "/thread-\\d+$", mode: "regex" })).toBe('await expect(page).toHaveURL(new RegExp("/thread-\\\\d+$"));');
  });
  it("attribute-equals", () => {
    expect(emitAssertionCode({ kind: "attribute-equals", testId: "lnk", attribute: "href", value: "/kb/entry-1" }))
      .toBe('await expect(page.getByTestId("lnk")).toHaveAttribute("href", "/kb/entry-1");');
  });
  it("throws for an unknown kind and for a locator-needing kind with no anchor", () => {
    expect(() => emitAssertionCode({ kind: "nope" })).toThrow(/cannot emit assertion kind/);
    expect(() => emitAssertionCode({ kind: "visible" })).toThrow(/no locator hint/);
  });
});

describe("emittableSteps", () => {
  it("only e2e-mode steps with an assertion or the judgment flag are emittable", () => {
    const page = {
      steps: [
        { id: "s1", mode: "e2e", assertion: { kind: "visible", testId: "a" } },
        { id: "s2", mode: "e2e", judgment: true, description: "citation quality" },
        { id: "s3", mode: "vision", description: "not graduated yet" },
        { id: "s4", mode: "e2e" } // e2e but nothing to emit (shouldn't happen, defensive)
      ]
    };
    expect(emittableSteps(page).map((s: any) => s.id)).toEqual(["s1", "s2"]);
  });
});

describe("emitPageSpec", () => {
  it("emits a test.describe with one test per emittable step, a loaded-machine wait, and imports drillJudge", () => {
    const page = {
      id: "chat", title: "Chat",
      steps: [
        { id: "s1", mode: "e2e", description: "answer visible", assertion: { kind: "visible", testId: "answer" } },
        { id: "s2", mode: "e2e", judgment: true, description: "citations look right" },
        { id: "s3", mode: "vision", description: "not graduated" }
      ]
    };
    const src = emitPageSpec(page, "http://localhost:3000/chat");
    expect(src).toContain('import { drillJudge } from "./support/drill-judge"');
    expect(src).toContain('test.describe("Chat"');
    expect(src).toContain('page.goto("http://localhost:3000/chat"');
    expect(src).toContain("networkidle");
    expect(src).toContain('await expect(page.getByTestId("answer")).toBeVisible();');
    expect(src).toContain("await drillJudge(page,");
    expect(src).not.toContain("not graduated"); // s3 never emitted
    expect(() => new Function(src.replace(/import[^\n]*\n/g, ""))).not.toThrow(); // syntactically valid (imports stripped for a bare eval check)
  });

  it("omits the drillJudge import entirely when the page has no judgment steps", () => {
    const page = { id: "p", title: "P", steps: [{ id: "s1", mode: "e2e", description: "x", assertion: { kind: "text-contains", text: "x" } }] };
    const src = emitPageSpec(page, "http://localhost:3000/p");
    expect(src).not.toContain("drillJudge");
  });
});

// Per-check interaction actions (S5): the missing half of a Drill check.
//
// Before this, a check compiled to [navigate, verify] with no interaction
// vocabulary, so a behavioural criterion ("pressing Shift+Enter inserts a
// newline") was judged against a freshly-loaded, untouched page. These tests
// pin the three links in the chain: compile the actions, harvest what the
// engine resolved, and emit them as real Playwright.
import { describe, it, expect } from "vitest";
import {
  normalizeStepActions,
  compileStepAutomation
} from "../fittings/seed/drill/lib/compile.mjs";
import {
  emitActionCode,
  isEmittableAction,
  stepActionsEmittable,
  emitPageSpec
} from "../fittings/seed/drill/lib/spec-emit.mjs";
import { harvestResolvedActions } from "../fittings/seed/drill/lib/graduate.mjs";

const book = { app: { url: "http://localhost:3000" } };
const page = { id: "chat", title: "Chat", path: "/chat", areas: [], states: [] };
const behavioural = {
  id: "composer-shift-enter-newline",
  mode: "e2e",
  description: "Pressing Shift+Enter inserts a newline instead of sending.",
  actions: ["click the composer textarea", 'type "hello" into the composer', "press Shift+Enter"]
};

describe("normalizeStepActions", () => {
  it("accepts bare strings and objects, drops blanks, and assigns stable ids", () => {
    const out = normalizeStepActions({
      actions: ["click X", "", { description: "type Y" }, { id: "final", description: "press Enter" }, { description: "  " }]
    });
    expect(out).toEqual([
      { id: "__act-0", description: "click X" },
      { id: "__act-1", description: "type Y" },
      { id: "final", description: "press Enter" }
    ]);
  });

  it("never collides with the navigate step, the check id, or a reach-path id", () => {
    // All of these land in ONE automation, and the engine's per-step cache and
    // result addressing key off stepId — a collision crosses their verdicts.
    const out = normalizeStepActions(
      { actions: [{ id: "reach-1", description: "a" }, { id: "chk", description: "b" }, { id: "__drill_navigate", description: "c" }] },
      { reserved: ["__drill_navigate", "chk", "reach-1"] }
    );
    expect(new Set(out.map((a: any) => a.id)).size).toBe(3);
    for (const a of out) expect(["__drill_navigate", "chk", "reach-1"]).not.toContain(a.id);
  });

  it("returns nothing for a check with no actions", () => {
    expect(normalizeStepActions({})).toEqual([]);
    expect(normalizeStepActions({ actions: "not an array" })).toEqual([]);
  });
});

describe("compileStepAutomation", () => {
  it("runs the interactions between navigation and the assertion", () => {
    const steps = compileStepAutomation(book, page, behavioural).steps;
    expect(steps.map((s: any) => s.type)).toEqual(["navigate", "browser", "browser", "browser", "verify"]);
    expect(steps.at(-1).id).toBe("composer-shift-enter-newline");
    expect(steps[3].description).toBe("press Shift+Enter");
  });

  it("keeps actions in a blind adversarial pass", () => {
    // The blind contract withholds the ANSWER (emitted specs, cached
    // assertions), not the route to the state under test. A blind pass that
    // never reaches the state checks a different, unreached page.
    const steps = compileStepAutomation(book, page, behavioural, { blind: true }).steps;
    expect(steps.filter((s: any) => s.type === "browser")).toHaveLength(3);
    expect(steps.at(-1).cachedAssertion).toBeUndefined();
  });

  it("compiles a check with no actions exactly as before", () => {
    const steps = compileStepAutomation(book, page, { id: "s1", description: "static thing" }).steps;
    expect(steps.map((s: any) => s.type)).toEqual(["navigate", "verify"]);
  });
});

describe("harvestResolvedActions", () => {
  const run = (records: any[]) => ({ steps: records });

  it("pairs each authored action with the action the engine resolved", () => {
    const actions = harvestResolvedActions(behavioural, run([
      { stepId: "__act-0", type: "browser", status: "completed", result: { action: { kind: "click", role: "textbox", name: "Descreva o que precisa..." } } },
      { stepId: "__act-1", type: "browser", status: "completed", result: { action: { kind: "fill", role: "textbox", name: "Descreva o que precisa...", value: "hello" } } },
      { stepId: "__act-2", type: "browser", status: "completed", result: { action: { kind: "press", value: "Shift+Enter" } } }
    ]));
    expect(actions).toHaveLength(3);
    expect(actions![2].resolved).toEqual({ kind: "press", value: "Shift+Enter" });
    expect(actions![0].description).toBe("click the composer textarea");
  });

  it("takes the LAST record for a step id", () => {
    // A run can carry more than one record per id; the one that produced the
    // final verdict is the last.
    const actions = harvestResolvedActions({ actions: ["click X"] }, run([
      { stepId: "__act-0", type: "browser", status: "completed", result: { action: { kind: "click", role: "button", name: "stale" } } },
      { stepId: "__act-0", type: "browser", status: "completed", result: { action: { kind: "click", role: "button", name: "final" } } }
    ]));
    expect(actions![0].resolved.name).toBe("final");
  });

  it("refuses a partial resolution rather than graduating half an interaction", () => {
    expect(harvestResolvedActions(behavioural, run([
      { stepId: "__act-0", type: "browser", status: "completed", result: { action: { kind: "click", role: "textbox", name: "x" } } }
    ]))).toBeNull();
    expect(harvestResolvedActions(behavioural, null)).toBeNull();
    // A failed attempt carries no action.
    expect(harvestResolvedActions({ actions: ["click X"] }, run([
      { stepId: "__act-0", type: "browser", status: "failed" }
    ]))).toBeNull();
  });

  it("is empty (not null) for a check that authored no actions", () => {
    expect(harvestResolvedActions({ id: "s1" }, run([]))).toEqual([]);
  });
});

describe("emitActionCode", () => {
  it("emits each action kind as real Playwright", () => {
    expect(emitActionCode({ kind: "press", value: "Shift+Enter" })).toBe('await page.keyboard.press("Shift+Enter");');
    expect(emitActionCode({ kind: "click", role: "button", name: "Anexar" })).toBe('await page.getByRole("button", { name: "Anexar" }).click();');
    expect(emitActionCode({ kind: "fill", placeholder: "Cola um URL...", value: "x" })).toBe('await page.getByPlaceholder("Cola um URL...").fill("x");');
    expect(emitActionCode({ kind: "check", testId: "opt" })).toBe('await page.getByTestId("opt").check();');
    expect(emitActionCode({ kind: "hover", selector: ".card" })).toBe('await page.locator(".card").hover();');
    expect(emitActionCode({ kind: "select", label: "Role", value: "admin" })).toBe('await page.getByLabel("Role").selectOption("admin");');
  });

  it("refuses to emit a redacted secret or an unknown kind", () => {
    // A fill whose value was an injected secret comes back redacted; emitting
    // it would commit a spec that types the sentinel into the app.
    expect(() => emitActionCode({ kind: "fill", role: "textbox", name: "pw", value: "***REDACTED***" })).toThrow(/redacted/);
    expect(() => emitActionCode({ kind: "teleport", role: "button", name: "x" })).toThrow(/cannot emit action kind/);
  });

  it("isEmittableAction rejects what cannot be grounded", () => {
    expect(isEmittableAction({ kind: "click", role: "button", name: "Go" })).toBe(true);
    expect(isEmittableAction({ kind: "press", value: "Enter" })).toBe(true);
    expect(isEmittableAction({ kind: "press" })).toBe(false); // no key
    expect(isEmittableAction({ kind: "click" })).toBe(false); // no locator hint
    expect(isEmittableAction(null)).toBe(false);
  });
});

describe("emitPageSpec with actions", () => {
  it("performs the interactions in the committed spec before asserting", () => {
    const graduated = {
      ...behavioural,
      assertion: { kind: "text-contains", text: "hello" },
      actions: [
        { id: "__act-0", description: "click the composer textarea", resolved: { kind: "click", role: "textbox", name: "Descreva o que precisa..." } },
        { id: "__act-2", description: "press Shift+Enter", resolved: { kind: "press", value: "Shift+Enter" } }
      ]
    };
    const spec = emitPageSpec({ ...page, steps: [graduated] }, "http://localhost:3000/chat");
    expect(spec).toContain('await page.getByRole("textbox", { name: "Descreva o que precisa..." }).click();');
    expect(spec).toContain('await page.keyboard.press("Shift+Enter");');
    expect(spec).toContain("// press Shift+Enter"); // the authored intent survives as a comment
    // Ordering: the keypress must precede the assertion it is supposed to cause.
    expect(spec.indexOf("keyboard.press")).toBeLessThan(spec.indexOf("toContainText"));
  });

  it("does NOT emit a check whose interactions have not resolved", () => {
    // Emitting the assertion alone would commit a test asserting a
    // post-interaction state it never produced.
    const unresolved = { ...behavioural, assertion: { kind: "text-contains", text: "hello" } };
    expect(stepActionsEmittable(unresolved)).toBe(false);
    expect(emitPageSpec({ ...page, steps: [unresolved] }, "http://x/")).not.toContain("composer-shift-enter-newline");
  });
});

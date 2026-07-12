import { describe, it, expect } from "vitest";
import {
  parseSelector,
  resolveSelector,
  elementMatchesAssert,
  evaluateAssert,
  performAction,
  type QueryRoot
} from "@/lib/tour-selector";
import { initTour, advanceTour, isComplete, stepIsAssertGated } from "@/lib/tour-machine";
import type { TourStep } from "@/lib/metadata";

// --- fake DOM ---------------------------------------------------------------
// The node test env has no jsdom, so we hand-build just enough of the Element /
// query surface the resolver touches. querySelectorAll dispatches off a map keyed
// by the exact CSS string the resolver passes; "__any__" is a catch-all for the
// single-call kinds (button/link/text/role).

interface FakeEl {
  tagName: string;
  textContent: string;
  attrs: Record<string, string>;
  value?: string;
  children?: FakeEl[];
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  contains(other: unknown): boolean;
  click?: () => void;
  dispatchEvent?: (event: unknown) => boolean;
}

function el(init: Partial<FakeEl> & { tag?: string; text?: string; attrs?: Record<string, string> }): FakeEl {
  const node: FakeEl = {
    tagName: init.tag ?? "DIV",
    textContent: init.text ?? "",
    attrs: init.attrs ?? {},
    value: init.value,
    children: init.children ?? [],
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    hasAttribute(name) {
      return name in this.attrs;
    },
    contains(other) {
      return (this.children ?? []).includes(other as FakeEl);
    },
    click: init.click,
    dispatchEvent: init.dispatchEvent
  };
  return node;
}

function fakeRoot(map: Record<string, FakeEl[]>): QueryRoot & { last?: string } {
  return {
    last: undefined,
    querySelectorAll(selector: string) {
      (this as { last?: string }).last = selector;
      return (map[selector] ?? map.__any__ ?? []) as unknown as ArrayLike<Element>;
    }
  };
}

describe("parseSelector", () => {
  it("parses every prefix of the mini-language", () => {
    expect(parseSelector("button:Save")).toEqual({ kind: "button", name: "Save" });
    expect(parseSelector("link:Home")).toEqual({ kind: "link", name: "Home" });
    expect(parseSelector("text:Welcome")).toEqual({ kind: "text", text: "Welcome" });
    expect(parseSelector("label:Email")).toEqual({ kind: "label", name: "Email" });
    expect(parseSelector("placeholder:Search")).toEqual({ kind: "placeholder", value: "Search" });
    expect(parseSelector("testid:submit")).toEqual({ kind: "testid", value: "submit" });
    expect(parseSelector("role:heading:Title")).toEqual({ kind: "role", role: "heading", name: "Title" });
    expect(parseSelector("raw-css:.foo > .bar")).toEqual({ kind: "css", css: ".foo > .bar" });
  });

  it("treats a bare, prefix-less string as CSS", () => {
    expect(parseSelector("#composition-switcher")).toEqual({ kind: "css", css: "#composition-switcher" });
    expect(parseSelector("[data-testid^='x']")).toEqual({ kind: "css", css: "[data-testid^='x']" });
  });

  it("keeps colons in a role name", () => {
    expect(parseSelector("role:heading:A:B")).toEqual({ kind: "role", role: "heading", name: "A:B" });
  });
});

describe("resolveSelector", () => {
  it("resolves raw CSS via querySelectorAll", () => {
    const target = el({ text: "hit" });
    const root = fakeRoot({ ".x": [target] });
    expect(resolveSelector(".x", root)).toBe(target);
    expect(root.last).toBe(".x");
  });

  it("resolves testid to an exact data-testid selector", () => {
    const target = el({ attrs: { "data-testid": "go" }, text: "Go" });
    const root = fakeRoot({ '[data-testid="go"]': [target] });
    expect(resolveSelector("testid:go", root)).toBe(target);
  });

  it("picks a button by accessible name, exact match winning over substring", () => {
    const save = el({ tag: "BUTTON", text: "Save" });
    const saveAll = el({ tag: "BUTTON", text: "Save all changes" });
    const root = fakeRoot({ __any__: [saveAll, save] });
    // Exact "Save" wins even though "Save all changes" also contains it.
    expect(resolveSelector("button:Save", root)).toBe(save);
  });

  it("falls back to a substring name match when no exact match exists", () => {
    const btn = el({ tag: "BUTTON", text: "Run the Operative" });
    const root = fakeRoot({ __any__: [btn] });
    expect(resolveSelector("button:Run the", root)).toBe(btn);
  });

  it("prefers an aria-label as the accessible name", () => {
    const input = el({ tag: "INPUT", attrs: { "aria-label": "Search Fittings" } });
    const root = fakeRoot({ __any__: [input] });
    expect(resolveSelector("button:Search Fittings", root)).toBe(input);
  });

  it("resolves getByText to the deepest matching element", () => {
    const inner = el({ text: "resolved" });
    const outer = el({ text: "status resolved", children: [inner] });
    const root = fakeRoot({ __any__: [outer, inner] });
    expect(resolveSelector("text:resolved", root)).toBe(inner);
  });

  it("resolves a label to its `for` control", () => {
    const input = el({ tag: "INPUT" });
    const label = el({ tag: "LABEL", text: "Email", attrs: { for: "email" } });
    const root = fakeRoot({ label: [label], "#email": [input] });
    expect(resolveSelector("label:Email", root)).toBe(input);
  });

  it("returns null when nothing resolves", () => {
    expect(resolveSelector("testid:missing", fakeRoot({}))).toBeNull();
  });
});

describe("elementMatchesAssert", () => {
  it("checks text substring", () => {
    const node = el({ text: "12 issues resolved" });
    expect(elementMatchesAssert(node as unknown as Element, { text: "resolved" })).toBe(true);
    expect(elementMatchesAssert(node as unknown as Element, { text: "pending" })).toBe(false);
  });

  it("checks aria-expanded for state:expanded", () => {
    const open = el({ attrs: { "aria-expanded": "true" } });
    const shut = el({ attrs: { "aria-expanded": "false" } });
    expect(elementMatchesAssert(open as unknown as Element, { state: "expanded" })).toBe(true);
    expect(elementMatchesAssert(shut as unknown as Element, { state: "expanded" })).toBe(false);
  });

  it("checks enabled / disabled", () => {
    const disabled = el({ attrs: { disabled: "" } });
    expect(elementMatchesAssert(disabled as unknown as Element, { state: "disabled" })).toBe(true);
    expect(elementMatchesAssert(disabled as unknown as Element, { state: "enabled" })).toBe(false);
  });
});

describe("evaluateAssert", () => {
  it("gates on pathname for a url assert", () => {
    expect(evaluateAssert({ url: "/quarters/" }, { pathname: "/quarters/skills" })).toBe(true);
    expect(evaluateAssert({ url: "/quarters/" }, { pathname: "/quarters" })).toBe(false);
  });

  it("resolves the selector and applies the state for a selector assert", () => {
    const toggle = el({ attrs: { "data-testid": "quarters-section-toggle-x", "aria-expanded": "true" } });
    const root = fakeRoot({ '[data-testid="quarters-section-toggle-x"]': [toggle] });
    expect(
      evaluateAssert({ selector: "testid:quarters-section-toggle-x", state: "expanded" }, { root })
    ).toBe(true);
  });

  it("fails when the selector resolves nothing", () => {
    expect(evaluateAssert({ selector: "testid:nope" }, { root: fakeRoot({}) })).toBe(false);
  });
});

describe("performAction", () => {
  it("clicks the element", () => {
    let clicked = 0;
    const node = el({ tag: "BUTTON", click: () => (clicked += 1) });
    performAction(node as unknown as Element, { type: "click" });
    expect(clicked).toBe(1);
  });

  it("fills a value and dispatches input + change", () => {
    const events: string[] = [];
    const node = el({
      tag: "INPUT",
      dispatchEvent: (event: unknown) => {
        events.push((event as { type: string }).type);
        return true;
      }
    });
    performAction(node as unknown as Element, { type: "fill", value: "orchestrator" });
    expect(node.value).toBe("orchestrator");
    expect(events).toContain("input");
    expect(events).toContain("change");
  });

  it("is a no-op on navigate (the engine owns routing)", () => {
    const node = el({ click: () => { throw new Error("should not click"); } });
    expect(() => performAction(node as unknown as Element, { type: "navigate", path: "/x" })).not.toThrow();
  });
});

describe("tour state machine", () => {
  const steps: TourStep[] = [
    { id: "a", caption: "a", selector: "text:a" },
    { id: "b", caption: "b", selector: "text:b", assert: { selector: "text:b" } },
    { id: "c", caption: "c", selector: "text:c" }
  ];

  it("advances through every step to complete", () => {
    let state = initTour(steps.length);
    expect(state).toEqual({ index: 0, total: 3, status: "running" });
    state = advanceTour(state);
    expect(state.index).toBe(1);
    state = advanceTour(state);
    expect(state.index).toBe(2);
    expect(isComplete(state)).toBe(false);
    state = advanceTour(state);
    expect(isComplete(state)).toBe(true);
    expect(state.index).toBe(2); // clamped to the final step
  });

  it("advancing a complete tour is idempotent", () => {
    const done = { index: 2, total: 3, status: "complete" as const };
    expect(advanceTour(done)).toEqual(done);
  });

  it("flags assert-gated steps", () => {
    expect(stepIsAssertGated(steps[0])).toBe(false);
    expect(stepIsAssertGated(steps[1])).toBe(true);
  });
});

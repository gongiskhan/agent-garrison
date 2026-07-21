// tour-selector.ts — the DOM-side executor primitives for the WS6 in-app tour
// engine. This is the live-DOM counterpart to the walkthrough browser executor
// (~/.claude/skills/walkthrough/scripts/lib/browser.mjs): it speaks the SAME
// selector mini-language, but resolves against the running document with
// querySelector instead of Playwright locators, and asserts/acts against real
// elements instead of a Playwright `page`.
//
// The module is split so the branching logic is unit-testable in the node test
// env (no jsdom): parseSelector is pure; resolveSelector / evaluateAssert /
// performAction take an injectable root/element, so a hand-built fake DOM
// exercises the matching + dispatch without a browser.
import type { TourAction, TourAssert } from "./metadata";

export type { TourAction, TourAssert, TourStep, TourDescriptor } from "./metadata";

// The parsed shape of one selector. `kind` mirrors the storyboard prefixes;
// `css` is the escape hatch (a raw CSS/locator string).
export type SelectorQuery =
  | { kind: "button" | "link"; name: string }
  | { kind: "text"; text: string }
  | { kind: "label"; name: string }
  | { kind: "placeholder"; value: string }
  | { kind: "testid"; value: string }
  | { kind: "role"; role: string; name: string }
  | { kind: "css"; css: string };

// Minimal contract a resolution root must satisfy — `document` and any Element
// satisfy it, and a test fake can implement it in a few lines.
export interface QueryRoot {
  querySelectorAll(selector: string): ArrayLike<Element>;
}

// Parse the selector mini-language into a structured query. Pure — no DOM.
//   button:Save | link:Home | text:Welcome | label:Email | placeholder:Search
//   | testid:submit | role:heading:Title | otherwise a raw CSS/locator string.
export function parseSelector(selector: string): SelectorQuery {
  const sel = selector.trim();
  if (sel.startsWith("button:")) return { kind: "button", name: sel.slice(7) };
  if (sel.startsWith("link:")) return { kind: "link", name: sel.slice(5) };
  if (sel.startsWith("text:")) return { kind: "text", text: sel.slice(5) };
  if (sel.startsWith("label:")) return { kind: "label", name: sel.slice(6) };
  if (sel.startsWith("placeholder:")) return { kind: "placeholder", value: sel.slice(12) };
  if (sel.startsWith("testid:")) return { kind: "testid", value: sel.slice(7) };
  // Explicit raw-css: escape hatch (mirrors the storyboard mini-language). A
  // bare, prefix-less string is also treated as CSS below.
  if (sel.startsWith("raw-css:")) return { kind: "css", css: sel.slice(8) };
  if (sel.startsWith("role:")) {
    const [, role, ...rest] = sel.split(":");
    return { kind: "role", role, name: rest.join(":") };
  }
  return { kind: "css", css: sel };
}

const norm = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// The accessible-ish name of an element: aria-label wins, then an input's
// value/placeholder, then its trimmed text. Enough to disambiguate buttons,
// links and headings in-app without a full accessible-name computation.
function accessibleName(element: Element): string {
  const aria = element.getAttribute("aria-label");
  if (aria) return aria;
  const tag = (element.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const value = (element as HTMLInputElement).value;
    if (value) return value;
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return placeholder;
  }
  return element.textContent ?? "";
}

function toArray(list: ArrayLike<Element>): Element[] {
  return Array.prototype.slice.call(list);
}

// Match by accessible name: prefer an exact (normalized) match, else a prefix,
// else a substring — the same forgiving order the storyboard resolver's callers
// rely on. Returns the first winning candidate in document order.
function pickByName(candidates: Element[], name: string): Element | null {
  const wanted = norm(name);
  if (!wanted) return candidates[0] ?? null;
  const exact = candidates.find((el) => norm(accessibleName(el)) === wanted);
  if (exact) return exact;
  const prefix = candidates.find((el) => norm(accessibleName(el)).startsWith(wanted));
  if (prefix) return prefix;
  return candidates.find((el) => norm(accessibleName(el)).includes(wanted)) ?? null;
}

// getByText semantics: the DEEPEST element whose text contains the string, so we
// spotlight the label itself, not an ancestor container that merely wraps it.
function pickByText(root: QueryRoot, text: string): Element | null {
  const wanted = norm(text);
  const all = toArray(root.querySelectorAll("*")).filter((el) =>
    norm(el.textContent).includes(wanted)
  );
  // Keep only leaf matches — a matching element that contains no other match.
  const leaves = all.filter(
    (el) => !all.some((other) => other !== el && typeof el.contains === "function" && el.contains(other))
  );
  return leaves[0] ?? all[0] ?? null;
}

const ROLE_TAGS: Record<string, string> = {
  button: "button, [role='button'], input[type='button'], input[type='submit']",
  link: "a[href], [role='link']",
  heading: "h1, h2, h3, h4, h5, h6, [role='heading']"
};

// Resolve one selector to a single Element (or null). Root defaults to the live
// document; tests pass a fake QueryRoot.
export function resolveSelector(
  selector: string,
  root: QueryRoot = typeof document !== "undefined" ? document : { querySelectorAll: () => [] }
): Element | null {
  const query = parseSelector(selector);
  switch (query.kind) {
    case "css":
      return toArray(root.querySelectorAll(query.css))[0] ?? null;
    case "testid":
      return toArray(root.querySelectorAll(`[data-testid="${cssEscape(query.value)}"]`))[0] ?? null;
    case "placeholder": {
      const exact = toArray(
        root.querySelectorAll(`[placeholder="${cssEscape(query.value)}"]`)
      )[0];
      if (exact) return exact;
      const wanted = norm(query.value);
      return (
        toArray(root.querySelectorAll("[placeholder]")).find((el) =>
          norm(el.getAttribute("placeholder")).includes(wanted)
        ) ?? null
      );
    }
    case "button":
      return pickByName(toArray(root.querySelectorAll(ROLE_TAGS.button)), query.name);
    case "link":
      return pickByName(toArray(root.querySelectorAll(ROLE_TAGS.link)), query.name);
    case "text":
      return pickByText(root, query.text);
    case "label": {
      const wanted = norm(query.name);
      const label = toArray(root.querySelectorAll("label")).find((el) =>
        norm(el.textContent).includes(wanted)
      );
      if (!label) return null;
      const forId = label.getAttribute("for");
      if (forId) return toArray(root.querySelectorAll(`#${cssEscape(forId)}`))[0] ?? null;
      // Nested control inside the <label>.
      return toArray(label.querySelectorAll("input, textarea, select"))[0] ?? null;
    }
    case "role": {
      const group = ROLE_TAGS[query.role] ?? `[role='${cssEscape(query.role)}']`;
      const candidates = toArray(root.querySelectorAll(group));
      return query.name ? pickByName(candidates, query.name) : candidates[0] ?? null;
    }
    default:
      return null;
  }
}

// CSS.escape when available; a conservative fallback otherwise (tests + older
// runtimes). Only used for values we build into attribute selectors.
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\\]]/g, "\\$&");
}

// --- assert evaluation (GUIDED gating) ------------------------------------

export interface AssertContext {
  root?: QueryRoot;
  pathname?: string;
}

function isVisible(element: Element): boolean {
  const el = element as HTMLElement;
  if (typeof el.getClientRects === "function") {
    const rects = el.getClientRects();
    if (rects && rects.length === 0) return false;
  }
  if (el.hidden) return false;
  const style = typeof window !== "undefined" && window.getComputedStyle ? window.getComputedStyle(el) : null;
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  return true;
}

function isDisabled(element: Element): boolean {
  if ((element as HTMLButtonElement).disabled) return true;
  if (element.getAttribute("aria-disabled") === "true") return true;
  return element.hasAttribute?.("disabled") ?? false;
}

function isChecked(element: Element): boolean {
  if ((element as HTMLInputElement).checked) return true;
  return element.getAttribute("aria-checked") === "true";
}

// Whether a resolved element satisfies a step's assert (text + state). Pure over
// the element's attributes/text, so unit-testable with a fake element.
export function elementMatchesAssert(element: Element, assert: TourAssert): boolean {
  if (assert.text && !norm(element.textContent).includes(norm(assert.text))) return false;
  switch (assert.state) {
    case "visible":
      return isVisible(element);
    case "enabled":
      return !isDisabled(element);
    case "disabled":
      return isDisabled(element);
    case "checked":
      return isChecked(element);
    case "expanded":
      return element.getAttribute("aria-expanded") === "true";
    default:
      return true;
  }
}

// Evaluate a full assert against the current DOM/route. A url assert gates on
// pathname (startsWith); otherwise the selector must resolve and match.
export function evaluateAssert(assert: TourAssert, ctx: AssertContext = {}): boolean {
  if (assert.url) {
    const pathname =
      ctx.pathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
    return pathname.startsWith(assert.url);
  }
  if (!assert.selector) return false;
  const root = ctx.root ?? (typeof document !== "undefined" ? document : undefined);
  if (!root) return false;
  const element = resolveSelector(assert.selector, root);
  if (!element) return false;
  return elementMatchesAssert(element, assert);
}

// --- action dispatch (DEMO player) ----------------------------------------

// React controls inputs, so a bare `el.value = x` is discarded on the next
// render. Set through the native prototype setter, then fire input + change so
// React's onChange runs. Falls back to a plain assignment where no DOM globals
// exist (the node test env), which is enough to assert the dispatcher's effect.
function setNativeValue(element: Element, value: string): void {
  const tag = (element.tagName || "").toLowerCase();
  let proto: unknown = null;
  if (tag === "textarea" && typeof HTMLTextAreaElement !== "undefined") {
    proto = HTMLTextAreaElement.prototype;
  } else if (tag === "select" && typeof HTMLSelectElement !== "undefined") {
    proto = HTMLSelectElement.prototype;
  } else if (typeof HTMLInputElement !== "undefined") {
    proto = HTMLInputElement.prototype;
  }
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : undefined;
  if (setter) setter.call(element, value);
  else (element as HTMLInputElement).value = value;
  dispatch(element, "input");
  dispatch(element, "change");
}

function dispatch(element: Element, type: string): void {
  const target = element as unknown as { dispatchEvent?: (event: unknown) => boolean };
  if (typeof target.dispatchEvent !== "function") return;
  if (typeof Event !== "undefined") target.dispatchEvent(new Event(type, { bubbles: true }));
  else target.dispatchEvent({ type, bubbles: true });
}

// Perform a step's action on its resolved element. `navigate` is a no-op here —
// the engine owns routing (it has the router); this returns whether a caller
// still needs to handle navigation.
export function performAction(element: Element, action: TourAction): void {
  switch (action.type) {
    case "click":
      (element as HTMLElement).click?.();
      break;
    case "fill":
      setNativeValue(element, action.value ?? "");
      break;
    case "select":
      setNativeValue(element, action.value ?? "");
      break;
    case "navigate":
      // handled by the engine (router.push(action.path))
      break;
    default:
      break;
  }
}

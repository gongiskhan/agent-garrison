// The collapsed conversations rail (wide layouts only).
//
// The bug this guards, found on dev-madrid at 1600px: the rail collapses to a
// 42px column, but the head is a flex row whose children do not shrink. It held
// the 20px collapse chevron, an 8px gap, the 26px shells button (+6px margin),
// another 8px gap and the New wrapper - ~68px of content in a 42px box. Nothing
// clips it and the head centres its overflow, so the spill went BOTH ways and
// pushed the chevron out under the shell sidebar, where it could not be seen or
// clicked. With the list hidden and no way to bring it back, Conversations was
// unusable on every wide screen.
//
// So the contract is: in rail mode every direct child of the head is hidden
// EXCEPT the collapse chevron. These assertions are deliberately two-sided -
// they read the rail's hidden list out of the CSS *and* the classes the rail
// actually renders out of the TSX - so adding a new button to the head (or
// renaming an existing one) fails here instead of silently overflowing again.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const UI = path.resolve(__dirname, "..", "packages", "talk", "ui");
const CSS = readFileSync(path.join(UI, "styles.css"), "utf8");
const RAIL_TSX = readFileSync(path.join(UI, "sessions-rail.tsx"), "utf8");

/** The `display: none` selector list inside the wide-layout rail block. */
function railHiddenSelectors(): string[] {
  // The rail block is scoped to wide layouts on purpose: below 900px the
  // sidebar is a slide-over drawer instead, and two collapse mechanisms on one
  // element would contradict each other.
  const block = CSS.split("@media (min-width: 901px)")[1];
  expect(block, "the wide-layout rail block must exist").toBeTruthy();
  const rule = block.match(/((?:\s*\.wc-shell--rail\s+\.[\w-]+,)+\s*\.wc-shell--rail\s+\.[\w-]+)\s*\{\s*display:\s*none/);
  expect(rule, "the rail block must hide its head/body children").toBeTruthy();
  return [...rule![1].matchAll(/\.wc-shell--rail\s+\.([\w-]+)/g)].map((m) => m[1]);
}

describe("the collapsed conversations rail (>= 901px)", () => {
  it("hides every direct child of the rail head except the collapse chevron", () => {
    const hidden = railHiddenSelectors();
    // Each of these is a real, non-shrinking flex item in the head; any one of
    // them left visible re-creates the overflow that hid the chevron.
    expect(hidden).toContain("wc-sidebar-title");
    expect(hidden).toContain("wc-shells-btn");
    expect(hidden).toContain("wc-new-wrap");
  });

  it("keeps the collapse chevron itself visible - it is the only way back to the list", () => {
    expect(railHiddenSelectors()).not.toContain("wc-sidebar-collapse");
    // And it must still be displayed at wide widths (it is display:none by
    // default, turned on only inside the rail block).
    const block = CSS.split("@media (min-width: 901px)")[1];
    expect(block).toMatch(/\.wc-sidebar-collapse\s*\{\s*display:\s*inline-flex/);
  });

  it("hides the list body too, so the rail is a clean 42px column", () => {
    const hidden = railHiddenSelectors();
    expect(hidden).toContain("wc-side-scroll");
    expect(hidden).toContain("wc-thread-list");
    const block = CSS.split("@media (min-width: 901px)")[1];
    expect(block).toMatch(/\.wc-shell--rail\s+\.wc-sidebar\s*\{\s*width:\s*42px/);
  });

  it("every class the rail head actually renders is either the chevron or hidden in rail mode", () => {
    // Read the head straight out of the component: if someone adds a button
    // here, it shows up in this list and must be hidden in rail mode too.
    const head = RAIL_TSX.split('className="wc-sidebar-head"')[1];
    expect(head, "the rail must render a wc-sidebar-head").toBeTruthy();
    // Stop at the New menu: everything past it only renders inside the popover,
    // which is itself contained by (and hidden with) .wc-new-wrap.
    const headTop = head.split('className="wc-newmenu"')[0];
    const rendered = new Set([...headTop.matchAll(/className="(wc-[\w-]+)"/g)].map((m) => m[1]));
    const hidden = new Set(railHiddenSelectors());
    const leaked = [...rendered].filter((c) => c !== "wc-sidebar-collapse" && !hidden.has(c));
    expect(
      leaked,
      `these rail-head children are visible in the 42px collapsed rail and will overflow it: ${leaked.join(", ")}`
    ).toEqual([]);
  });
});

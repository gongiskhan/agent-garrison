// The shell lane on a phone: how you get back to the conversation list.
//
// Two controls exist. A conversation carries the toggle INSIDE its own header
// row (.wc-threads-toggle). The lanes without such a row - an owned shell, a
// session view, the loading lane - fall back to the floating one
// (.wc-sidebar-toggle), which is absolutely positioned over the top-left of
// the column. `inConversation` is false for a shell thread (its conversationId
// is nulled by the shell binding), so a shell ALWAYS depends on the floating
// button, and if that button is unreachable the lane has no way back at all.
//
// Both halves of that broke at once, reported from the Garrison app on a phone:
//
//   1. Nothing between .wc-sidebar-toggle and the document establishes a
//      containing block (.talk-page, .talk-host and .wc-shell are all static),
//      so its `top` is measured from the VIEWPORT. Mounted under the shell's
//      app bar, a bare `top: 8px` put it behind the bar.
//   2. talk's own `@media (max-width: 480px)` rule reset the deck to
//      `padding: 8px 12px`, dropping the 52px left clearance a rule 250 lines
//      earlier adds precisely so the floating toggle can overlay that edge.
//
// The arithmetic assertion below is the one that matters: the deck's left
// clearance must cover the toggle's own footprint, whatever those numbers
// become.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const TALK_CSS = readFileSync(path.join(ROOT, "packages/talk/ui/styles.css"), "utf8");
const SKIN_CSS = readFileSync(path.join(ROOT, "src/components/talk/talk-page.css"), "utf8");

/** The floating toggle's own box, from talk's narrow-layout block. */
function floatingToggleBox(): { left: number; width: number } {
  const rule = TALK_CSS.match(/\.wc-sidebar-toggle\s*\{[^}]*\}/g)?.find((r) => r.includes("position: absolute"));
  expect(rule, ".wc-sidebar-toggle must still be an absolutely positioned button").toBeTruthy();
  const left = Number(rule!.match(/left:\s*(\d+)px/)?.[1]);
  const width = Number(rule!.match(/width:\s*(\d+)px/)?.[1]);
  expect(Number.isFinite(left) && Number.isFinite(width)).toBe(true);
  return { left, width };
}

/** The shell/session deck's left padding in the phone block. */
function deckLeftPaddingAtPhone(): number {
  const rule = TALK_CSS.match(/\.wc-sess \.wc-wb-head,\s*\.wc-wb--shell \.wc-wb-head\s*\{[^}]*\}/)?.[0];
  expect(rule, "the <=480px deck rule must still exist").toBeTruthy();
  const shorthand = rule!.match(/padding:\s*([^;]+);/)?.[1]?.trim();
  expect(shorthand, "the deck rule must set padding").toBeTruthy();
  const parts = shorthand!.split(/\s+/);
  // 4-value shorthand: top right bottom LEFT. 2-value: vertical horizontal.
  const left = parts.length >= 4 ? parts[3] : parts[1];
  return Number(String(left).replace("px", ""));
}

describe("the shell lane keeps a reachable way back to the conversation list (phone)", () => {
  it("clears the app bar - the toggle's top is measured from the viewport, so it must offset by the bar", () => {
    const rule = SKIN_CSS.match(/\.shell-phone \.talk-page \.wc-sidebar-toggle\s*\{[^}]*\}/)?.[0];
    expect(rule, "the skin must place the floating toggle").toBeTruthy();
    // --app-bar-h already carries --shell-safe-top, so this clears the status
    // bar inset too. A bare pixel top would sit behind the bar.
    expect(rule).toMatch(/top:\s*calc\(\s*var\(--app-bar-h\)/);
  });

  it("does not overlap the deck: the deck's left clearance covers the toggle's footprint", () => {
    const { left, width } = floatingToggleBox();
    const clearance = deckLeftPaddingAtPhone();
    expect(
      clearance,
      `the shell/session deck reserves ${clearance}px on the left but the floating toggle occupies ${left + width}px - it will sit on top of the deck's lamp and state word`
    ).toBeGreaterThanOrEqual(left + width);
  });

  it("the skin does not flatten the deck's clearance back to a conversation-row inset", () => {
    // The conversation lanes put the toggle in their own row, so 12px is right
    // for them; the deck has no such row and must not be lumped in with them.
    const twelve = SKIN_CSS.match(/([^}]*)\{\s*padding-left:\s*12px;\s*\}/g) ?? [];
    const lumped = twelve.filter((r) => r.includes(".wc-wb-head"));
    expect(
      lumped,
      "the shell deck is grouped with the conversation heads at padding-left: 12px, which removes the floating toggle's clearance"
    ).toEqual([]);
  });

  it("still gives the deck clearance across the whole narrow range, not only at <=480px", () => {
    expect(TALK_CSS).toMatch(/@media \(max-width: 899px\) \{\s*\.wc-wb-head \{ padding-left: 52px; \}/);
  });
});

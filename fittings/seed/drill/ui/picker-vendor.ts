// Bundled separately (IIFE) from the main UI bundle so its source text can be
// read server-side and prepended to an in-page eval call (D4): @medv/finder
// biased to data-testid/role/aria-label, css-selector-generator as fallback.
// Runs INSIDE the app-under-test's page context (via CDP Runtime.evaluate),
// never inside Drill's own UI — window here is the target page's window.
import { finder } from "@medv/finder";
import { getCssSelector } from "css-selector-generator";

declare global {
  interface Window {
    __drillVendor?: { finder: typeof finder; getCssSelector: typeof getCssSelector };
  }
}

window.__drillVendor = { finder, getCssSelector };

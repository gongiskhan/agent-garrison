// Element picking (D4, B2, B3, B4): @medv/finder biased to data-testid/role/
// aria-label, css-selector-generator as fallback, computed IN-PAGE via CDP
// Runtime.evaluate (browser-default's existing /tabs/:id/eval — no new
// browser-fitting capability needed; F2's "Browser fitting stays a pure
// service" holds). Multi-anchor (testId, css, xpath, text), percentage rect
// so badges survive responsive layouts (drawn in Drill's own overlay layer,
// never injected into the app under test).
//
// Pure script-builders + pure parsers — no I/O beyond reading the built
// vendor bundle, so the shape of every eval script is unit-testable without a
// browser. Actual in-page execution is exercised by the integration tests
// that drive a real browser-default + fixture page.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function defaultVendorPath() {
  return path.join(HERE, "..", "dist", "picker-vendor.js");
}

export function vendorScript(distPath = defaultVendorPath()) {
  return readFileSync(distPath, "utf8");
}

// No id-uniqueness assumed elsewhere in the page — walks up to <body>,
// counting same-tag preceding siblings at each level.
const XPATH_FN = `
function __drillXPath(el) {
  if (el.id) return '//*[@id="' + el.id + '"]';
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    let idx = 1, sib = node.previousElementSibling;
    while (sib) { if (sib.tagName === node.tagName) idx++; sib = sib.previousElementSibling; }
    parts.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
    node = node.parentElement;
  }
  return '/' + (node === document.body ? 'html/body/' : '') + parts.join('/');
}`;

const ANCHOR_FN = `
function __drillAnchorsFor(el) {
  var css = null, cssMethod = null;
  try {
    if (window.__drillVendor && window.__drillVendor.finder) {
      css = window.__drillVendor.finder(el, { attr: function(name){ return name === 'data-testid' || name === 'role' || name === 'aria-label'; } });
      cssMethod = 'finder';
    }
  } catch (e) {}
  if (!css) {
    try { css = window.__drillVendor.getCssSelector(el); cssMethod = 'css-selector-generator'; } catch (e) {}
  }
  var rect = el.getBoundingClientRect();
  return {
    testId: el.getAttribute('data-testid') || null,
    role: el.getAttribute('role') || null,
    ariaLabel: el.getAttribute('aria-label') || null,
    text: (el.textContent || '').trim().slice(0, 120) || null,
    tag: el.tagName.toLowerCase(),
    css: css,
    cssMethod: cssMethod,
    xpath: __drillXPath(el),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { w: window.innerWidth, h: window.innerHeight }
  };
}`;

function assertFiniteCoord(n, label) {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`${label} must be a finite number, got ${n}`);
  return v;
}

// Full eval script: vendor bundle + helpers + pick-at-point. Returns the
// anchors for the element under (x, y) in viewport CSS pixels, or null.
export function buildPickScript(x, y, distPath = defaultVendorPath()) {
  const px = assertFiniteCoord(x, "x");
  const py = assertFiniteCoord(y, "y");
  return `${vendorScript(distPath)}
${XPATH_FN}
${ANCHOR_FN}
(function() {
  var el = document.elementFromPoint(${px}, ${py});
  if (!el) return null;
  return __drillAnchorsFor(el);
})()`;
}

// Resolve a STORED anchor set against the LIVE DOM, ladder order: testId ->
// css -> xpath -> text (fuzzy: first element whose trimmed text CONTAINS the
// stored text). Returns the resolved element's CURRENT rect (for badge
// redraw across reloads/viewport changes) plus which anchor matched, or null
// if none resolve — a caller sees null and can escalate, never silently
// drifts to the wrong element (same "never guess" spirit as R11).
export function buildResolveScript(anchors) {
  const a = JSON.stringify(anchors ?? {});
  return `${XPATH_FN}
(function() {
  var a = ${a};
  var el = null, matched = null;
  if (a.testId) { el = document.querySelector('[data-testid="' + CSS.escape(a.testId) + '"]'); if (el) matched = 'testId'; }
  if (!el && a.css) { try { el = document.querySelector(a.css); if (el) matched = 'css'; } catch (e) {} }
  if (!el && a.xpath) {
    try {
      var r = document.evaluate(a.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (r.singleNodeValue) { el = r.singleNodeValue; matched = 'xpath'; }
    } catch (e) {}
  }
  if (!el && a.text) {
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var cand = all[i];
      var t = (cand.textContent || '').trim();
      if (t && t.length < 200 && t.indexOf(a.text) !== -1) { el = cand; matched = 'text'; break; }
    }
  }
  if (!el) return null;
  var rect = el.getBoundingClientRect();
  return { matched: matched, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { w: window.innerWidth, h: window.innerHeight } };
})()`;
}

// Percentage-of-viewport conversion (B3: "Rects are percentages of the anchor
// box so badges survive responsive layouts").
export function rectToPercent(rect, viewport) {
  if (!rect || !viewport || !viewport.w || !viewport.h) return null;
  return {
    leftPct: (rect.x / viewport.w) * 100,
    topPct: (rect.y / viewport.h) * 100,
    widthPct: (rect.width / viewport.w) * 100,
    heightPct: (rect.height / viewport.h) * 100
  };
}

// Compile a picked/stored anchor set to the automations engine's action-
// locator vocabulary (browser-orchestrator.mjs / browser-default's
// resolveActionLocator: selector, role+name, testId, label, placeholder,
// text) — an xpath anchor becomes a Playwright `xpath=` selector, which
// page.locator() already supports natively, so no engine/browser-default
// change is needed for this leg of graduation (B8/B12).
export function anchorsToLocatorHint(anchors) {
  if (!anchors) return {};
  if (anchors.testId) return { testId: anchors.testId };
  if (anchors.css) return { selector: anchors.css };
  if (anchors.xpath) return { selector: `xpath=${anchors.xpath}` };
  if (anchors.role && anchors.ariaLabel) return { role: anchors.role, name: anchors.ariaLabel };
  if (anchors.text) return { text: anchors.text };
  throw new Error("area has no usable anchor (testId/css/xpath/role+ariaLabel/text)");
}

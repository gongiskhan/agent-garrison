// Single source of truth for caption & title typography across the surfaces
// that render text in a walkthrough: the in-page browser overlay
// (browser.mjs:caption), the evidence-panel caption bar, and the title/outro
// cards (render.mjs). STRINGS ONLY — no DOM, no imports — so it can be consumed both
// by the Node-side HTML builders AND baked (by value) into the generated
// playwright `run-code` script string, which executes in its own VM and cannot
// import this module.
//
// System sans stack only (no bundled webfont): every surface renders in the
// same headless Chromium on macOS, so -apple-system / BlinkMacSystemFont
// resolves to San Francisco everywhere and the surfaces match by construction.
// DELIBERATELY no multi-word (quoted) family names — the browser overlay style
// is built as a double-quoted inline attribute inside a single-quoted JS
// string, where an embedded quote would break the markup.
export const FONT = `-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif`;

// Caption design tokens. Consumed verbatim by render.mjs (template literals in a
// <style> block) and interpolated BY VALUE into browser.mjs's generated overlay
// markup. Keep every value a primitive string/number so both paths are trivial.
export const CAPTION = {
  fontSize: 30,                 // px
  weight: 600,
  lineHeight: 1.3,
  letterSpacing: '-0.01em',
  maxWidth: 1040,               // px — caps line length of the wrapping video overlay
  padY: 18,                     // px
  padX: 30,                     // px
  accent: '#14b8a6',            // success accent (border-top)
  accentFail: '#ef4444',        // failure accent
  bg: '#0b0e14',                // OPAQUE bar background (evidence-panel caption bar)
  bgFail: '#2a0a0a',
  scrim: 'rgba(2,6,23,.86)',    // TRANSLUCENT overlay scrim (painted over live video)
  scrimFail: 'rgba(42,10,10,.94)',
  fg: '#ffffff',                // caption text
  failText: '#fca5a5',          // the "FAILED — " prefix
};

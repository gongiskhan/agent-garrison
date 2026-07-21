import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 2026-07-02 fitting-ui-coherence: the improver review-queue UI was restyled
// from a generic GitHub-dark theme onto Garrison's design tokens (the same move
// the kanban-loop board made). This guards the tokens in BOTH the source
// stylesheet and the built dist copy, so a stale build or a regression back to
// the dark theme fails loudly.

const UI = path.resolve(__dirname, "..", "fittings", "seed", "improver", "ui");
const DIST = path.resolve(__dirname, "..", "fittings", "seed", "improver", "dist");

const GARRISON_TOKENS = ["--paper: #fbf8f1", "--ink: #18211c", "--brass: #b4862a", "--sage: #2f4a3a"];
const DARK_THEME_MARKERS = ["#0f1115", "#5b8cff", "#161a22"];

describe("improver UI wears the Garrison tokens", () => {
  for (const dir of [UI, DIST]) {
    const label = path.basename(dir);
    it(`${label}/styles.css carries the Garrison palette and none of the old dark theme`, () => {
      const css = fs.readFileSync(path.join(dir, "styles.css"), "utf8");
      for (const token of GARRISON_TOKENS) {
        expect(css, `${label}/styles.css missing token "${token}"`).toContain(token);
      }
      for (const marker of DARK_THEME_MARKERS) {
        expect(css, `${label}/styles.css still contains dark-theme colour "${marker}"`).not.toContain(
          marker
        );
      }
    });

    it(`${label}/index.html loads the Garrison type stack`, () => {
      const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
      for (const family of ["Inter", "Source+Serif+4", "JetBrains+Mono"]) {
        expect(html, `${label}/index.html does not load font family "${family}"`).toContain(family);
      }
    });
  }
});

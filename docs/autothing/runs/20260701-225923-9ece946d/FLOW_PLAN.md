# Flow Plan — Garrison coherence + design overhaul + landing page (run 20260701-225923-9ece946d)

## Context found (Phase 1 exploration, inline)

- **Design tokens (real, authoritative):** `src/app/globals.css:5-26` — paper `#fbf8f1` /
  `#f4ede0` / `#ece2cc`, ink `#18211c`, sage `#2f4a3a`/`#3d6249`, brass `#b4862a`/`#d8a82e`,
  rule `#d6cdba`, alarm `#9b362d`, warn `#b07215`. Theme colour `#1f3026` (layout.tsx:51).
  604-line hand-rolled CSS layer + Tailwind utilities. Editorial paper/brass identity already
  in place; the brief's fallback palette is close but the app values win.
- **Fonts (real):** Inter (`--font-sans`, body), Source Serif 4 (`--font-display`),
  JetBrains Mono (`--font-mono`) via next/font/google (`src/app/layout.tsx:2-26`).
- **Licence:** NO `LICENSE` file; no `license` field in package.json.
  `docs/GOVERNANCE.md:152` says licence "open and not yet selected; default in
  CONTRIBUTING.md is MIT pending an explicit decision".
- **Brand assets:** logo exists at `public/icons/icon-512.png` (+ icon.svg, favicons).
  NO `/site` folder, NO screenshots dropped. App live at 127.0.0.1:7777; own-port UIs live:
  kanban 7089, improver 7088, dev-env 7086, web-channel 7083, automations 7197, monitor 7077,
  screen-share 7079, voice 7085.
- **Fitting UI divergence:** kanban-loop + web-channel already use the Garrison paper tokens;
  **improver** (`fittings/seed/improver/ui/styles.css`) is a divergent GitHub-dark theme
  (`#0f1115`, blue `#5b8cff` accent); claude-chat package default is GitHub-dark but themable
  via `--cc-*` vars (web-channel overrides them correctly). automations serves a hand-authored
  tracked `dist` UI.
- **Model layer:** `src/lib/types.ts` — 17 faculties (9 core + 7 optional capability + connectors),
  14 capability kinds, with dated rationale comments. `capabilities.ts` resolver + `metadata.ts`
  parser carry legacy aliases. Docs to check for drift: FACULTIES.md, CAPABILITIES.md, METADATA.md.
- **Working tree:** uncommitted changes from prior run 20260701-092738 (improver ecosystem-update,
  kanban restyle, pty, web-channel). Build ON TOP of them; never revert. NO new branch (hard rule).

## Decisions (autonomous, recorded)

1. **Design direction: refine, don't replace.** The paper/brass editorial identity is good and the
   landing brief leans on it. The "complete overhaul" = raise craft within it: hierarchy, spacing
   rhythm, affordances, empty/loading/error states, focus/hover states, consistency across routes,
   plain-language descriptions everywhere (transparency principle), responsive behavior.
2. **Licence:** add MIT `LICENSE` (per CONTRIBUTing default + open-source positioning) +
   `"license": "MIT"` in package.json, logged in docs/DECISIONS.md and flagged in the handover as
   revertable. This makes landing Order X truthful.
3. **Screenshots:** Gonçalo dropped none; capture REAL screenshots from the live app (7777 +
   own-port UIs) AFTER slices B/C land, into `site/brand/`. Copy `icon-512.png` to `site/brand/`.
4. **Serial execution.** Parallel subagent fan-out was declined by the operator this session;
   slices run serially inline. Sequencing: A -> B -> C -> D (landing last, samples final design).
5. Landing FINDING lines print at the start of slice D (before any markup), per the brief.

## Slices

| # | Slice ID | Title | Kind | Routes to (area skill) | Parallel group | Status |
|---|----------|-------|------|------------------------|----------------|--------|
| 1 | model-coherence | Faculty/fitting/capability model + terminology coherence (code, docs, seed metadata, LICENSE) | mixed | src-lib | serial-1 | passed |
| 2 | shell-overhaul | Garrison shell UX overhaul (chrome, dashboard, compose, quarters, vault, connectors) | ui | app-ui | serial-2 | passed |
| 3 | fitting-ui-coherence | Own-port Fitting UI coherence (improver restyle to Garrison tokens; audit automations/monitor) | ui | fitting-ui | serial-3 | passed |
| 4 | landing | Public landing page /site/index.html per v1 brief (FINDING lines, screenshots, i18n EN/PT-PT, 10 Standing Orders SVGs) | ui | landing | serial-4 | passed |

## Acceptance per slice

- **model-coherence**: `npm run typecheck` + `npm test` exit 0. Faculty/capability lists in
  docs/FACULTIES.md + docs/CAPABILITIES.md match `src/lib/types.ts` exactly (names + counts).
  Every seed fitting apm.yml has a coherent one-line `summary` (vocabulary: Fitting/Faculty/
  Operative/Quarters, no "component"/"primitive" in user-facing copy). LICENSE (MIT) exists,
  package.json has license field. Real model incoherences found are fixed or logged with reason
  in docs/DECISIONS.md. Committed test asserting docs-vs-types list parity.
- **shell-overhaul**: All shell routes (/, /compose, /quarters, /vault, /connectors, /memory,
  /coordination, /settings, /fitting/[id]) render without console errors; visual hierarchy and
  states improved; every faculty and fitting shows a plain-language description in Compose;
  committed Playwright e2e drives the main nav + compose search + quarters tabs; design audit clean.
- **fitting-ui-coherence**: improver UI restyled to Garrison paper/brass tokens (like kanban),
  functionality unchanged (queue, ecosystem status panel keep working; build passes); automations
  + monitor UIs audited, restyled if divergent or divergence logged with reason; committed test
  (existing improver UI tests still green + a token-presence assertion on the built CSS).
- **landing**: FINDING lines printed first; `site/index.html` single self-contained file, no build
  step; hero dictionary definition EN + PT-PT with bolded concept terms; EN default + PT toggle
  top-right (one JS dictionary); ten Standing Orders I-X each with a large inline SVG; features
  section uses real captured screenshots from `site/brand/`; palette/fonts = app tokens; NO em
  dashes anywhere in site copy; licence text matches repo LICENSE; committed Playwright driver
  asserts toggle + sections + no-em-dash; ends `LANDING-V1 OK`.

## Parallelism

Serial (operator declined agent fan-out this session). Shared runtime: one dev server (7777,
already running via launchd), one recorder, one codex exec at a time.

## Global acceptance

Tracked in `docs/autothing/runs/20260701-225923-9ece946d/evidence-index.json -> globalGate`.
Typecheck + vitest + e2e green, Codex approve + Codex PW pass per slice, design audit clean for
UI slices, verified walkthrough video per slice, `LANDING-V1 OK` printed for slice 4.

## Critical files

- `src/lib/types.ts`, `src/lib/capabilities.ts`, `src/lib/metadata.ts` — model core (slice 1)
- `docs/FACULTIES.md`, `docs/CAPABILITIES.md`, `docs/METADATA.md` — doc parity (slice 1)
- `src/app/globals.css`, `src/components/chrome/*`, `src/components/compose/*` — shell (slice 2)
- `fittings/seed/improver/ui/styles.css` + `ui/main.tsx` — divergent UI (slice 3; uncommitted
  changes present, build on top)
- `site/index.html` + `site/brand/*` — new (slice 4)

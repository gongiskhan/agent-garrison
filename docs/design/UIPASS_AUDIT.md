# WS9 — UI/UX Pass Audit

Protocol: the `redesign-existing-projects` skill (audit-first, then apply
targeted upgrades on the existing stack — no rewrites). Priority order (D12):
**(1) cut visible copy hard · (2) clearer affordances + hierarchy ·
(3) iPad/iPhone usability over Tailscale · (4) visual coherence.**

Terminology is fixed: the UI speaks in **Fittings**; the coined terms
(Garrison, Operative, Faculty, Fitting, Quarters, Armory) stay; primitive-type
words (skill, hook, MCP) never become primary user-facing labels.

## Design-system baseline (what's already good)

Garrison is **not** generic AI slop. It runs a deliberate "military-issue
paper" system in `globals.css`: warm paper `#fbf8f1`, dark ink, one sage + one
brass accent, a serif display face + JetBrains mono, square (radius-free)
surfaces, `:focus-visible` brass rings, 150ms transitions, hover/active states,
skeleton loaders, and `prefers-reduced-motion` handling. So the skill's usual
findings (Inter everywhere, purple "AI gradient", three equal cards, missing
focus rings, `#000` background) **do not apply**. The real debt is **copy
bloat**, a few **weak hierarchies**, and **touch-target / narrow-width** gaps.

Visible-copy word counts (`node scripts/measure-copy.mjs --surfaces`), BEFORE:

| surface | file(s) | words |
|---|---|---|
| shell-nav | AppShell.tsx | 86 |
| compose | StationGrid.tsx + FacultyStation.tsx | 227 |
| quarters | QuartersIndex.tsx | 70 |
| vault | VaultPanel.tsx | 225 |
| runtime-degradation | RuntimeDegradationNotice.tsx | 21 |
| tours | TourEngine.tsx | 59 |
| **TOTAL** | | **688** |

Compose (227) and vault (225) are 66% of the metric and carry the most
explanatory prose — they are the primary copy-cut targets.

---

## Per-surface findings

### Compose — overview (`StationGrid.tsx`) · heaviest

- **Copy bloat.** The header `.ld` pairs a live count with an instruction
  ("Click a tile to configure that station, or search to find Fittings across
  every Faculty") — the instruction is obvious from the tiles. The two
  `TierSection` blurbs are ~40-word paragraphs each ("The everyday operative —
  always available. Its brain (Orchestrator), Memory, the Channels you reach it
  through…"). Both banners (orchestrator-missing, capability-issues) carry a
  full explanatory sentence where a clause would do. The search placeholder
  duplicates its own aria-label.
- **Affordance.** Good: station tiles are large (min-height 108px). The search
  `clear` affordance is an 11px pill — fine on desktop, tight for touch.
- **Keep (test-load-bearing):** `<h1>`, the search `aria-label="Search Fittings
  across all Faculties"`, `data-testid="tier-section-agent"`, and the word
  **resolved** in the capabilities strip (storyboards assert `text:resolved`).

### Compose — station (`FacultyStation.tsx`)

- **Copy bloat.** The empty-Faculty state is two sentences; the alarm banner
  ("v1 of Garrison ships without a reference Orchestrator Fitting… the runner
  concatenates a minimal default") is a paragraph. The `primary_runtime` hint
  under Orchestrator global config is a 4-line essay about RUNTIMES-V1 policy.
- **Affordance.** The 4-up `Cardinality / Shapes / Selected / Verify` cell grid
  is `repeat(4, 1fr)` fixed — squeezes hard below ~420px. Clone/Edit/Remove are
  `.btn small` (~26px tall) — below the 44px touch comfort target.
- **New WS3 surface — Clone action.** The Clone button + inline error live here.
  Clear affordance, `title` explains it; error text wraps. Keep.

### Vault (`VaultPanel.tsx`) · second heaviest

- **Copy bloat (worst offender).** The header `.ld` states the full crypto spec
  (AES-256-GCM, scrypt, 0600, materialise-on-Run) — then the **same facts are
  repeated** in the "How the vault is materialised" heading + paragraph **and**
  again in the phase table below it. Three tellings of one fact. Both warning
  banners (dev-mode, no-password) are multi-sentence. The unlock card carries
  three conditional long descriptions; the empty-state is a full sentence.
- **Affordance / mobile bug.** `SecretRow` is a fixed `grid-template-columns:
  220px 1fr auto auto auto` — at 390px the 220px key column + value + three
  buttons **overflow horizontally**. The reveal/hide/remove buttons are ~24px
  (well below 44px). This is the single worst narrow-width break in the app.

### Shell nav (`AppShell.tsx` + `Sidebar.tsx`)

- **Copy.** Lean already (nav labels are single words — correct). The metric's
  86 words are mostly the CompositionSwitcher strings + code comments the
  measure counts. Minor trims available in the switcher ("switching...", the
  "(external)" option, the dismiss `title`).
- **Affordance.** `nav.tabs .item` is padding 7px 10px (~31px tall) — below 44px
  for touch. **New WS4 surface — composition switcher** is `position: fixed;
  top:10; right:14` and can overlap the crumbs / collapse control at phone
  width; its `select` is a ~28px target.
- **Mobile.** The sidebar auto-collapses to a 48px rail < 720px (good), but the
  inline `grid-template-columns` on `.app-shell` overrides the `@media 820px`
  single-column rule, so that CSS rule is effectively dead (not harmful — the
  48px rail is usable — but worth knowing).

### Quarters (`QuartersIndex.tsx`)

- **Copy.** The header `.ld` is a dense two-sentence spec of the owned/loose /
  APM model. Category-card blurbs are short (good). Trim the header to a
  one-liner; the detail lives one click in.
- **Affordance.** Category cards are generous tap targets. Runtime section
  toggles are full-width buttons (good). Solid.

### Dashboard / Run — the home page (`GarrisonHome.tsx`)

- **Copy.** Reasonable. `operativeSummary()` sentences are fine (status
  narration). The two banners duplicate the compose/vault banners verbatim —
  acceptable (context-local). Personalised greeting is on-brand.
- **Affordance.** Primary Run button is a good size; Stop is `.btn danger`.
  `dash-stats` and `dash-panels` already reflow responsively. Strong surface.

### RuntimeDegradationNotice (`RuntimeDegradationNotice.tsx`) · new WS2

- **Copy.** 21 words, already tight. The intro sentence ("This composition runs
  a non-Claude primary runtime. The enforcement plane degrades to advisory…")
  can shed a clause. Renders nothing on Claude Code (correct — no empty state).
- **Affordance.** Advisory left-border card, non-blocking. Good.

### TourEngine overlay (`TourEngine.tsx`) · new WS6

- **Copy.** 59 words, mostly control labels (Exit / Done / Continue / Next) and
  the "Do the highlighted action to continue" hint — all necessary. Little to
  cut without hurting the guided flow.
- **Affordance.** Caption card `maxWidth: calc(100vw - 32px)` (mobile-safe);
  buttons are 6px 14px (~30px). Spotlight tracks scroll/resize. `role="dialog"`,
  `aria-live`. Escape exits. Well built; keep copy, nudge button height.

### garrison-assistant view · new WS5 (own-port Fitting)

- Separate pre-built Vite app (`fittings/seed/garrison-assistant/dist`). Out of
  the Next.js copy metric. Reached from the sidebar Views list. No changes in
  this pass (would require rebuilding its own bundle + tests); noted for parity.

### Kanban board · own-port Fitting (`fittings/seed/kanban-loop/ui`)

- Separate Vite app. **Good pattern already**: short chip labels with
  progressive-disclosure `title` tooltips (project, route, work-kind, fences).
  A few tooltips are over-long (the engine-owned explanation). Uses `.btn small`
  (small touch targets) in its own CSS. Out of the shared-CSS blast radius, so
  its touch sizing is independent — noted, not changed this pass.

### Dev Env · own-port Fitting (`fittings/seed/dev-env/ui`)

- Separate Vite app: tabbed Claude/Shell/Browser panes with a phone-width
  `.segmented[aria-label="Pane"]` switcher (already mobile-aware — the
  responsive-mobile storyboard exercises it). Out of the metric; no change.

### Improver / Monitor · own-port Fittings

- Improver: "Improver — Review Queue", minimal chrome. Monitor: PID tree, mono,
  small `close`/`link` buttons. Both separate apps, out of the metric. Noted.

### Per-Fitting routes (`/fitting/[fittingId]`, promoted detail, own-port views)

- `FittingOverview` / `PromotedFittingDetail` / `FittingView` under the Next.js
  app share the design system and the shared CSS, so the touch-target CSS
  upgrade reaches them. Copy is data-driven (Fitting summaries), not prose —
  little standalone bloat.

---

## Apply plan (this pass)

**Copy cut (priority #1) — the 6 measured surfaces, heaviest first:**

1. **Vault** — collapse the three-times-told crypto story into one header
   one-liner; the phase table keeps the detail. Trim both banners and the
   unlock-card descriptions to a clause each; one-line the empty state.
2. **Compose** — header `.ld` to a count-only line; both `TierSection` blurbs
   to one short line; trim both banners; drop the placeholder's duplicated prose
   (aria-label carries the meaning). FacultyStation: one-line the empty state,
   alarm banner, and the primary_runtime hint.
3. **Shell-nav / Quarters / runtime-degradation** — trim the switcher strings,
   the Quarters header, and the degradation intro clause.

Target: a clear reduction, aim ≥15–20% off 688 (→ ≤ ~580).

**Affordances + mobile (priority #2–3), shared CSS + targeted fixes:**

4. Add a `@media (pointer: coarse)` block raising `.btn`, `.btn.small`,
   `nav.tabs .item`, `input.text`/`select.text`, and small icon buttons to a
   ≥44px comfortable tap target — reaches every Next.js surface at once.
5. Make the Vault `SecretRow` grid reflow (stack) below ~560px so it stops
   overflowing at 390px.
6. Make the FacultyStation 4-up cell grid reflow to 2-up on narrow widths.

**Keep green:** no testid/aria-label/`#composition-switcher`/`text:resolved`
churn; if any storyboard/tour asserts changed text, update the fixture.

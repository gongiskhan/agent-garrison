# S6 / WS6 - In-app tour engine (demo + guided)

One engine, two players, built on the existing `.walkthrough` storyboard
vocabulary. The storyboard driver is capture-bound (Playwright + screencast), so
this is a NEW DOM-side executor on the SAME schema subset - it resolves the live
DOM and overlays a spotlight instead of recording a video. No new npm deps
(nothing added to `package.json`); no react-joyride/shepherd/driver.js.

## Descriptor schema (subset of the storyboard schema)

```
{ name, title, route, fitting?, mode?, steps: [
    { id, caption, selector, action?, assert?, spotlight? } ] }
```

- `selector` uses the SAME mini-language as storyboards, ported to a DOM
  `querySelector` resolver in `src/lib/tour-selector.ts`:
  `button: link: text: label: placeholder: testid: role:<r>:<name> raw-css:` and
  a bare (prefix-less) string = raw CSS.
- `action` (demo): `{ type: click|fill|select|navigate, value?, path? }` performed
  on the step's resolved element (`navigate` drives the router).
- `assert` (guided gate): `{ selector?, text?, state?, url? }` where
  `state ∈ visible|enabled|disabled|checked|expanded` and `url` gates on
  `location.pathname.startsWith(url)`. Requires a selector OR a url.
- Parsed by `src/lib/metadata.ts` as an OPTIONAL `x-garrison.ui.tours[]` block
  (additive - manifests without it are unaffected).

## The two players (one engine)

`src/components/tours/TourEngine.tsx` is mounted once in the app shell
(`AppShell`). It watches the URL for `?tour=<name>&mode=demo|guided`, loads the
descriptor from `/api/tours/<name>`, navigates to the tour's `route` if launched
elsewhere, resolves + tracks the current target, and renders the overlay: a
dimmed backdrop with a box-shadow **spotlight cutout** + ring on the target, a
**caption card**, a **step counter**, and controls. Escape or Exit tears it down
and strips the URL params. No emoji (text + inline styles only).

- **DEMO** (`mode=demo`): auto-advances. For each step with an `action` it
  resolves the target, performs the action (amber "operating" ring), holds, then
  advances. Auto-closes after the final step.
- **GUIDED** (`mode=guided`, the default): spotlights the target and WAITS.
  It polls the step's `assert` against the live DOM/route and only advances when
  it passes; a Skip control advances an assert-gated step manually, Continue
  advances an informational (assert-less) step.

Player decision logic is extracted to pure, DOM-free helpers in
`src/lib/tour-machine.ts` (`initTour/advanceTour/isComplete`, `planDemoStep`,
`runDemoSequence`, `shouldGuidedAdvance`) so it is unit-testable in the node env
(the repo has no jsdom/RTL).

## Tours registry

`src/lib/tours-registry.ts` discovers tours from three sources (precedence:
explicit wins over synthesized), de-duplicated by name:

1. inline `x-garrison.ui.tours[]` metadata on a fitting;
2. `tours/*.json` beside a fitting AND a repo-root `tours/` dir (shell /
   cross-surface tours not owned by a single fitting);
3. a synthesized "what is this" default (one spotlight step) for every fitting
   with a UI surface (`ui.views`) that ships no explicit tour.

Sources are the union of the curated library + the raw `fittings/seed/*` dir
(dedup by id), so a UI seed fitting not listed in `library.json` (vault-sync) is
still covered. Parked pre-pivot seeds whose faculty the parser rejects
(documents/tier-classifier) are correctly excluded. API: `GET /api/tours`
(summaries), `GET /api/tours/<name>` (descriptor, 404 clean).

## Tour list (where they live)

Authored tours live as `.walkthrough`-style JSON under the repo-root `tours/`
dir; per-fitting defaults are synthesized. Live `/api/tours`:

| name | fitting | route | mode | source |
|------|---------|-------|------|--------|
| compose-demo | compose | /compose | demo | tours/compose-demo.json |
| quarters-guided | quarters | /quarters | guided | tours/quarters-guided.json |
| switch-composition | shell | / | guided | tours/switch-composition.json |
| file-browser-overview | file-browser | /fitting/file-browser | guided | synthesized |
| garrison-assistant-overview | garrison-assistant | /fitting/garrison-assistant | guided | synthesized |
| snapshots-default-overview | snapshots-default | /fitting/snapshots-default | guided | synthesized |
| vault-sync-overview | vault-sync | /fitting/vault-sync | guided | synthesized |

## Two acceptance tours

- **Demo on Compose** (`compose-demo`, `/compose`): spotlights the page heading,
  then the agent-tier section, then FILLS the cross-faculty search with
  "orchestrator" (the real onChange fires - the app filters and the URL gains
  `&q=orchestrator`). Steps are ordered so the tier spotlight precedes the fill
  (filling replaces the tier sections with search results).
- **Guided on Quarters** (`quarters-guided`, `/quarters`): spotlights the first
  runtime section toggle and WAITS; the user clicks to expand it, the engine
  validates `aria-expanded=true` (assert `state: expanded`) and advances to the
  category cards. Targets the multi-runtime section toggle (live Quarters is
  multi-runtime on this box).

## Assistant wiring (D6)

`fittings/seed/garrison-assistant/lib/tours.mjs` `launchTour(name)` returns
`url: <route>?tour=<name>&mode=<mode>` (guided default, demo when the tour's mode
is demo). The engine reads that param on any route and navigates to the tour's
route. SEED names match the tours the engine serves (compose-demo,
quarters-guided, switch-composition), so a launch always resolves.

## Tests (committed, re-runnable)

- `tests/tour-selector.test.ts` (23): parseSelector every prefix + bare CSS;
  resolveSelector (css/testid/button-by-name/text-deepest/label-for) via a fake
  DOM; elementMatchesAssert (text/expanded/enabled); evaluateAssert (url + selector
  gate); performAction (click/fill+events/navigate no-op); state machine.
- `tests/tours-registry.test.ts` (10): ui.tours metadata parse (additive,
  no-steps reject, assert-without-selector-or-url reject, non-kebab reject);
  registry discovery of the acceptance tours; synthesized-default invariant for
  every UI fitting; seed-only coverage (vault-sync); unknown-name; summaries.
- `tests/tour-demo.test.ts` (5): planDemoStep + runDemoSequence (visit order,
  action dispatch order, navigate routing, unresolved-element skip).
- `tests/tour-guided.test.ts` (4): shouldGuidedAdvance (assert-less waits,
  selector+state gate, url gate) + an assert-gated advance loop to completion.

Total: 42 tour tests green. tsc 0, lint clean on touched files.

## Live smoke (Playwright over the running app at 127.0.0.1:7777)

17/17 checks pass: demo navigates /->/compose, spotlights the heading + tier
section, performs the fill (search="orchestrator"), auto-advances 1/3->3/3,
auto-closes and strips `?tour`; guided spotlights the section toggle, WAITS (no
auto-advance), advances to 2/2 only after the user's click validates; Escape
tears down both cleanly. Screenshots captured (demo-step1/step2/fill,
guided-step1/step2, switch-comp). switch-composition verified separately
(spotlight -> Continue -> Done -> Escape).

## Commits

- 969a19c D1 - descriptor schema + DOM selector resolver + registry + tests
- 1bdd1a4 D2 - engine + overlay + API routes, mounted in AppShell
- 4c3b285 registry seed-dir scan (every valid UI seed fitting ships a tour)
- d5cbd26 D3+D4 - demo + guided player logic tests
- 73bbd8b D5 - reorder compose-demo (tier spotlight before search fill)
- 2d2a08c D6 - Assistant Guide launches the tours by name with mode (teammate)
- ef04f76 D5 - switch-composition tour + em-dash cleanup

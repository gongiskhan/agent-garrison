# S1 Independent Functional Test — VERDICT: PASS

Fresh-context adversarial test. Tester wrote its own probe (no reuse of any
existing storyboard/test) and drove the live app at http://127.0.0.1:7777.

- Probe script: `docs/autothing/runs/20260712-173530-81e1c448/slices/S1/probe.mjs`
- Screenshot: `docs/autothing/runs/20260712-173530-81e1c448/slices/S1/skills-surface.png`
- App code modified: NO (read-only probe)

## Acceptance criterion
The Quarters skills surface must show two skills — `design-taste-frontend` and
`redesign-existing-projects` — each in OWNED state, owned by the fitting `taste`.

## Result: 13/13 assertions PASS

### API — GET http://127.0.0.1:7777/api/quarters
| Assertion | Result | Observed |
|---|---|---|
| HTTP 200 | PASS | `GET /api/quarters -> 200` |
| `design-taste-frontend` record present | PASS | `id=skill:design-taste-frontend`, `surface=skill` |
| `design-taste-frontend` state | PASS | `state="owned"` |
| `design-taste-frontend` fittingId | PASS | `fittingId="taste"` |
| `redesign-existing-projects` record present | PASS | `id=skill:redesign-existing-projects`, `surface=skill` |
| `redesign-existing-projects` state | PASS | `state="owned"` |
| `redesign-existing-projects` fittingId | PASS | `fittingId="taste"` |

### DOM — /quarters/skills rendered in a real Chromium browser
| Assertion | Result | Actual rendered row text observed |
|---|---|---|
| `design-taste-frontend` name rendered | PASS | present in page text |
| `design-taste-frontend` row shows OWNED | PASS | `"design-taste-frontendtaste OWNED Edit Park"` |
| `design-taste-frontend` row shows owner `taste` | PASS | `taste` present in row |
| `redesign-existing-projects` name rendered | PASS | present in page text |
| `redesign-existing-projects` row shows OWNED | PASS | `"redesign-existing-projectstaste OWNED Edit Park"` |
| `redesign-existing-projects` row shows owner `taste` | PASS | `taste` present in row |

## How the UI conveys state (observed, not assumed)
Each skill is a row container keyed `data-testid="primitive-skill:<id>"`. The
OWNED state renders as a `<span class="pill verified">owned</span>` badge
(displayed uppercased "OWNED" via CSS). The owner fitting `taste` renders inline
next to the skill name. Both target skills sit in the `data-testid="primitives-skills"`
section; surrounding skills correctly render as `LOOSE` with Promote/Remove
actions, confirming the OWNED/owner distinction is real and not blanket-applied.

## Note on process (honesty)
My first probe run reported 2 DOM FAILs on the "shows-owned" checks. On
investigation this was a probe heuristic bug — my row-climbing loop stopped one
DOM level short of the pill. I inspected the live DOM directly, confirmed the UI
genuinely renders the OWNED pill + `taste` owner in the row container, fixed the
probe to select the `primitive-skill:<id>` row, and re-ran. Final run is a clean
13/13. The app was never at fault; no app code was changed.

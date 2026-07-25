# FLOW_PLAN — Drill run-results overhaul

Run `20260725-030300-3a7ac388` · profile **build** · branch `main`

## Problem (evidence-backed, run `01KY4DREZ1VD3Z1JT59P0PKZP0`)

| # | Symptom | Root cause | Evidence |
|---|---|---|---|
| 1 | Video is minutes of a static page | Playwright records continuously, zero post-processing; each check spends ~40s in an untimed vision call with the page frozen | 24.6 of 27.3 min is inter-frame dead time; `grep ffmpeg` in drill+browser-default = 0 hits |
| 2 | Check evidence doesn't show the asserted state | A check compiles to `[navigate, verify]` — **no interaction vocabulary exists**. `reachPath` only fires for non-default states; every real book has `states: []` | `lib/compile.mjs:199-211`; `step-chat--composer-shift-enter-newline--desktop.png` shows an empty composer |
| 2b | Green checks are false confidence | Vision judges a behavioral claim from a static frame, passes on the visible fragment, then **graduates** that fragment into a committed spec | emitted `chat.spec.ts`: `goto` + `toContainText("Shift+Enter para nova linha")`, no keypress |
| 3 | Debrief step text unreadable | `white-space: nowrap` + ellipsis on a sentence-long description in a ~190px column (~30 chars); `title` attr shows the id, not the description | `ui/styles.css:782`, `ui/main.tsx:3142` |
| 4 | Debrief "no screenshots" | Curation budget 30 frames, `selectCurationCandidates` takes phash frames in **time order first** → first ~30 all in the first 8 checks → 28/36 checks got zero candidates; then 1/2 batches failed silently; prompt is drop-biased | `reel.json` counts `{frames:173, candidates:30, curated:18, reel:3, uncurated:155}`, `failedBatches:1` |
| 5 | (found) Frames attributed to the wrong check | `step-start` spotter frame fires at `captureChunkStart` **before** the navigate → shows the previous check's page under this check's chunk | `scripts/server.mjs:1344` vs navigate at engine step 1 |
| 6 | (found) Repaired checks serve mismatched evidence | fixer retry overwrites `step-<NNN>.jpg`; `resolveStepOutcome` uses `.find()` (first) while `readStepEvidence` uses `.reverse().find()` (last) | `server.mjs:252`, `automations/lib/store.mjs:142` |

## Operator decisions (2026-07-25, answered)
- **Honesty gate:** auto-author actions where inferable from the description; anything still unproven becomes a distinct **non-green `unproven` state**, never a pass.
- **Scope:** everything, presentation first.

## Slices

| id | title | kind | acceptance | status |
|---|---|---|---|---|
| S1 | Video tight-cut + chapter remap | mixed | `video-tight.webm` + `video-index.json` produced post-run; ≥70% dead time removed; chapters land on the right check; graceful no-ffmpeg degradation; UI defaults to tight with a Full toggle | pending |
| S2 | Curation reel floor + failure resilience | api | every scope has ≥1 frame; per-chunk budget allocation; failed batches retried once then recorded; `curationPending` can no longer stick forever | pending |
| S3 | Debrief legibility + honest empty states | ui | full description readable (wrapped, id-prefixed, real tooltip); empty state reports curation health | pending |
| S4 | Frame attribution + evidence integrity | api | `step-start` frame no longer mis-tagged; repaired-check metadata and bytes agree | pending |
| S5 | Interaction engine (per-check `actions`) | mixed | a check can carry ordered actions; compiled as `browser` steps before verify; emitted into the committed spec; evidence captured after actions | pending |
| S6 | Honesty gate + action auto-authoring | mixed | behavioral claim with no evidenced interaction → `unproven`, excluded from pass counts, graduation blocked; planner infers actions where it can | pending |

Presentation (S1-S4) lands first; correctness (S5-S6) second.

## Verification anchor
Re-run the drill against ekoa-code and compare against this run's baseline:
27.3 min video / 3 reel frames / 36 zero-interaction checks.

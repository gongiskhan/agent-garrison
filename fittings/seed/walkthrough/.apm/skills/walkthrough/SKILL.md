---
name: walkthrough
description: Record a short, narrated, captioned video walkthrough that proves a finished coding task and shows how it behaves, then self-verify the video via vision on extracted frames and publish it as one scrubbable Tailscale link. Use after completing a change/fix/feature on a web project (Next.js/React etc.) when the user wants visual proof of work, a demo of a user flow, or to avoid manually retesting and watching a long raw screen recording. Triggers on requests like "record a walkthrough", "show me it working", "make a demo video of this", "prove the feature", or finishing a UI/route/form/API change worth demonstrating. Not for walking through a full from-scratch project build.
---

# Walkthrough recorder

Produce ONE stitched, captioned MP4 that demonstrates a finished change, then **prove it is correct by viewing extracted frames before handing over**. You cannot watch video — the self-verification loop is mandatory, not optional.

## No terminals on camera — show rendered EVIDENCE, never typing
A video of a shell being typed into is worthless as proof and unusable in a public walkthrough. **Never record a terminal, a shell prompt, or commands being typed/run on camera.** The audience is a human who wants to *see the thing work* and, later, a website visitor watching this as a product walkthrough. When the proof lives in a file, an API response, a log, or a command's output, use an **`evidence` segment**: the command (if any) runs OFF-camera and the video shows only the captured **result** as a clean titled panel, with the **proving line highlighted and annotated**. Opening a file and pointing at the line that proves the change is good; recording yourself typing `cat`, `curl`, or `tail` to get there is not. (There is no `terminal` segment anymore — legacy ones auto-migrate to a panel, with a warning.)

## Proof means behavior — test runs are BANNED from camera
A passing test suite is not proof that anything was implemented, and the user never wants to watch one. **Never show a test runner or test results** — no `npm test`, `vitest`, `jest`, `pytest`, `playwright test`, `go test`, `cargo test`, coverage output, or CI logs, ever, in any beat. `record.mjs` refuses storyboards whose evidence `command` matches a test runner; do not try to work around it. Proof is the feature **visibly doing the thing in the running app**: drive the real UI, show the real data persisting, show the live endpoint's actual response and the real log line in an evidence panel. If you cannot demonstrate the change as observable behavior, say so and ask — do not substitute a test run.

## Two layers of truth (never collapse them)
- **Functional truth** — Playwright `assert`s during recording confirm the feature actually did the thing (and highlight the asserted element as the "verified result" beat); an evidence panel's `highlight.match` is the same kind of check on captured output (the proof string must really be present, or the beat fails). These are inline checks on the live app/real output — not a test suite, and nothing test-shaped appears on screen.
- **Communication truth** — you read extracted frames and confirm the video *shows and labels* the right thing. Vision cannot confirm business correctness, so both layers are required. Communication truth is checked TWICE: per-beat (each frame, step 6) **and** holistically (does the whole video tell the real end-to-end story — step 7, the claude-video gate).

## Mode — `marketing` (default) vs `evidence`, selected by parameter, never inferred
This skill runs in one of two modes, chosen ONLY by an explicit **`mode`** parameter — it is **never** inferred from the change, the repo, or the caller.
- **`mode: marketing` (DEFAULT)** — the full storytelling walkthrough described in every step below: story-arc flow selection, 10–20+ beats, 3200–6000 ms holds, intro/outro title cards, **both** vision gates (per-beat step 6 **and** the holistic claude-video gate step 7), and up to 6 re-records. **A standalone invocation is always marketing** unless the caller explicitly passes `mode: evidence` — standalone behavior is exactly as it is today.
- **`mode: evidence`** — a lean per-criterion proof pass for an automated build gate (see **Evidence mode** below). **`autothing-walkthrough` ALWAYS passes `mode: evidence`** (plus the slice's acceptance-criteria list); nothing else selects it.

Everything in the **Workflow** below is the marketing default. Evidence mode keeps the same machinery and every honesty rule but overrides only the beats named in **Evidence mode** — the two never mix, and the default is untouched.

## Workflow

### 1. Preflight (first run on a machine)
Run `scripts/preflight.sh`. It checks node/ffmpeg/playwright-cli/**claude-video** and reports the Tailscale IP. Install anything missing before continuing. **claude-video (the `/watch` skill) is required** — it powers the holistic review gate (step 7); install once with `/plugin marketplace add bradautomates/claude-video` then `/plugin install watch@claude-video` (or point `WALKTHROUGH_WATCH_PY` at an existing `watch.py`).

### 2. Read project memory
- Read `.walkthrough/config.json` and `.walkthrough/notes.md` in the target repo. If absent, create them from the templates in `references/storyboard-schema.md` (ask the user for `baseURL`/`startCommand` if not obvious from `package.json`).
- **`notes.md` drives flow selection** — honor it (which flows matter, caption language, what to always show, what to avoid on camera).

### 3. Make the app reachable
- Start the app with `config.startCommand` if it is not already running (background it; never block the terminal; use the project's configured port). Confirm `baseURL` responds.
- **Auth**: if the app needs login, use a stored session instead of typing credentials on camera. Establish it ONCE, off-camera:
  `playwright-cli open <baseURL/login>`, drive the login (and any forced password-change) by hand or with playwright-cli, then `playwright-cli state-save .walkthrough/auth.json`. Reference it as `authState` on the browser segment. Add `auth.json` to `.gitignore`. Never put tokens or `.env` contents in an evidence `command` or its output.

### 4. Choose flows: tell the feature's REAL story, end-to-end
**A walkthrough is a story, not a screen tour. Show *why the feature exists and how it is actually used*, from the real starting point to the real payoff — the whole arc a developer needs to believe it works.** The arc is almost always: **starting point → the action that exercises the feature → it actually running → the REAL result/artifact → (where it applies) a follow-up change and its effect.** A video that stops at "the page renders" or skips the payoff has failed this step, no matter how clean each frame is.

- **Worked example — a build on Ekoa.** Don't record "the build page exists." Record the journey: **start a new conversation → submit the build request → show the first few seconds while it's building → skip the minutes it churns → show the COMPLETED artifact → make another change → show the change take effect.** That is the story; anything less doesn't show what the feature is *for*. Apply the same arc to any feature: a form → the created record surviving a reload; a router change → the request visibly routed differently; an importer → the imported data rendered.
- **Long-running operations are first-class — never fake or omit them.** When the feature kicks off something slow (a build, a generation, a job), do NOT cut to a pre-baked result and do NOT sit through dead minutes on camera. Keep ONE live session and either **timelapse** the wait or **cut** it (see step 5: `continue` + `speed` or `waitBefore`, with a "≈ N min later" title card). Show enough of the start that the viewer sees it genuinely running, then the genuine finished artifact from that same run.
- **First, look for a demo the project already ships and prefer it** — a demo/tour/showcase route or hash-route, a `demo`/`seed`/`story`/`tour` script in `package.json`, seeded demo data, a Storybook, a README "Demo" section, or a flow named in `.walkthrough/notes.md`. If one exists, record THAT exact path. Do not synthesize a generic flow that ignores an obvious built-in demo — the user wants to see the real thing working, not a stand-in.
- **Default to comprehensive, end-to-end coverage — not a teaser.** Demonstrate the actual feature the task delivered, all the way through, with **real data that persists** (create a record → see it in the list → reload → it survived). Walk **every meaningful state**: empty → action → in-progress → populated → verified. Click into each tab, switch a selector and show the result change, scroll the whole table, drive a second flow if the feature has one. There is **no beat cap and no duration cap** — a thorough walkthrough is commonly 10–20+ beats and several minutes, and that is the goal, not something to trim. A video that "only proves a page renders" is a failure of this step.
- **Organize by `folder`, and make MORE videos.** Set the storyboard's `folder` to the feature area (e.g. `"model-router"`, `"improver"`, `"runtime/codex"`). When a topic is broad, record **several focused videos into the same folder** — one clear flow each — rather than one shallow video that skims everything. The gallery groups by `<project> / <folder>`.
- **Hold long enough to read.** `hold` defaults to 3200 ms; for dense screens (policy tables, populated lists, JSON output) set `hold` to 4000–6000 so the viewer can actually absorb it. Long single browser segments are fine (up to 600 s; override with `runTimeoutMs`) and read as one real session.
- In each video include, where the feature allows: a real click, a route/tab change, a selector change that visibly remaps something, an **evidence panel** proving the live system state (the actual API response, the persisted record in a file, the real server log — captured off-camera, proving line highlighted), and a full e2e flow ending in an asserted/highlighted result. Add an intro title card (`reflectFlag: true`) and an outro.
- **When the proof IS the network traffic** (server-side pagination, a persist POST, a route re-targeting a backend) and the user wants to "see the network / network tab", a viewport recording can't show DevTools — attach a browser-segment **`networkPanel`** instead: a live top-right HUD that re-paints each matching `request`/`response` (page/size → status/rows) from the real Playwright events. See `references/storyboard-schema.md` → "Network panel". This is the supported fallback for network-tab requests.
- **CRITICAL: no terminals, no test runners on camera.** Never record a shell or typing; show a rendered `evidence` panel (off-camera capture, proving line highlighted) instead. And no `npm test`, `vitest`, `jest`, `pytest`, `cargo test`, test output, or CI logs — ever. If the feature can only be "proven" by a passing test, ask the user instead of recording the test. The walkthrough must show the feature **visibly doing the thing in the real running app**, not a test passing.
- Write `storyboard.json` per `references/storyboard-schema.md`. For each beat set the exact `caption` and a concrete `expectedScreen` ("the automations list with a New automation button") — these become the vision assertions.
- Order beats so pages that embed a **cross-origin iframe** (e.g. an embedded terminal pane) land last — the caption HUD can intermittently render as an empty gray strip on those pages, and sequencing them last keeps every earlier caption clean.
- **Settle every freshly-loaded page BEFORE its first caption beat.** On a page that is still loading, the caption HUD can miss the first beat entirely, and fixed-wait beats tend to capture loading states (spinners, skeletons) instead of the ready page. Make a settle action the storyboard default: start each freshly-loaded page with a `waitFor` on a selector that only exists once the page is ready, and only then run the first captioned beat. Prefer selector waits over fixed waits throughout.
- **Pages with persistent WebSocket connections** (WS-action pages, live-stream views, chat panels) are unreliable recording targets: the open WS connection defeats the between-beat `networkidle` settle, causing empty-output crashes or >120 s hangs. Workaround: pre-seed any needed state via API/HTTP before the recording (avoid WS-action beats entirely where possible), or accept the committed e2e as the gate for WS-heavy flows and record only the HTTP/static surfaces of the same feature.

### 5. Record
`node scripts/record.mjs <storyboard.json>` → prints `{ runDir, final, beats, flagged }` and writes `manifest.json` (measured beat→timestamp map) + `pass-record.json`.
- **Concurrent runs are isolated automatically.** Each run gets its own private playwright-cli daemon namespace (derived from its run dir), so you can record from several sessions/projects at once without them tearing down each other's browser. You do not set anything — no `WALKTHROUGH_PW_SESSION`, no `kill-all`. (Never run `playwright-cli kill-all` during a recording: it is machine-wide and will kill every concurrent run's browser.)
- The recorder automatically shows a **visible cursor + click pulse** at every click/fill/hover and **scrolls each target into view before highlighting it** — so the video reads as a real user session and the "verified result" box always lands ON the element, never off-screen. You do not author these; do not add them to the storyboard.
- **Long operations, kept honest in ONE live session** (full schema in `references/storyboard-schema.md`):
  - `continue: true` on a browser segment **reuses the session the previous segment left open** — same page, same live state — so an operation kicked off earlier is still running. (The first segment can't `continue`.)
  - **Timelapse** the wait: a `continue` segment with `speed: 8` records the real progress, then compresses it 8× (offsets are scaled, so the manifest stays accurate). Pair with a beat `holdUntil: { selector }` that keeps the "Building…" caption rolling until the completion signal appears.
  - **Cut** the wait: a `continue` segment with `waitBefore: { selector }` waits for completion OFF-camera (unrecorded), then rolls on the finished result. Bridge the jump with a `title` card like `"≈ 3 minutes later"`.
  - Bump `runTimeoutMs` (and the `waitFor`/`holdUntil` `timeout`) above the real operation time for genuinely long builds.

### 6. Extract frames + VISION-VERIFY (the gate — do not skip)
`node scripts/extract_frames.mjs <runDir>` → one frame per beat at its measured midpoint (`frames/index.json` lists each frame with its `expectCaption`/`expectScreen`).

Then **Read every beat frame** and assert, per beat, concretely:
- the caption reads exactly `expectCaption` and is legible, AND
- the screen matches `expectScreen` (name the specific thing you see — "the automations list with a New automation button", not "looks right").
- for `expectFailure` beats: confirm the failure is shown distinctly (red "FAILED" caption) and the run is flagged. A correctly-shown failure **passes** — do not try to "repair" it.

On any mismatch: identify the failing beat, diagnose the cause (caption text, a missing `waitFor`, a wrong selector, an unsettled animation, timing), fix the storyboard, **re-record**, re-extract, re-verify. Add `--interval` on a re-run if you need frames between beats to localize a problem.

**Retry ceiling**: max 3 attempts on the same beat, max 6 re-records total (shared with step 7). If still failing, STOP — write `STUCK.md` in the runDir with the failing frame path, the expected vs. observed, and what you tried, and ask the user. Never hand over while any expected caption or screen is unverified, and never fake success.

When all beats pass, proceed to the holistic gate (step 7) — **do not set `verifiedAt` yet.**

### 7. Holistic video review — the SECOND gate (claude-video; do not skip)
The per-beat gate proves each frame is right; it cannot tell whether the **whole video shows the real feature end-to-end** (the step-4 arc). This gate does — by actually watching the finished video.

`node scripts/review_video.mjs <runDir>` → locates claude-video, ingests `final.mp4` (silent → `--no-whisper`) into `<runDir>/watch/`, and prints a strict 5-point rubric plus the frames the tool produced.

Then **Read those frames in order and answer the rubric**: does the video show the real starting point, the action, it actually running, the REAL result, and (where it applies) a follow-up change? What essential part of the story is missing or only implied? Any dead/blank/broken stretches or success-faked failures?
- **PASS** only if a developer who never saw this feature would, from this video alone, understand what it does and see it genuinely working end-to-end.
- **FAIL** → treat it exactly like a failed beat: name the gap (a missing arc step, a skipped payoff, an unshown follow-up change, a dead stretch), **re-plan the storyboard** (add/extend the flow — often a `continue` result/change segment or a long-op timelapse), **re-record, re-verify both gates.** Same retry ceiling as step 6.

Only when BOTH gates pass, set `verifiedAt` (ISO timestamp) in `pass-record.json`.

### 8. Publish
Ensure the gallery server is running: `node scripts/serve.mjs` (binds to the Tailscale IP, supports range/scrubbing). It prints `{ url }`. The gallery is a single page: it groups runs by `<project> / <folder>`, shows real video thumbnails (ffmpeg, cached as `thumb.jpg` per run) with formatted dates, and supports live **search**, **sort**, project/status **filters**, and a group toggle. Clicking any card opens an **in-page fullscreen player** — navigate between videos with the on-screen arrows, the **keyboard arrows**, or a **swipe**, jump around with **chapter markers** built from the beat captions, and download from the same view. Give the user that gallery URL (newest folder first) — or the direct `http://<tailscale-ip>:8099/<project>/<folder>/<timestamp>/final.mp4` (no `<folder>` segment for an ungrouped run; direct links still work as before). Confirm range works locally if unsure: `curl -s -D- -o /dev/null -H 'Range: bytes=0-99' <url>` → expect `206 Partial Content`. Optional HTTPS upgrade: `tailscale serve --bg <port>`. When you record several videos, give the gallery URL once and list each video's direct link under its folder.

### 9. Learn
If the user corrects flow choice, captions, or what to show/avoid, **append a dated bullet to `.walkthrough/notes.md`**. Flow selection is the part that improves with use — say so in your handover.

## Evidence mode (`mode: evidence`)
Evidence mode records lean, per-criterion proof for an automated gate — not a story. It **keeps every honesty rule and every mechanic** and overrides only what is named here; the marketing default (all of **Workflow** above) is unchanged.

- **Storyboard derives from the slice's ACCEPTANCE CRITERIA, not a story arc** — **one beat per acceptance criterion**, plus the minimal navigation needed to reach each. Step 4's "tell the feature's REAL story, end-to-end" **does not apply**: there is **no comprehensive-arc mandate**, **no intro/outro title cards**, and **no "make MORE videos" / several-focused-videos guidance** — one criterion, one beat.
- **Short holds, terse captions.** `hold` defaults to **1200 ms** (dense screens **2000 ms**), not 3200–6000. Each caption is **terse — the criterion id plus a short phrase** (e.g. `AC-3 — record persists after reload`).
- **Kept UNCHANGED — behavior is still the proof.** No test runners on camera (a passing suite is never the evidence); the **`evidence` panels**; the **functional-truth `assert`s** (and an evidence panel's `highlight.match`); the **visible cursor + click pulse, settle-before-caption, and `waitFor`/selector-wait** mechanics; and the **per-beat vision verification (step 6)**. Evidence mode weakens none of these.
- **Skip the holistic claude-video gate (step 7).** Evidence does not need storytelling verification — **per-beat vision (step 6) plus the inline functional asserts ARE the gate.** (Marketing mode KEEPS both gates.)
- **Retry ceiling: 1 re-record** (not 6). If, after that single re-record, a beat still fails on a **caption/legibility** ground **while its functional `assert` PASSED**, do NOT keep chasing polish — record the video as **`evidence-degraded`** in `notes.md`/status with the reason. An honest degraded artifact beats six re-records over legibility. (A failed functional `assert` is still a real failure — render it honestly per **Honesty**, never faked green.)
- **Emit `evidence.json` next to the video** — an array of `{ beat, criterionId, timestamp, assert, result }`, one entry per beat, referenced from the gate-status / evidence-index so a reviewer verifies each criterion **against the JSON without watching the video**.
- **Long operations carried as-is** — the `continue` / `speed` / `waitBefore` timelapse-or-cut machinery from step 5 applies unchanged, with `speed` defaulting **aggressive (8×)**.

## Honesty
If something does not work, show it not working (mark that beat `expectFailure: true` → red "FAILED" caption) and let the run be flagged in the gallery. Never edit a failing flow into looking like it passed.

## Reference
- `references/storyboard-schema.md` — full storyboard/config/notes schema, segment types, selector language, manifest shape.
- `references/decisions.md` — the tool bake-off and why each choice was made (and its limits).

# FINDING-E9 — `.walkthrough` storyboard schema, driver, and in-app reuse

Explored: `/home/ggomes/dev/garrison` (repo, incl. `.walkthrough/`) and
`~/.claude/skills/walkthrough/` (the `walkthrough` skill). Facts + file:line below.

## Q1 — The `.walkthrough` storyboard schema

**Where defined/documented.** Schema doc: `~/.claude/skills/walkthrough/references/storyboard-schema.md`.
Enforced implicitly by the reader `~/.claude/skills/walkthrough/scripts/record.mjs`
(parse at `record.mjs:29`) and the browser executor
`~/.claude/skills/walkthrough/scripts/lib/browser.mjs`. No JSON-Schema/Zod validator —
shape is enforced by the two scripts.

**Top-level storyboard fields** (`storyboard-schema.md:51-60`; defaults `record.mjs:100-110`):
`title`, `project`, `folder` (optional; organizes output gallery, `record.mjs:104-110`),
`video {width,height,fps}` (default 1280x800x30, `record.mjs:100`), `calibrationMs`
(default 0, `record.mjs:101`), `segments[]` in play order.

**Three segment types** (dispatch `record.mjs:142-193`):

1. **`title`** (`storyboard-schema.md:72-76`): `type,id,text,subtitle,duration,reflectFlag`
   (reflectFlag → red "RUN FLAGGED" badge if any beat failed).
2. **`browser`** — one continuous screencast (`storyboard-schema.md:78-141`; cfg
   `browser.mjs:26-57`). Segment fields: `id,baseURL,startPath,authState,beats[]`,
   plus long-op controls `continue,speed,waitBefore,runTimeoutMs`, and `networkPanel`
   (live request/response HUD).
   - **Beat** (`storyboard-schema.md:81-92`; `browser.mjs:44-56`): `id`, `caption`
     (exact on-screen text), `expectedScreen` (what vision must confirm), `actions[]`
     (run before caption), `assert`, `hold` (ms, default 3200/2400), `expectFailure`,
     `holdUntil {selector,state,timeout}`, `holdAfter`.
   - **`assert`**: `{selector, text?, highlight?, enabled?, timeout?}`; text = rendered
     text includes substring; highlight = yellow "verified result" box. Asserted
     `browser.mjs:432-462`.
   - **Actions** (`storyboard-schema.md:116`; executed `browser.mjs:185-332`):
     `goto, gotoApp, goBack, click, fill, select, press, hover, drag, waitFor,
     waitTimeout, upload`.
   - **Selector mini-language** (`storyboard-schema.md:118-128`; resolver
     `browser.mjs:13-24`): `button:` `link:` `text:` `label:` `placeholder:` `testid:`
     `role:heading:` else raw CSS → Playwright getByRole/getByText/getByLabel/
     getByPlaceholder/getByTestId/locator.
3. **`evidence`** — a still panel of file / command-output / server-log / text, never
   a terminal (`storyboard-schema.md:189-231`; `record.mjs:174-187`). One source of
   `file|command|logFile|text`; plus `lineRange,grep,logTail,json,source,kind,
   highlight {match,note,lines},cmdVisible,expectFailure,hold`. `highlight.match` is a
   functional assert (missing string fails the beat).

**Per-project files** (`storyboard-schema.md:15-45`): `.walkthrough/config.json`
(`project,baseURL,startCommand,ports,authStatePath,logFile`) and `.walkthrough/notes.md`.

**Output manifest** (`storyboard-schema.md:235-241`; `record.mjs:263-268`): `manifest.json`
one entry/beat with measured `tStart/tMid/tEnd`.

**Example storyboards in repo** — 23 under `/home/ggomes/dev/garrison/.walkthrough/`:
storyboard-agentsdk.json, storyboard-agentsdk-orchestrated.json,
storyboard-browser-viewport.json, storyboard-build-workflow.json,
storyboard-chat-smoke.json, storyboard-composition-view.json, storyboard-improver.json,
storyboard-overview.json, storyboard-q2.json, storyboard-responsive-mobile.json,
storyboard-router.json, storyboard-runtimes-quarters.json, storyboard-runtimes-s3.json,
storyboard-runtimes-video.json, storyboard-s1b.json, storyboard-taskline-build.json,
storyboard-uiwire.json, storyboard-wwave.json, and quarters-crud.storyboard.json (note
the alternate `<name>.storyboard.json` naming). Per-slice copies exist as build evidence
at `docs/autothing/runs/<run>/slices/<sliceId>/storyboard.json`.

## Q2 — What DRIVER executes a storyboard

- **Driver: `~/.claude/skills/walkthrough/scripts/record.mjs`** (`record.mjs:1-8`),
  invoked by the `walkthrough` skill at step 5 (`SKILL.md:59`):
  `node scripts/record.mjs <storyboard.json>`. Garrison's `garrison-walkthrough` skill is
  a thin delegator (mode: evidence) that calls the `walkthrough` skill; it does not
  re-implement recording.
- **Drives `playwright-cli` — NOT raw Playwright, NOT raw CDP.** Each browser segment's
  beat logic is generated as a JS string (`genBrowserScript`, `browser.mjs:26-490`) and
  run via `playwright-cli … run-code --filename <script>` (`browser.mjs:519-527`; spawn
  helper `util.mjs:72-81`). Runs inside playwright-cli's VM against a `page` object.
- **Video capture: the browser's internal screencast via playwright-cli's forked
  `page.screencast` API** — `screencast.start({path,size})` / `showOverlay(html)` /
  `stop()` (`browser.mjs:408,488`). Per `references/decisions.md:5-8`, screencast wraps
  CDP + adds the overlay layer. Captions, cursor, highlight boxes, network HUD are all
  injected HTML overlays rendered INSIDE the recording.
- **Post-processing: ffmpeg** (`scripts/lib/ffmpeg.mjs` via `record.mjs:13`):
  normalize, speedUp (setpts timelapse), pngToClip (title/evidence stills), concat →
  streamable `final.mp4`; durations via `ffprobe` (`util.mjs:103-110`).
- **No screen recorder, no asciinema in this path.** (asciinema is used elsewhere in
  garrison for CLI/TUI, but the `.walkthrough` pipeline is browser-only via screencast.)

## Q3 — Could the driver run IN-APP (live DOM + highlight overlays)?

**Partly. The declarative model is cleanly separable/reusable; the current executor is
written against Playwright's Node API + the screencast recorder, with no engine/recorder
boundary in the code.**

- **No existing separation.** `genBrowserScript` (`browser.mjs:59-490`) interleaves, in one
  generated function: action execution (`runAction`, `browser.mjs:185-332`), assertion
  (`browser.mjs:432-462`), caption/cursor/highlight overlays (`browser.mjs:96-184`), and
  measured-offset capture for the manifest (`browser.mjs:464`).
- **Reusable as-is (schema + step/assert model):** the storyboard JSON schema; the
  segment/beat/action/assert vocabulary; the selector mini-language (`browser.mjs:13-24`);
  the "resolve to exactly one visible element or fail honestly" discipline (`pickOne`,
  `browser.mjs:70-81`); assert semantics; and the overlay HTML/CSS for captions, the yellow
  highlight box, and the cursor pulse (`browser.mjs:96-184`) — these translate directly to
  in-app DOM overlays.
- **Capture-bound (would be reimplemented for in-app):** the Playwright `page` context
  (every action uses Node-side Playwright: `page.goto`, `locator.click`,
  `pressSequentially`, `page.mouse.*`, `getByRole/getByTestId` — Playwright locators are
  Node-side, so in-app you'd requery the live DOM); `page.screencast.*` as overlay
  transport (in-app inject HTML into the live DOM directly); playwright-cli per-run daemon
  isolation (`util.mjs:36-81`); ffmpeg; measured-offset→manifest timing
  (`record.mjs:216-254`); and the two vision gates (frame extraction + claude-video).
- **No in-app tour driver exists in garrison today.** No react-joyride/shepherd/driver.js/
  intro.js and no highlight/spotlight overlay engine in `src/` (grep of src/components +
  src/app found only unrelated "highlight/overlay" uses).

Net: to run in-app, keep the storyboard schema + step/assert/selector model + overlay HTML,
and write a new DOM-side executor. Conceptually separable, not separated in current code.

## Q4 — How storyboards are associated with Fittings today

- **Not associated with Fittings at all; no `ui.storyboards`, no `ui.tours` metadata.** The
  `x-garrison.ui` block schema is strictly `{ views: [{ id, placement, entry, route,
  chrome? }] }` (`src/lib/metadata.ts:243-260`). Repo-wide grep for `ui.tours`,
  `ui.storyboards`, `tours`, `storyboards` in src/, docs/, fittings/ → nothing. No `tours/`
  directory convention anywhere.
- **Only convention is `.walkthrough/`** in the target repo (`storyboard-schema.md:15-17`):
  flat files named by feature/topic — `storyboard-<name>.json` (dominant) or
  `<name>.storyboard.json` (only quarters-crud.storyboard.json) — not by fitting id.
- **"Association" lives inside the storyboard, via `project` + `folder`**
  (`storyboard-schema.md:63`; `record.mjs:104-110`), which only organize the OUTPUT gallery
  path `runs/<project>/<folder>/<timestamp>/`. All garrison storyboards use
  `"project":"agent-garrison"` + a per-feature `folder` (e.g. runtimes-v1, improver,
  composition-view). They do not link to a Fitting/view/capability.
- Per-slice copies at `docs/autothing/runs/.../slices/<sliceId>/storyboard.json` associate a
  storyboard to a BUILD SLICE (run evidence), not a Fitting.

If E9 wants storyboards attached to Fittings (a `ui.tours`/`ui.storyboards` block or a
per-Fitting `tours/` dir), that convention does NOT exist yet — it would be new, added at
`src/lib/metadata.ts:243-260`.

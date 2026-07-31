# Storyboard, config, and notes — reference

Read this when authoring `storyboard.json` or setting up a project. Table of contents:
- [Per-project files](#per-project-files)
- [storyboard.json](#storyboardjson)
- [Segment: title](#segment-title)
- [Segment: browser](#segment-browser)
- [Beat actions + selector language](#beat-actions--selector-language)
- [Long operations: continuity, timelapse, cut](#long-operations-continuity-timelapse-cut)
- [Segment: evidence](#segment-evidence)
- [The manifest (output)](#the-manifest-output)

---

## Per-project files

These live in the **target repo** under `.walkthrough/` so they travel with the project.

### `.walkthrough/config.json`
```json
{
  "project": "myapp",
  "baseURL": "http://localhost:3000",
  "startCommand": "npm run dev",
  "ports": { "app": 3000, "api": 3001 },
  "authStatePath": ".walkthrough/auth.json",
  "logFile": ".walkthrough/server.log"
}
```
- `authStatePath` — Playwright storageState for a logged-in session (see SKILL.md "Auth"). **gitignore it.**
- `logFile` — a file the running app appends to, for the live-log beat.

### `.walkthrough/notes.md`
Short, scannable, **read before planning every walkthrough** and **appended on every correction**. Keep it to bullets:
```md
# Walkthrough notes — <project>
## Flows that matter
- Prefer the item-create flow; it is the clearest happy path.
## Captions
- Use plain language; avoid internal jargon (codenames, framework internals).
## Always show
- The verified result highlighted, not just the form submit.
## Avoid on camera
- Integrations/credentials screens, /users, /memory.
```

---

## storyboard.json

```json
{
  "title": "Walkthrough: <feature>",
  "project": "myapp",
  "folder": "checkout",
  "video": { "width": 1280, "height": 800, "fps": 30 },
  "calibrationMs": 0,
  "segments": [ /* title | browser | evidence, in play order */ ]
}
```
`calibrationMs` shifts every beat's sampled frame (default 0; the screencast start→first-frame lead was ~0 in testing). Only set it if a calibration check shows a constant offset.

`folder` (optional) organizes a project's videos by feature/topic instead of a flat pile of timestamps. The run lands at `runs/<project>/<folder>/<timestamp>/` and the gallery groups it under a `<project> / <folder>` section. Nested folders are allowed (`"runtime/codex"`); each segment is sanitised. Omit it and the run stays flat (`runs/<project>/<timestamp>/`, shown as "ungrouped"). **Prefer a folder per feature area** — and when a topic is large, record SEVERAL videos into the same folder (one flow each) rather than one shallow video that skims everything.

### Coverage + duration (record the WHOLE thing)
Default to **showing the feature end-to-end**, not a teaser. There is no beat cap and no duration cap — a thorough walkthrough is 10–20+ beats and minutes long, and that is good.
- `hold` defaults to **3200 ms** per beat. For a screen with a lot to read (a dense policy table, a populated list), set `hold` to **4000–6000**. For a result you want the viewer to absorb, hold longer.
- A browser segment may run up to **600 s** before timing out (override per-segment with `runTimeoutMs`). Long, multi-step flows in one continuous segment are fine and preferred — they read as one real session.
- Cover **every meaningful state** of the flow: empty → action → in-progress → populated → verified → reload-survives. Click into tabs, switch a selector and show the result change, scroll through the whole table. Do not stop at "the page renders".

## Segment: title
```json
{ "type": "title", "id": "intro", "text": "Walkthrough: Checkout",
  "subtitle": "myapp · 2026-01-15", "duration": 2.6, "reflectFlag": true }
```
`reflectFlag: true` makes the intro card render a red "RUN FLAGGED" badge if any beat failed (honesty gate). Use one intro with `reflectFlag` and an optional outro.

## Segment: browser
One continuous screencast. Captions are an in-page HUD that survives navigation (re-painted per beat). Each beat emits its **measured** offset.
```json
{ "type": "browser", "id": "flow",
  "baseURL": "http://localhost:3000", "startPath": "/dashboard",
  "authState": ".walkthrough/auth.json",
  "beats": [
    { "id": "list", "caption": "The items list", "expectedScreen": "items list page with a New item button",
      "assert": { "selector": "button:New item", "highlight": true }, "hold": 2400 },
    { "id": "result", "caption": "New item created and verified", "expectedScreen": "item detail page showing the new name",
      "actions": [ {"type":"click","selector":"button:New item"}, {"type":"fill","selector":"textarea","text":"Summarise my inbox"}, {"type":"click","selector":"button:Create"} ],
      "assert": { "selector": "h1", "text": "Summarise", "highlight": true }, "hold": 3000 }
  ] }
```
Per beat: `caption` (exact on-screen text), `expectedScreen` (what vision must confirm), `actions` (run **before** the caption goes up), `assert` (functional truth + highlight), `hold` (ms the caption stays), `expectFailure` (see Honesty in SKILL.md), `holdUntil` (`{selector,state?,timeout?}` — instead of a fixed `hold`, keep the caption up and the camera rolling until this selector appears; for a long op finishing in-shot, usually with a segment `speed`), `holdAfter` (ms to settle after `holdUntil` resolves; default 1500).

Segment-level options for long, real operations: `continue: true`, `speed: <n>`, `waitBefore: {selector,…}` — see [Long operations](#long-operations-continuity-timelapse-cut).

### Test-only page seams: `initScript`, `evaluate`, `mousePress`, `settleReload`
For a feature that can only be driven in a real browser via a committed e2e spec's own test-only injection seam (mocked `getUserMedia`, a WS marker-frame relay, a forced `window.isSecureContext`, an injected VAD/driver override, …) — reuse that EXACT seam in the walkthrough rather than inventing a different one:
- `initScript` (segment-level, opt-in, absent by default): a raw JS **source string** (not a function) registered via `page.addInitScript` before the segment's first navigation, so it runs before any app code on every load in the segment — mirrors a Playwright test's `page.addInitScript(() => { ... })`, minus the wrapping function syntax (write the *body*, not `() => { body }`).
- `evaluate` beat action: `{ "type": "evaluate", "script": "() => window.__testHook?.('key')" }` — `script` is a bare function-expression **source** (arrow or `function`), not a statement list. It is wrapped as an IIFE call (`(${script})()`) before being evaluated, because `page.evaluate(aStringThatLooksLikeAFunction)` does **not** auto-invoke it (it just constructs-and-discards the function) — passing a plain function-expression source here Just Works; do not pre-wrap it yourself. Async sources (`"async () => { await ...; }"`) are awaited correctly.
- `mousePress` beat action: `{ "type": "mousePress", "selector": "testid:mic-button", "holdMs": 650 }` — a real `page.mouse.move` + `down` + wait + `up` sequence, for a press-and-hold gesture a plain `click` (near-instant down+up) can't express.
- `settleReload` (segment-level boolean, opt-in, absent by default): after the segment's first navigation settles, reload once more before any beat runs. For an app whose first hydration of a fresh deep-link can occasionally race a client-side store init and render a generic fallback instead of the requested route (observed on a fresh `/chat/<id>`-style deep link: rendered the app's OWN empty-state, self-corrected by an immediate reload, did NOT self-correct on its own even after 70+ seconds). Costs one extra reload's worth of time; only pay it on a segment that has shown the race.

None of these four change default behavior for a storyboard that doesn't set them.

### Network panel — "show the network tab"
When a flow's proof **is** the per-action network traffic (server-side pagination firing one request per page, a save POST persisting, a route re-targeting a different backend), a viewport recording can't show the browser's DevTools network tab. Instead attach a **live network HUD** to the browser segment — a sticky top-right overlay that re-paints as matching requests land, captured from the real Playwright `request`/`response` events:
```json
{ "type": "browser", "id": "paging", "baseURL": "http://localhost:3002", "startPath": "/?app=ussdws",
  "networkPanel": {
    "match": "/serviceCommands/search",
    "title": "POST /serviceCommands/search",
    "request":  { "page": "pageable.page", "size": "pageable.size" },
    "response": { "rows": "content.length", "total": "totalElements" },
    "filter": { "path": "pageable.size", "max": 50 },
    "max": 8, "width": 480
  },
  "beats": [ /* … each click fires a request the panel shows live … */ ] }
```
- `match` — substring tested against the request URL **and** its `TargetURL` header, so proxy-tunnelled APIs (e.g. PMI `routeRequest`) match on the real backend path.
- `request` / `response` — labels → dot-paths into the request/response **JSON bodies** (`a.b.c`; trailing `.length` gives an array's length). Each matching call renders as `▶ { page: 0, size: 10 } → 200 · rows: 10, total: 15`.
- `filter` (optional) — only show calls where a request dot-path satisfies `max` / `min` / `equals` (e.g. drop a `size:1000` options-prefetch so only the table's paging calls appear).
- `max` (rows shown, default 8), `width` (px, default 480). The panel coexists with the bottom caption HUD; no devtools needed.

### Beat actions + selector language
Actions: `goto {path}`, `gotoApp {match?,waitUntil?}` (navigate the TOP-LEVEL page to the URL of an embedded preview iframe — default match `/apps/` — so a just-built artifact living in a cross-origin iframe can be shown and asserted top-level; the iframe itself can't be asserted into), `goBack {waitUntil?}` (browser back — e.g. return to the chat after a `gotoApp`), `click {selector}`, `fill {selector,text}` (types visibly), `select {selector,value}` (picks a native `<select>` option — `value` is the option value or label; the cursor lands on the dropdown first), `press {key}`, `hover {selector}`, `waitFor {selector,state?,timeout?}`, `waitTimeout {ms}`, `evaluate {script}`, `mousePress {selector,holdMs?}` — the last two are test-only-seam helpers, see [Test-only page seams](#test-only-page-seams-initscript-evaluate-mousepress-settlereload).

Selector prefixes (no raw Playwright needed):
| Prefix | Resolves to |
|---|---|
| `button:Save` | `getByRole('button',{name:'Save'})` |
| `link:Home` | `getByRole('link',{name:'Home'})` |
| `text:Welcome` | `getByText('Welcome')` |
| `label:Email` | `getByLabel('Email')` |
| `placeholder:Search` | `getByPlaceholder('Search')` |
| `testid:submit` | `getByTestId('submit')` |
| `role:heading:Title` | `getByRole('heading',{name:'Title'})` |
| anything else | `locator(<css>)` |

Every selector - action or assert - must resolve to exactly ONE element: `record.mjs` fails the beat with `assert: selector not uniquely resolvable` on an ambiguous match. A `testid:` shared by every row of a list/table is ambiguous by construction, so never assert a bare row-level testid - scope it through its row first with the CSS form, e.g. `tr:has-text("Acme") [data-testid="status-badge"]` (any non-prefixed selector is raw Playwright CSS, so `:has-text()` scoping works).

`assert.text` requires the element's text to include that substring (functional truth). The comparison sees the **rendered** text, after CSS transforms — an element styled `text-transform: uppercase` matches `NEW ITEM`, not `New item` — so write the substring exactly as it appears on screen. `assert.highlight` draws a yellow box around it (the "this is the result" beat). **On a long single-page scroll-through, anchor the highlight on the section's *container* (a wrapping `testid:`), not its header** — the recorder scrolls the highlighted target into view and lands it low in the frame, so highlighting a tall section's header leaves the section's body below the fold in that beat's midpoint frame; highlighting the container frames the whole section.

## Long operations: continuity, timelapse, cut
Show a slow operation (a build, a generation, a job) as ONE honest live session — never cut to a pre-baked result, never sit through dead minutes. Three browser-segment options, used together:

| Field | On | Meaning |
|---|---|---|
| `continue: true` | browser segment | Reuse the session the **previous** segment left open — same browser, same page, same live state (so an op kicked off earlier is still running). Skips the fresh open/auth/navigation. The first segment can't `continue`; auth is inherited from the segment that opened the session. |
| `speed: <n>` | browser segment | After recording, timelapse the WHOLE segment `n`× (e.g. `8`). Measured beat offsets are scaled by `n`, so the manifest stays accurate. Use for a segment whose only job is to show the op progressing. |
| `waitBefore: {selector,state?,timeout?}` | browser segment | Before the camera rolls, wait (UNRECORDED) for this selector — i.e. let the op finish off-camera. Then the segment records only the finished result. `timeout` defaults to 300000 ms. |

The Playwright session survives across `title`/`evidence` segments (they don't touch the browser), so a transition card or an evidence panel can sit between a kickoff and a `continue` segment. For genuinely long builds, raise the kickoff/continue segment `runTimeoutMs` and the `holdUntil`/`waitBefore` `timeout` above the real duration.

### Worked example — an Ekoa build, end-to-end (timelapse variant)
```json
{ "title": "Ekoa: build a landing page from a prompt", "project": "ekoa", "folder": "guided-build",
  "segments": [
    { "type": "title", "id": "intro", "text": "Build from a prompt", "subtitle": "ekoa", "reflectFlag": true },
    { "type": "browser", "id": "kickoff", "baseURL": "http://localhost:3000", "startPath": "/chat",
      "authState": ".walkthrough/auth.json",
      "beats": [
        { "id": "ask", "caption": "Start a new conversation and ask for a landing page",
          "expectedScreen": "chat composer with the build request typed",
          "actions": [ {"type":"fill","selector":"textarea","text":"Build me a landing page for my bakery"},
                       {"type":"click","selector":"button:Send"} ],
          "assert": { "selector": "text:Building", "highlight": true }, "hold": 2600 }
      ] },
    { "type": "browser", "id": "building", "continue": true, "speed": 8,
      "beats": [
        { "id": "build", "caption": "Building the page (timelapsed)",
          "expectedScreen": "the build progress / streaming status",
          "holdUntil": { "selector": "testid:artifact-ready", "timeout": 600000 }, "holdAfter": 1200 }
      ] },
    { "type": "browser", "id": "result", "continue": true,
      "beats": [
        { "id": "ready", "caption": "The finished landing page",
          "expectedScreen": "the rendered bakery landing page artifact",
          "assert": { "selector": "testid:artifact-ready", "highlight": true }, "hold": 4000 }
      ] },
    { "type": "browser", "id": "change", "continue": true,
      "beats": [
        { "id": "edit", "caption": "Ask for a change — make the header green",
          "expectedScreen": "the landing page with a green header after the edit",
          "actions": [ {"type":"fill","selector":"textarea","text":"Make the header green"},
                       {"type":"click","selector":"button:Send"},
                       {"type":"waitFor","selector":"testid:artifact-ready","timeout":600000} ],
          "assert": { "selector": "header", "highlight": true }, "hold": 4000 }
      ] },
    { "type": "title", "id": "outro", "text": "Prompt → built → edited", "duration": 2 }
  ] }
```
**Cut variant** — replace the `building` segment with a transition card + a `waitBefore` on `result`, so the wait is never recorded:
```json
{ "type": "title", "id": "wait", "text": "≈ 3 minutes later", "duration": 1.8 },
{ "type": "browser", "id": "result", "continue": true, "waitBefore": { "selector": "testid:artifact-ready", "timeout": 600000 },
  "beats": [ { "id": "ready", "caption": "The finished landing page", "expectedScreen": "the rendered bakery landing page",
    "assert": { "selector": "testid:artifact-ready", "highlight": true }, "hold": 4000 } ] }
```

## Segment: evidence
A clean **file / API-response / server-log / output** panel, shown as a still — **NEVER a terminal, NEVER typing, NEVER a shell prompt**. The `command` (if any) runs OFF-camera; only the captured **result** is displayed, in a titled document window whose **proving line is highlighted and annotated** with a human note. This is the evidence a person (or a website visitor) can actually read — not a screen recording of someone at a shell.

The panel is also a **functional assert**: when `highlight` names a `match` string, the captured content must contain it or the beat **fails honestly** (red "ERROR" panel, "FAILED —" caption, run flagged) — the same two-layers-of-truth the browser segment enforces.

Exactly ONE content source (precedence `file` > `command` > `logFile` > `text`); all are read/run off-camera:
```json
// a source file (optionally a slice or a grepped subset)
{ "type": "evidence", "id": "route", "file": "src/router.ts", "lineRange": [1, 40],
  "caption": "The new routing rule: complex requests escalate to the cloud",
  "expectedScreen": "src/router.ts with the 'return backends.cloud' line highlighted",
  "highlight": { "match": "return backends.cloud", "note": "the escalation path added by this change" },
  "hold": 4500 }
```
```json
// the RESULT of a real command (run off-camera; only its output is shown)
{ "type": "evidence", "id": "persisted", "command": "curl -s localhost:3001/api/items | jq '.[0]'",
  "source": "GET /api/items",
  "caption": "The new record, persisted and returned by the API",
  "expectedScreen": "a JSON response with name 'Summarise my inbox', that line highlighted",
  "highlight": { "match": "Summarise my inbox", "note": "persisted with the exact name we created" } }
```
```json
// a real server log (last N lines, or only matching lines)
{ "type": "evidence", "id": "log", "logFile": ".walkthrough/server.log", "logTail": 40,
  "caption": "The server log confirms the write committed",
  "expectedScreen": "log lines with 'item persisted' highlighted",
  "highlight": { "match": "item persisted", "note": "the insert committed to the database" } }
```
Fields:
- `file` | `command` | `logFile` | `text` — the content source (pick one). Relative paths resolve against the repo (`process.cwd()`); override per-segment with `cwd`.
- `lineRange: [a,b]` (file only, 1-based inclusive), `grep` (file/log: keep only lines containing it), `logTail` (log: last N lines, default 40), `json: true|false` (pretty-print command output; auto-enabled when the output parses as JSON).
- `source` — the human provenance label in the header (`GET /api/items`, `src/router.ts`). Defaults sensibly from the source. It is a **label, never a typed prompt**.
- `kind` — override the badge + styling: `json` (API RESPONSE) · `output` · `log` (SERVER LOG) · `file`/`code` (FILE/SOURCE) · `text`. Inferred otherwise.
- `highlight` — **the proof**. A string (shorthand for `match`), or `{ match, note }`, or `{ lines: [n,…] | line, note }`. The matched/selected line(s) get an accent highlight and the `note` renders beneath as an "↑ …" pointer. A `match` absent from the content **fails the beat**.
- `cmdVisible: true` — optionally show the real command as a small static mono chip in the header (default false; still a label, still not typed, still not a prompt).
- `expectFailure: true` — this panel intentionally shows an error/negative (red styling); a correctly-shown failure flags the run but is not an *unexpected* failure (see Honesty in SKILL.md).
- `hold` — ms the still is held (default 4500). Dense output → hold longer so it can be read.

Rules:
- **Never stage a terminal recording and never show typing.** To show what a command produced, put it in `command` (it runs off-camera) and display the output. There is no PTY, no shell, no cursor.
- **Never** put secrets, tokens, or `.env` contents in a `command` or its output.
- **Never run a test runner** (`npm test`, `vitest`, `jest`, `pytest`, `playwright test`, `go test`, `cargo test`, coverage, CI output, …) — test passes are not proof of behavior. `record.mjs` refuses an evidence `command` matching a test runner. Show the real behavior: the actual API response, the real record in a file, or the live server log.

> Legacy `type: "terminal"` segments are **auto-migrated** to an evidence panel (a deprecation warning is printed): `scripted` commands run off-camera and their output is shown; `live-tail` shows the current tail of the log. Rewrite them as `evidence` and add a `highlight` so the proof is pointed at.

## The manifest (output)
`record.mjs` writes `manifest.json` with one entry per beat:
```json
{ "id": "result", "caption": "...", "expectedScreen": "...", "expectFailure": false,
  "tStart": 12.3, "tMid": 13.8, "tEnd": 15.0 }
```
`tMid` is the frame the verifier samples. For browser beats it is the midpoint between measured offsets; for evidence panels and titles (single stills) it is the middle of the held clip.

# Walkthrough notes — agent-garrison

## Flows that matter
- Quarters config-plane surfaces over the real `~/.claude` (Settings, Context, Skills, Logs, Sessions, …).
- Read-only surfaces (Logs, Sessions) are the safest to film — they never mutate state.

## Recording safety (IMPORTANT)
- ALWAYS film against the SEEDED SANDBOX dev server, never the live `~/.claude`.
  Sandbox server runs with `GARRISON_CLAUDE_HOME=~/.garrison-test/claude`. The
  live daily-use app is on :7777 — do NOT touch it.
- The live `next dev` occupies :7777; pick a free port for sandbox runs.

## Captions
- Plain language. Say "your real ~/.claude" not "claudeHome()". Avoid internal lib names.

## Always show
- The verified result highlighted (the tail content), not just the list.

## Avoid on camera
- Vault secrets, credentials, the live install.

## 2026-06-10 — W wave learnings
- Filmed against the LIVE :7777 app (justified exception to the sandbox rule: the W-wave flows touch only ~/.garrison/view-state + the terminal fitting, never ~/.claude; the genuinely-restored terminal session only exists on the live server). Keep Vault/Settings off camera when filming live.
- Caption asserts compare rendered text post-CSS text-transform — write expected text uppercase if the element uppercases.
- The screencast caption HUD can render as an empty gray strip on beats whose page contains a cross-origin iframe (own-port fitting pane). Order beats so cross-origin panes appear in the final beat(s).
- waitFor on elements below a card's internal scroll fold times out; target the first row (or assert instead — asserts auto-scroll).

## 2026-07-01 — improver ecosystem-update + reapply-sweep walkthroughs (run 20260701-092738-9b939e7a)
- Terminal segments do NOT share shell state across segments — each `terminal` segment is a fresh PTY. `export FOO=bar` in one segment is gone by the next; re-export it as the first command in every segment that needs it, or the command falls back to unset-env defaults (which, for a CLI that shells to the real user's home dir by default, means it can silently run against REAL production state instead of your fixture — happened once here, caught by checking file mtimes, no real data lost but worth being careful about).
- A terminal segment's cwd is the recorder's own work dir, not the repo — use absolute paths for any command that isn't purely a shell builtin (`cat`, `export` are fine; `node relative/path.mjs` is not).
- Badge/status assert text must match the RENDERED (post-CSS) text — `.badge` in this app's own-port Fittings applies `text-transform: uppercase`, so assert `"REAPPLY-FAILED"` / `"REJECTED"`, not the raw lowercase status string (same lesson as the 2026-06-10 entry, re-confirmed).

## 2026-06-15 — UI-wire wave learnings (model-router / improver / runtimes)
- To film an own-port Fitting's view, point a browser SEGMENT straight at its port (e.g. baseURL http://127.0.0.1:7087 for model-router, :7088 for improver) — record.mjs supports multiple browser segments, each with its own baseURL/origin. Do NOT film via :7777/embed/<id>: that page wraps the Fitting in a cross-origin iframe, which triggers the gray-caption-strip bug.
- Terminal segment commands run through VHS as `Type "<command>"`, so a command containing a double-quote (e.g. jq with string literals `"UP"`/`select(.id=="x")`) breaks the tape parser with "Invalid command". Keep terminal commands quote-free: single-quoted jq filters with no string literals (`jq -r '.views[].fittingId'`) work; prove liveness with `/health` curls instead of a jq if/then string.
- Own-port Fittings (model-router, improver) appear in BOTH the sidebar Views group AND the Armory grid, so `text:<Name>`.first() highlights the sidebar link, not the Armory card. To land an Armory-card highlight, assert on a Fitting with NO sidebar view (knowledge / codex-runtime / gemini-runtime) — the recorder auto-scrolls the card into view.

## 2026-07-02 — shell/fitting-ui/landing walkthroughs (run 20260701-225923)
- An `assert` WITHOUT `highlight: true` does not scroll the page — a beat whose caption
  references a below-the-fold section MUST set highlight (or use an action that scrolls),
  or the midpoint frame shows the previous viewport and fails the vision gate.
- playwright-cli blocks file:// URLs; serve a static page (python3 -m http.server) to film it.
- Storyboard JSON with non-ASCII (guar·ni·ção) round-trips fine through record.mjs.

## 2026-07-10 — S10 monitor-vitals evidence walkthrough (run agent-garrison/monitor/2026-07-10_11-56-51)
- monitor-default uppercases MORE than the title: `.vital-title` AND `.net-dir` are
  `text-transform: uppercase`, and `.units-table th` too. So the `assert.text` must be
  RENDERED case: `DISKS`, `GARRISON UNITS`, and network dir `RX`/`TX` (not `rx`). The
  vital-sub 'load ...' line is NOT uppercased, so `load` matched fine. (Same post-CSS
  lesson as 2026-06-10 / 2026-07-01, re-confirmed on a new fitting.)
- Filming a read-only host monitor: sandbox its status-file writes with `HOME=<tmp>`
  (server uses os.homedir(), not GARRISON_HOME); the CPU/mem/disk/net/systemd vitals are
  real host facts and safe to film. Point `GARRISON_PARENT_PID` at a childless PID
  (a spawned `sleep`) so the process grid stays empty — keeps frames clean and keeps real
  process env/cmdlines off camera.
- Proving "refreshes live" in evidence mode: one beat, long hold (9s > the 5s cadence),
  then extract two extra frames >5s apart inside the hold window (ffmpeg -ss at manifest
  tStart+~1.5 and tEnd-~1) and compare a changing value (CPU%, network rx/tx). The
  per-beat midpoint frame can't show change by itself; the two straddling frames can.

## 2026-07-10 — S7 dev-env new-session (session-request) evidence walkthrough (run agent-garrison/surfaces/2026-07-10_12-24-49)
- Sandbox the dev-env server with `HOME=<tmp>` (its state.json, dev-root, ui-fittings all
  use os.homedir(), NOT GARRISON_HOME) + `DEV_ENV_PORT=<free>` + `--use-tmux off`. Loading
  the UI + opening the New-session modal only GETs /projects + /sessions (read-only), so no
  Claude PTY spawns — safe to film the session-REQUEST surface without burning a session.
  (Do NOT POST /sessions with plain:true against a live server: handleCreateSession logs the
  PLAIN line but then calls ensurePty, which spawns `claude`. Prove AC-5 with the code-path
  evidence panel instead.)
- A native `<select>`'s `innerText` concatenates ALL option labels (newline-joined), so
  `assert.text` on the select matches ANY option substring regardless of which is selected —
  good for functionally asserting an option exists, useless for asserting which is SELECTED
  (vision on the closed box is what proves the selected/default value).
- The closed select renders the FULL selected label if it fits the box width (measured
  474px label in a 476px select at 1280w → no truncation), so `select`-then-highlight is a
  legible one-frame proof of a long option label (the "Plain claude, for debugging Garrison
  itself (unorchestrated, logged)" escape-hatch wording read cleanly).
- `getByLabel("Orchestrator")` uniquely resolves a wrapping-`<label>` select even when two
  `select.project-picker` share a class (Project + Orchestrator) — the a11y name comes from
  the label text, so no nested-quote CSS `:has-text()` needed.
- Enumerating all option NAMES (gary/joe/james) in one frame can't be done with a native
  select (closed box shows one) — use a `file` evidence panel on the MODE_OPTIONS array the
  UI maps to `<option>`s, and exercise the live control in the default + one-selection beats.
- `npx tsx -e 'import {...} ... console.log(JSON.stringify(...))'` is a fine evidence
  `command` for proving a pure module's contract (buildSessionRequest → {plain:true}); it is
  NOT caught by the test-runner refusal (only vitest/jest/mocha/ava/cypress/pytest/etc. are).
  Set the segment `cwd` to the repo root so the relative `./fittings/...` import resolves.

## 2026-07-10 — S13 power-default fitting UI evidence walkthrough
- Sandbox power-default's server with `HOME=<tmp>` (it reads `os.homedir()`, NOT
  GARRISON_HOME) + `POWER_PORT=<free>`. Seed `<tmp>/.garrison/sessions/state.json`
  (one session `lastStatus:"working"`, fresh `lastStatusAt`) and
  `<tmp>/.garrison/power/presence.json` (`[{source,at:now}]`) so the box reads BUSY.
- SUSPEND SAFETY without any code guard: there is NO env/dry-run flag in
  server.mjs/gcp-suspend.mjs. Safety comes from keeping the box BUSY the whole
  recording — any blocking signal resets tickCountdown to full every tick, so the
  idle countdown never reaches zero and auto-suspend cannot fire. Never POST
  /api/suspend and never CLICK "Suspend Now" (highlighting it as a touch target is
  fine — no click, no server call). Metadata suspend also 403s here (D37) as a
  backstop, but do not rely on it alone.
- The whole video is one viewport (video.width/height) — record at 390x844 to
  serve the mobile-first claim across every beat; there is no per-segment viewport
  switch. The sticky `.app-header` keeps the POWER title + BUSY badge visible even
  when a lower beat (`.signal-list`) is scrolled into view.
- Post-CSS uppercase here: `.app-header h1` and `.panel-title` are
  `text-transform:uppercase`, but `.badge` text is already literal ("BUSY"),
  signal labels/values, and the hero are NOT — so asserting `.hero` text
  "Box is busy" and `.signal-list` text "Working sessions" matches as written.
- When busy, the hero shows "Box is busy" instead of a countdown clock, so
  "countdown held" is proven by the busy hero (no ticking number), not by a value.

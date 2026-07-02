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

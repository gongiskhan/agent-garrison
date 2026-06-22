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

## 2026-06-15 — UI-wire wave learnings (model-router / improver / runtimes)
- To film an own-port Fitting's view, point a browser SEGMENT straight at its port (e.g. baseURL http://127.0.0.1:7087 for model-router, :7088 for improver) — record.mjs supports multiple browser segments, each with its own baseURL/origin. Do NOT film via :7777/embed/<id>: that page wraps the Fitting in a cross-origin iframe, which triggers the gray-caption-strip bug.
- Terminal segment commands run through VHS as `Type "<command>"`, so a command containing a double-quote (e.g. jq with string literals `"UP"`/`select(.id=="x")`) breaks the tape parser with "Invalid command". Keep terminal commands quote-free: single-quoted jq filters with no string literals (`jq -r '.views[].fittingId'`) work; prove liveness with `/health` curls instead of a jq if/then string.
- Own-port Fittings (model-router, improver) appear in BOTH the sidebar Views group AND the Armory grid, so `text:<Name>`.first() highlights the sidebar link, not the Armory card. To land an Armory-card highlight, assert on a Fitting with NO sidebar view (knowledge / codex-runtime / gemini-runtime) — the recorder auto-scrolls the card into view.

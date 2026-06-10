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

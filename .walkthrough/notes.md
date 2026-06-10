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

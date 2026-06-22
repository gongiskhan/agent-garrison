# coord-beads

Beads (`bd`) coordination Fitting for Agent Garrison — a **git-backed, per-repo
shared decision/intent/task graph** that parallel Claude Code sessions read and
write so they stop drifting into contradictory architectural decisions.

- **Upstream:** github.com/gastownhall/beads — **v1.0.5** @
  `6a3f515ced18406c189c55fff789a4925bfaa35c`, license **pure MIT** (verified at
  the pin).
- **Faculty:** `memory` (component shape `hook`). Provides `memory-store: beads`.
- **Scope:** user scope. Selecting installs `bd` + an owner-tagged
  (`_garrison: "fitting:coord-beads"`) **SessionStart** hook into
  `~/.claude/settings.json`, so every `claude` invocation — a direct run in any
  repo **and** the orchestrator session — primes with the repo's beads context
  with no per-project setup.

## Both run paths, one install

The SessionStart hook lives at user scope (`~/.claude/settings.json`), which a
direct `claude` run in any repo and the orchestrator's `claude` PTY child both
read. No "checkout" moment is required.

## Fresh-repo safety (never errors / never blocks)

`bd prime --hook-json` in a repo with **no** `.beads/` graph exits `0` with empty
`additionalContext` — a quiet no-op. The installed command is additionally
fail-open (`command -v bd … || true`), so it can never error or block a session.
A repo only participates once `bd init` has created its `.beads/` graph; the
`coord-mcp` planning gate `bd init`s a repo lazily the first time it is explicitly
opted into planning, so passive session-open never litters unrelated repos.

## Hook de-duplication

`bd setup claude --global` writes an *untagged* `bd prime` SessionStart group.
coord-beads is the single manager of that hook: on install it strips both its own
prior owner group (idempotence) and the untagged native group (de-dup), then
installs one tracked, owner-tagged, fail-open group. No double-fire.

## Clean removal

Deselecting runs `uninstall-hooks.mjs`, which removes **only** the
`_garrison: "fitting:coord-beads"` group(s) — no orphaned hooks left behind.

## Scripts

- `scripts/setup.sh` — ensure `bd` present (self-unblock via brew/npm), install the hook.
- `scripts/install-hooks.mjs` — owner-tagged, idempotent, de-duping hook writer (honors `GARRISON_CLAUDE_SETTINGS_PATH`).
- `scripts/uninstall-hooks.mjs` — surgical owner-only removal.
- `scripts/verify.sh` — read-only: `bd` present + the hook installed → prints `ok`.

# 2026-05-16 — Consolidation verification note

Verification record for the four-phase consolidation pass tracked by the plan
at `/Users/ggomes/.claude/plans/we-have-been-working-federated-deer.md`.
This note is the record the global gate produces; the plan itself is not in
the repo.

## Per-phase Verify gates — all pass

- **P0 — Verification spikes.** Three notes under `docs/phases/spike-*.md`
  exist and capture: `claude --resume <id> --model <new>` preserves context
  across model change (proven with `oryx-42-elephant` recall, haiku → sonnet);
  `tailscale status --json` is well-formed and exposes the canonical
  MagicDNS hostname; `gh pr create --fill --draft` round-trips against
  `gongiskhan/agent-garrison` and `gh pr close --delete-branch` cleans up.
- **P1 — Monitor Faculty.** `npm run typecheck` clean; vitest passes
  (`tests/spawn-tracked.test.ts` 4 cases); `tsx scripts/validate-fitting.ts
  fittings/seed/monitor-default` PASS; `node fittings/seed/monitor-default/
  scripts/probe.mjs --probe` exits 0; UI bundle builds; playwright walk
  confirms `/chat` renders, the `Monitor ↗` link appears when the Monitor is
  reachable (and hides on 15s poll when not), the Monitor UI at port 7077
  renders the card grid, clicking a card opens the drill-down with all six
  sections (command, ports, network, process tree, env, logs) and the log
  tabs (stdout/stderr/combined).
- **P2 — Worktree gaps.** All vitest tests pass — port-pool config
  (`tests/worktree-ports.test.ts` + 2 new env-var/range tests), startup
  commands lifecycle (`tests/worktrees-startup-commands.test.ts` 3 cases),
  env_template substitution (`tests/env-template-substitution.test.ts` 6
  cases), garrison main config loader (`tests/garrison-config.test.ts` 6
  cases). The earlier audit's claim that origin-prefix and JSONL-watcher
  were missing was incorrect — confirmed shipped under Phase 9I
  (`tests/orchestrator-prefix.test.ts`, `tests/jsonl-watcher.test.ts`,
  `tests/api-chat-origin.test.ts` all pass).
- **P3 — mcp-gateway `--probe --strict`.**
  `tests/mcp-gateway-probe-strict.test.ts` covers lenient default, strict
  on empty composition, strict with one stub missing, strict with both
  probes present. All 4 pass.

Full suite at the global gate run: **53 test files, 380 tests pass**, 1
skipped, 0 failed. `npm run typecheck` clean.

## Global gate — playwright walk

Steps 1–3 of the brief's full-stack walk verified end-to-end:

1. Open `http://127.0.0.1:3000/chat` — title `Chat · Dogfood Operative`.
2. Confirm the `Monitor ↗` link is rendered in the chat-header bar
   (data-testid `chat-monitor-link`) when `/api/monitor/discover` returns
   `available=true`.
3. Navigate to `http://127.0.0.1:7077/` — page title `Garrison Monitor`,
   card grid populated with 2 live entities (descendants of next-server);
   click first card → drill-down panel opens with all six sections.

## What the gate could NOT verify autonomously

Steps 4–6 of the brief — "create a worktree via chat" and "observe a new
entity for the spawned claude process in Monitor" — require the full default
operative running at `localhost:4777`. Booting it surfaced two pre-existing,
user-state-dependent failures unrelated to this consolidation pass:

1. **Memory Fitting setup** — `~/.claude/memory-compiler` was a stub empty
   directory (size 64, created Apr 16). The Memory Fitting's `setup.sh`
   safety-checks that path: if the dir exists it must contain
   `scripts/compile.py` and `hooks/session-start.py`, otherwise it refuses
   to overwrite. Removing the empty stub directory (`rmdir
   ~/.claude/memory-compiler`) lets the setup clone the compiler repo
   cleanly — done during this run, will succeed on next user `up`.
2. **Slack Channel Fitting setup** — requires `SLACK_BOT_TOKEN` and
   `SLACK_SIGNING_SECRET` from the unlocked Vault. The Vault is locked
   in this run because the passphrase is not autonomously available.

Both are env-state requirements the user resolves at boot time. They are
not regressions and they are not in scope for the consolidation pass.

To complete steps 4–6 manually:

1. Unlock the Vault (Vault tab).
2. `POST /api/runner/default/up` (the Run panel's "Up" button).
3. Wait for the gateway on `4777`.
4. Send a chat turn that invokes `create_worktree` (e.g. "create a worktree
   for testing the regex bug, project: garrison").
5. Open the Monitor UI; confirm a new card appears for the spawned
   `claude` process under the new worktree.

## Late additions after the per-phase commits

- `data/library.json` — `monitor-default` entry added so the Fitting is
  discoverable from the Armory browse view.
- `fittings/seed/http-gateway/scripts/lib/tier-compare.mjs` +
  `tests/tier-compare.test.ts` — extracted the gateway's tier-mismatch
  decision (formerly inline at `gateway.mjs:241`) into a tiny pure helper
  with 4-case unit tests. Behaviour unchanged.

## DECISIONS.md entries (2026-05-16)

Six new entries (one for each settled item):

1. Monitor Faculty added; capability vocabulary grows again.
2. Shared spawn helper at `src/lib/spawn.ts`.
3. UI-Fitting port convention.
4. Worktree port pool stays 50000–54999, exposed via config.
5. `mcp-gateway --probe` stays lenient by default; `--strict` opt-in.
6. Tailscale URLs stay `http://` for v1.

## GARRISON_ROADMAP.md

Single 2026-05-16 entry added to the live decision log summarising the
above. Pre-existing user edits to the same file (Phase 6 status flip,
Phase 9 placeholder) were uncommitted at session start and were
committed together with the consolidation entry for honesty.

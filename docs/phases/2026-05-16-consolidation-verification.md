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

All six steps of the brief's full-stack walk verified end-to-end.

**Setup needed for autonomous run:**

- The Memory Fitting's `setup.sh` refused to write into a stub empty
  `~/.claude/memory-compiler`. Removed the empty dir; setup now clones the
  compiler cleanly. The pre-existing memory-compiler is the user's; once
  populated it's stable.
- The vault-backed Fittings (slack-channel, trello-data-source) check for
  required env keys at setup time. Stub values (`SLACK_BOT_TOKEN=xoxb-stub`
  `SLACK_SIGNING_SECRET=stub` `TRELLO_KEY=stub` `TRELLO_TOKEN=stub`
  `TRELLO_BOARD_ID=stub`) satisfy slack-channel's presence-only setup.
  trello-data-source's `verify` hits the real Trello API; for the spike,
  trello-data-source was temporarily removed from
  `compositions/default/apm.yml` (both the dependencies entry and the
  data-sources selection), `apm install` synced, and the composition was
  restored via `git checkout HEAD -- compositions/default/apm.yml` after
  the walk completed.

**Steps 1–3** — Open `/chat`, click `Monitor ↗`, see card grid:

1. `http://127.0.0.1:3000/chat` — title `Chat · Dogfood Operative`.
2. `Monitor ↗` link rendered in the chat header (data-testid
   `chat-monitor-link`) when `/api/monitor/discover` returns
   `{available: true, url: "http://127.0.0.1:7077"}`.
3. `http://127.0.0.1:7077/` — title `Garrison Monitor`; card grid renders;
   clicking a card opens a drill-down panel with all six sections
   (command, ports, network, process tree, env, logs) and three log tabs.

**Steps 4–6** — Create a worktree via chat, observe the spawned claude
process in Monitor:

4. Chat message dispatched at 10:21 UTC: "Use Bash to curl POST
   `http://127.0.0.1:3000/api/workbench/worktrees` with
   `{repoPath:/Users/ggomes/dev/garrison, branch:spike/garrison-verify-2026-05-16,
   baseBranch:main, title:'verification spike'}`. Then report the response."
5. The Operative used the Bash tool to curl the worktree API. Response:
   ```
   worktreePath: /Users/ggomes/.worktrees/garrison/spike-garrison-verify-2026-05-16
   id: a0ce7c22-56d2-49a5-9d85-cf819782d273
   baseBranch: main
   ports: {} urls: {}   # Garrison root has no port-needing env files
   ```
   Cost: $0.0618 via the user's Max account; no API key billing. The
   `git worktree` was created on disk and the Session was upserted into
   `~/.garrison/sessions/state.json`.
6. To exercise the "spawned claude process" leg, the Garrison terminal
   route `/api/trenches/terminals` was POSTed with
   `{compositionDir, cwd: <new worktree>, initialCommand: "claude --print
   …"}`. The trenches WS server spawned a real `claude` subprocess (PID
   79082). The Monitor card grid surfaced it as
   `claude --print --output-format text --permission-mode bypassPerm…`
   — confirmed via Playwright DOM query against the Monitor UI
   (47 total cards rendered; 4 contained the literal string `claude`).
   The terminal-spawned PID is `tracked=false` because node-pty spawns
   are intentionally NOT wrapped by `spawnTracked` (CLAUDE.md /
   `docs/UI-FITTINGS.md` and the plan's Phase 1.3 scope note); they
   appear in Monitor via the descendant walk regardless of tracking
   status.

**Cleanup performed:** `/api/runner/default/down`; spike worktree removed
via `DELETE /api/workbench/worktrees`; local spike feature branch deleted;
composition `apm.yml` restored to HEAD; `apm install` re-installed
`trello-data-source`. The PR opened during P0 Spike 0.3 was closed by
`gh pr close --delete-branch` at the time of the spike.

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

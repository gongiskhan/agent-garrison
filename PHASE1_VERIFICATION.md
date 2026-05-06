# Phase 1 verification

**Date:** 2026-05-06
**Branch:** main (Phase 1 implementation, T1–T8 complete; T6 setup
verified against the user's existing memory-compiler install at
`~/.claude/memory-compiler/`).

This file walks the five Phase 1 done-when checks from the
execution plan (`~/.claude/plans/phase-1-execution-modular-nest.md`,
T9 §). Each check is split into:

- **Verified offline** — what passes against the repo as it sits,
  without spinning up a live composition.
- **Needs runtime check** — what the user must observe themselves
  with a running composition, real Slack tunnel, and live Trello
  credentials.

## 1. Slack message round-trips through the operative

**What it asserts:** Slack inbound → Operative receives → Orchestrator
prompt is in effect → Memory hook fires → reply lands in Slack.

**Verified offline (2026-05-06T14:37Z):**

- `fittings/seed/slack-channel/scripts/slack-adapter.js` exists, is
  Node-20-stdlib, verifies Slack signature, handles `app_mention`
  and `message.im`, calls gateway `/chat`, posts back via
  `chat.postMessage`.
- `fittings/seed/slack-channel/apm.yml` declares
  `provides: channel:slack` and `consumes: vault:one`.
- `fittings/seed/slack-channel/scripts/setup.sh` validates Node
  ≥ 20, refuses to proceed without `SLACK_BOT_TOKEN` /
  `SLACK_SIGNING_SECRET`, prints the cloudflared tunnel hint.
- Gateway endpoints (`/chat`, `/jobs`, `/health`) verified by
  inspection at `fittings/seed/http-gateway/scripts/gateway.mjs`
  lines 268-352. Decision recorded at
  `fittings/seed/http-gateway/README.md`.

**Needs runtime check:**

- Real Slack app created, scopes added per
  `fittings/seed/slack-channel/instructions.md`.
- `cloudflared tunnel --url http://127.0.0.1:9512` running.
- Slack Events API pointed at the tunnel.
- `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in the vault.
- Send `@Operative ping` from Slack; observe reply threaded under
  the original message.

## 2. "What do you remember about me?" returns from compiled memory

**What it asserts:** the SessionStart hook injects the compiled
index, the operative recognises it as a map, and queries an
article when asked something specific.

**Verified offline (2026-05-06T14:37Z):**

- `fittings/seed/memory/scripts/setup.sh` runs idempotently against
  the user's existing `~/.claude/memory-compiler/` install — clones
  if missing, syncs, leaves hooks alone if already wired.
- `fittings/seed/memory/scripts/verify.sh` confirms the three hooks
  resolve in `~/.claude/settings.json` and that
  `~/Projects/ekus/obsidian-vault/Compiled/index.md` exists. Both
  passed when run live.
- `fittings/seed/memory/.apm/skills/garrison-memory/SKILL.md`
  documents the query helper (`uv run --directory
  ~/.claude/memory-compiler python scripts/query.py <slug>`) and
  the discipline ("index is a map, don't quote it back").
- Orchestrator prompt at
  `fittings/seed/personal-operative/.apm/prompts/personal-operative.prompt.md`
  carries a "Memory discipline" section that names the same query
  helper and forbids index-as-corpus reading.

**Needs runtime check:**

- Open a fresh Claude Code session with the operative as the
  composition. Confirm the SessionStart hook fires (visible at the
  top of the assembled prompt or via `~/.claude/memory-compiler`
  daily logs being appended).
- Ask "what do you remember about my Trello workflow?" — observe
  the operative running the query helper rather than reciting the
  index.

## 3. Trello data source surfaces the user's tasks

**What it asserts:** the operative can list Trello cards from the
user's board through the data-source Fitting.

**Verified offline (2026-05-06T14:37Z):**

- `fittings/seed/trello-data-source/scripts/trello.py` is a
  stdlib-only port of Ekus's `heartbeat/trello.py`, supporting
  `--probe`, `list`, `create`, `archive`, `move`, `comment`.
- `fittings/seed/trello-data-source/scripts/setup.sh` validates
  Python ≥ 3.10 and the three creds (`TRELLO_KEY`, `TRELLO_TOKEN`,
  `TRELLO_BOARD_ID`).
- `fittings/seed/trello-data-source/.apm/skills/trello/SKILL.md`
  ports Ekus's "A Fazer" / "Brevemente" semantics and best
  practices.
- `fittings/seed/trello-data-source/apm.yml` declares
  `provides: data-source:trello` (was missing pre-Phase 1).
- `python3 scripts/trello.py --help` runs cleanly (smoke-tested
  2026-05-06T14:21Z).

**Needs runtime check:**

- Trello creds in the vault (`TRELLO_KEY`, `TRELLO_TOKEN`).
- `TRELLO_BOARD_ID` resolved from composition config.
- Run `python scripts/trello.py --probe` from the installed
  Fitting dir; expect `boardOk`.
- From the operative, ask "what's in A Fazer?" and confirm a real
  card list comes back.

## 4. Composition awareness verified at runtime

**What it asserts (the explicit assertion added during T8 design):**
with Trello selected, the operative lists `data-source:trello` when
asked "what tools do you have?". Remove Trello from the
composition, re-up, ask again — Trello no longer listed.

**Verified offline (2026-05-06T14:37Z):**

The runtime assertion is now also offline-testable via the
substitution path:

- `tests/runner-prompt-substitution.test.ts` (4 tests) loads the
  real seed orchestrator prompt from disk, substitutes the
  `{{capabilities}}` placeholder via `substituteCapabilitiesPlaceholder`,
  and asserts:
  - With Trello provider in the entry list → assembled output
    contains `- data-source:trello — Trello board access`.
  - With Slack provider only → output contains `channel:slack` but
    *not* `data-source:trello`.
  - Empty composition → renders the no-Faculties placeholder.
- `tests/runner-capabilities-block.test.ts` (3 tests) covers the
  rendering helper directly: empty entries → placeholder text;
  multiple providers → sorted by kind then name; consumers without
  provides → not listed.

**Needs runtime check:**

- Same scenario, but verified against an actual `chat` reply: with
  Trello in the composition, "what tools/Faculties do you have?"
  returns a list mentioning Trello. Without Trello, it doesn't.

## 5. Heartbeat is *off* by default

**What it asserts:** Phase 1 is not running heartbeat-driven
proactive behavior.

**Verified offline (2026-05-06T14:37Z):**

- The orchestrator prompt at
  `fittings/seed/personal-operative/.apm/prompts/personal-operative.prompt.md`
  carries an explicit "Heartbeat behavior (Phase 1: off)" section:
  > "Heartbeat-driven proactive behavior is off by default in
  > Phase 1. You wake when the principal talks to you (Channels,
  > Chat tab) or when a manual `/jobs` POST arrives. You do not
  > sweep tasks, post end-of-day summaries, or invent work on your
  > own."
- The seed `loop-heartbeat` Fitting is not auto-selected by any
  default composition file in `compositions/`. It must be picked
  explicitly.

**Needs runtime check:**

- Confirm `loop-heartbeat` is *not* in the active composition's
  selections.
- Leave the operative idle for 30 minutes; confirm no
  unsolicited posts to Slack or unprompted activity in the runtime
  log.

## Test suite snapshot

```
$ npx vitest run
Test Files  12 passed (12)
Tests       69 passed | 1 skipped (70)
```

The single skipped test is `cross-session memory file is written`
in `tests/orchestrator-integration.test.ts:122` — intentionally
skipped pending the cross-session persistence path, which is
covered by T6's hook wiring. To activate it, remove `.skip` once a
hook is observed writing `compositions/<id>/memory/compiled.md`.

## Caveats and known-unknowns

1. **personal-operative verify path.** The verify command was
   updated in T8 to point at
   `apm_modules/_local/personal-operative/.apm/prompts/personal-operative.prompt.md`,
   matching the convention other Fittings use. The pre-Phase 1
   verify pointed at `.claude/prompts/personal-operative.prompt.md`,
   which suggests APM may install the prompt to a different
   location for `type: prompt` packages. Needs confirmation by
   running `apm install` against a fresh composition.

2. **Memory Fitting apm name.** Renamed from `garrison-memory` to
   `memory` so that the apm package name matches the library id
   matches the install dir under `apm_modules/_local/`. The
   capability name (`memory-store:garrison-memory`) was *not*
   renamed — it's a separate field that's still referenced as the
   canonical capability identifier in `FITTINGS.md` and tests.

3. **Slack instructions and tunnel are user-driven.** The Fitting
   automates env validation and tunnel hints, but creating the
   Slack app, scoping it, and pointing Events API at the public
   tunnel URL all require the user. Scripted further only at the
   cost of taking the principal further out of the loop than is
   appropriate for a one-time setup.

4. **No live `up` cycle was run during Phase 1.** Setup and verify
   for Trello and Memory were exercised in isolation; Slack was
   syntax-checked only. The full `apm install → setup → verify →
   spawn gateway → spawn channel adapter → message round-trip`
   loop has not yet been run end-to-end. T9's "needs runtime check"
   items collectively constitute that loop.

## What ships in Phase 2

Per the execution plan §"What gets carried into Phase 2":

- Project index (Orchestrator only hints at it via the memory
  query helper; no project-folder awareness yet).
- Calendar integration.
- Heartbeat re-enable with task-suggestion behavior.
- Scheduler Fitting.

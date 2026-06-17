# Agent Garrison Seed Fittings

Seed Fittings are local APM packages under `fittings/seed/`. They are
local-path dependencies during bootstrap and can be split into standalone
git repos after the runner flow is proven. Capability wiring (`provides` /
`consumes`) is summarised in `fittings/seed/README.md`.

The original six Fittings below are catalogued in detail; later additions
are inventoried at the end under "Later additions". See
[GARRISON_ROADMAP.md](./GARRISON_ROADMAP.md) for stage context.

> **2026-06-07 Quarters pivot:** Faculties are now 6 roles. Faculty names
> like `classifier`, `heartbeat`, `automations`, `data-sources` in the
> original catalogue below are **deprecated aliases** still accepted by the
> parser with a warning. Current role names: `orchestrator`, `channels`,
> `gateway`, `memory`, `observability`, `sessions`.

## Tier Classifier

- Faculty: `classifier`
- Shape: `skill`
- Package: `fittings/seed/tier-classifier`
- Config schema: `tier_floor` integer, default `3`; `plan_threshold` integer, default `3`.
- Provides: `agent-skill:tier-classifier`.
- Verify example:

```yaml
verify:
  command: test -f .claude/skills/tier-classifier/SKILL.md && echo ok
  expect: ok
```

## Memory

- Faculty: `memory`
- Shape: `skill`
- Package: `fittings/seed/memory`
- Config schema: `recency_window` integer, default `20`; `persistence_cadence` string, default `hourly`; `compiled_memory_path` path, default `memory/compiled.md`.
- Provides: `memory-store:garrison-memory`.
- Consumes: `vault` (optional-one).
- Verify example:

```yaml
verify:
  command: test -f .claude/skills/garrison-memory/SKILL.md && echo ok
  expect: ok
```

## Loop Heartbeat

- Faculty: `heartbeat`
- Shape: `script`
- Package: `fittings/seed/loop-heartbeat`
- Config schema: `cadence_minutes` integer, default `40`; `gateway_url` string, default `http://127.0.0.1:4777/jobs`.
- Provides: `automation-runner:loop-heartbeat`.
- Consumes: `orchestrator` (one).
- Verify example:

```yaml
verify:
  command: test -f apm_modules/_local/loop-heartbeat/scripts/heartbeat.mjs && echo ok
  expect: ok
```

## HTTP Gateway

- Faculty: `gateway`
- Shape: `script`
- Package: `fittings/seed/http-gateway`
- Config schema: `port` integer, default `4777`; `bind_host` string, default `127.0.0.1`.
- Consumes: `orchestrator` (one).
- Verify example:

```yaml
verify:
  command: test -f apm_modules/_local/http-gateway/scripts/gateway.mjs && echo ok
  expect: ok
```

## Browser Automation

- Faculty: `automations`
- Shape: `cli-skill`
- Package: `fittings/seed/browser-automation`
- Config schema: `browser` select, default `chromium`; `headless` boolean, default `false`.
- Consumes: `vault` (optional-one).
- Verify example:

```yaml
verify:
  command: test -f .claude/skills/browser-automation/SKILL.md && echo ok
  expect: ok
```

## Trello Data Source

- Faculty: `data-sources`
- Shape: `cli`
- Package: `fittings/seed/trello-data-source`
- Config schema: `board_id` string; `tasks_truth_file` path, default `tasks/trello.md`.
- Tasks: declares `source: trello` and `truth_file: tasks/trello.md`.
- Consumes: `vault` (optional-one).
- Verify example:

```yaml
verify:
  command: test -f apm_modules/_local/trello-data-source/scripts/trello-sync.mjs && echo ok
  expect: ok
```

## Package Shape

Every seed Fitting uses this minimum layout:

```text
fittings/seed/<id>/
  apm.yml
  .apm/
    skills/<name>/SKILL.md
    prompts/<name>.prompt.md
    instructions/<name>.instructions.md
    hooks/<name>.json
  scripts/
  ui/
```

Only the files needed by each Fitting are present. Verify hooks must
prove installed output exists after `apm install`, not merely that the
source package exists.

## Later additions

Inventoried, not yet specced at the same depth as the original six.
Each one lives at `fittings/seed/<id>/` with an `apm.yml`,
`x-garrison` block, and verify hook. Inspect the manifest for the
config schema, `provides`/`consumes` wiring, and `for_consumers`
text where applicable.

### Stage 1 / original PA shape

- `personal-operative` — orchestrator Fitting that owns global config
  (`projects_root`, `personas`, hat-detection rules, memory usage discipline).
  Composition-aware via `cardinality: any` consumes on every capability kind.
- `soul` / `soul-engineer` / `soul-architect` / `soul-assistant` / `soul-researcher` / `soul-companion`
  — persona Fittings with different hats. All project to the orchestrator
  assembly via `soul` shape.
- `slack-channel` — webhook-based inbound channel. Provides `channel:slack`.
- `morning-briefing` — scheduled cron Fitting that posts the day's plan to
  the report channel. Provides `automation-runner:morning-briefing`.
- `google-calendar` — bidirectional calendar sync. Provides
  `data-source:google-calendar`.
- `projects-index` — shallow index of `projects_root` for dev-hat context.
  Skill shape.
- `scheduler` — cron runner Fitting. Provides `automation-runner:scheduler`.
- `artifact-store` — filesystem-backed artifact storage with namespaces
  (`documents/`, `automations/`, `voice/`). Provides
  `artifact-store:filesystem`.
- `documents` — markdown Documents workspace layered on Artifact Store, with
  sidebar-surface UI (read + edit views, textarea editor for v1).
- `coding-subagent` — Variant A sub-agent Fitting dispatched by the
  Orchestrator. CLI-shape so it looks like every other Fitting from outside.
- `knowledge` — static reference material (docs, codebases, notes). Skill
  shape under `memory` role.

### Model Router wave (2026-06-13)

- `model-router` — fills the singleton `orchestrator` Faculty; adds
  two-stage routing (gateway pre-route → act), profile-based policy,
  compiled `{{routing}}` section, own-port view + simulator. Supersedes
  `garrison-orchestrator` + `tier-classifier` (both parked).
- `improver` — nightly Improver Fitting: reviews skill/fitting quality against
  the live codebase and emits improvement proposals. Provides
  `automation-runner:improver`. Runs under `observability`.
- `agent-sdk-runtime` — runtime Fitting hosting the Anthropic Agent SDK loop.
  Provides `runtime:agent-sdk`.
- `codex-runtime` — runtime Fitting bridging Codex CLI. Provides
  `runtime:codex`.
- `gemini-runtime` — runtime Fitting bridging Gemini CLI. Provides
  `runtime:gemini`.
- `deepgram-voice` — voice channel Fitting using Deepgram STT/TTS. Provides
  `voice:deepgram`. Own-port headless backend on `7085`.

The Phase 5 / 5.5 Sequoias decomposition shipped `worktrees-sequoias`,
`session-view-sequoias`, and `terminal-armory-default` into the seed
set; the 2026-06-11 Dev Env consolidation replaced all three with a
single `dev-env` Fitting (`fittings/seed/dev-env`, `sessions` role,
own-port UI on `7086`, providing the singleton `dev-env` capability).
Each Claude Code session is a tab pairing a Claude PTY and a shell PTY
with the live browser pane, which consumes the separate `browser`
Fitting. The Workbench shell area was dissolved 2026-05-17; the
own-port UIs that survive it are surfaced by the sidebar Views
section.

The Monitor Faculty (2026-05-16) adds `monitor-default`, which is the
first Fitting to ship with its own React UI on its own port (default
`7077`). The pattern that governs UI-bearing Fittings — own server,
own port, status file at `~/.garrison/ui-fittings/<id>.json`,
consumed by URL link with a health check — is documented in
[UI-FITTINGS.md](./UI-FITTINGS.md) and is canonical for every future
UI Fitting.

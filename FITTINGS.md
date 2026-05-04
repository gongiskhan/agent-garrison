# Agent Garrison Seed Fittings

v1 starts with six seed Fittings as local APM packages under
`fittings/seed/`. They are local-path dependencies during bootstrap
and can be split into standalone git repos after the runner flow is
proven. Capability wiring (`provides` / `consumes`) is summarised in
`fittings/seed/README.md`.

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

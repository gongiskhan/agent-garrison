# Agent Garrison Seed Components

v1 starts with six seed components as local APM packages under `components/seed/`. They are local-path dependencies during bootstrap and can be split into standalone git repos after the runner flow is proven.

## Tier Classifier

- Primitive: `classifier`
- Shape: `skill`
- Package: `components/seed/tier-classifier`
- Config schema: `tier_floor` integer, default `3`; `plan_threshold` integer, default `3`.
- Verify example:

```yaml
verify:
  command: test -f .claude/skills/tier-classifier/SKILL.md && echo ok
  expect: ok
```

## Memory Component

- Primitive: `memory`
- Shape: `skill`
- Package: `components/seed/memory`
- Config schema: `recency_window` integer, default `20`; `persistence_cadence` string, default `hourly`; `compiled_memory_path` path, default `memory/compiled.md`.
- Verify example:

```yaml
verify:
  command: test -f .claude/skills/garrison-memory/SKILL.md && echo ok
  expect: ok
```

## Loop Heartbeat

- Primitive: `heartbeat`
- Shape: `script`
- Package: `components/seed/loop-heartbeat`
- Config schema: `cadence_minutes` integer, default `40`; `gateway_url` string, default `http://127.0.0.1:4777/jobs`.
- Verify example:

```yaml
verify:
  command: test -f apm_modules/_local/loop-heartbeat/scripts/heartbeat.mjs && echo ok
  expect: ok
```

## HTTP Gateway

- Primitive: `gateway`
- Shape: `script`
- Package: `components/seed/http-gateway`
- Config schema: `port` integer, default `4777`; `bind_host` string, default `127.0.0.1`.
- Verify example:

```yaml
verify:
  command: test -f apm_modules/_local/http-gateway/scripts/gateway.mjs && echo ok
  expect: ok
```

## Browser Automation

- Primitive: `automations`
- Shape: `cli-skill`
- Package: `components/seed/browser-automation`
- Config schema: `browser` select, default `chromium`; `headless` boolean, default `false`.
- Verify example:

```yaml
verify:
  command: test -f .claude/skills/browser-automation/SKILL.md && echo ok
  expect: ok
```

## Trello Data Source

- Primitive: `data-sources`
- Shape: `cli`
- Package: `components/seed/trello-data-source`
- Config schema: `board_id` string; `tasks_truth_file` path, default `tasks/trello.md`.
- Tasks: declares `source: trello` and `truth_file: tasks/trello.md`.
- Verify example:

```yaml
verify:
  command: test -f apm_modules/_local/trello-data-source/scripts/trello-sync.mjs && echo ok
  expect: ok
```

## Package Shape

Every seed package uses this minimum layout:

```text
components/seed/<id>/
  apm.yml
  .apm/
    skills/<name>/SKILL.md
    prompts/<name>.prompt.md
    instructions/<name>.instructions.md
    hooks/<name>.json
  scripts/
  ui/
```

Only the files needed by each component are present. Verify hooks must prove installed output exists after `apm install`, not merely that the source package exists.

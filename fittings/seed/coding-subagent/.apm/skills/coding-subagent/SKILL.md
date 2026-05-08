---
name: Coding Sub-Agent
description: Plan and execute substantial coding work on real projects. Spawns an isolated SDK sub-agent in the project folder; captures the plan as a Document; on user approval executes against the project.
---

# Coding Sub-Agent

Plan-then-execute pipeline for substantial coding work on a project on
disk. The conversational session stays clean; the sub-agent owns its
own context.

## When to use

- The user describes a feature, fix, or refactor that touches multiple
  files or needs more than ~20 lines of code.
- The user says "plan it", "do it", "build X", "implement Y" against a
  project name.
- Any work where getting it wrong wastes meaningful time and a written
  plan is cheaper than retrying.

## When NOT to use

- Single-file edits under ~20 lines (variable rename, typo, one-line
  change). Use Edit / Bash directly.
- Reading a file to answer a question. Use Read directly.
- A single bash command to check something. Run it directly.

Rule of thumb: if you can describe the change in one sentence and
execute it in under 30 seconds, do it directly. Otherwise, plan.

## CLI

The CLI runs from the fitting's installed directory.

```bash
# Plan (read-only)
node apm_modules/_local/coding-subagent/scripts/coding-subagent.mjs \
    plan --project <name> --goal "<one-sentence-goal>"

# Execute (writes files; pass the plan's document id)
node apm_modules/_local/coding-subagent/scripts/coding-subagent.mjs \
    execute --plan-id <document-id> --project <name>

# Kill a running execution (rare; user clicks Stop in Run tab)
node apm_modules/_local/coding-subagent/scripts/coding-subagent.mjs \
    kill --execution-id <id>
```

## Pattern

1. Resolve the project name. If ambiguous, use `projects-index` to
   disambiguate or ask the user which project.
2. Run `plan`. The CLI prints JSON with `plan_url`
   (`garrison://documents/<id>`) and the full plan markdown. Show
   both to the user — render the plan inline AND surface the URL so
   the user can click through to edit it in Documents before
   approving.
3. Wait for the user's reply.
   - **Approval** ("yes", "go", "ship it", "approve", "do it") → run
     `execute --plan-id <id>`. Always pass the document id, never the
     in-context plan text — this way user edits to the captured
     Document flow through.
   - **Rejection** ("no", "stop", "abort") → acknowledge and stop.
   - **Change request** (anything asking the plan to be different) →
     run `plan` again with the updated goal.
4. On `execute` completion, post the summary to chat. The Run tab's
   sub-agent pane shows the live execution log.

## Output shape

`plan` stdout (JSON):
```json
{
  "execution_id": "...",
  "plan_id": "...",
  "plan_url": "garrison://documents/...",
  "plan": "## Goal\n..."
}
```

`execute` stdout (JSON):
```json
{
  "execution_id": "...",
  "project": "agent-garrison",
  "plan_id": "...",
  "summary": "## What I did\n..."
}
```

## Configuration

Override via fitting config in the composition's `apm.yml`:

- `subagent_model` (default `opus`) — model alias for sub-agent runs.
- `subagent_permission_mode` (default `bypassPermissions`) —
  permission mode for file edits.
- `max_plan_turns` (default 30) — cap turns during planning.
- `max_execute_turns` (default 200) — cap turns during execution.

## Bash timeout

Real coding work runs minutes. When invoking `execute`, pass a long
Bash timeout (e.g. 1200000 = 20 minutes). The CLI streams to a log
file regardless of how long the call blocks the operative; the user
can watch progress in the Run tab's sub-agent pane.

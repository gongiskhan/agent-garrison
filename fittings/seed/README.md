# Seed Fittings

These seven Fittings ship inside the Garrison repo as the bootstrap stack.
They are functional reference implementations and the targets of every
test in the codebase.

| Faculty       | Fitting              |
|---------------|----------------------|
| heartbeat     | loop-heartbeat       |
| classifier    | tier-classifier      |
| memory        | memory               |
| gateway       | http-gateway         |
| automations   | browser-automation   |
| data-sources  | trello-data-source   |
| orchestrator  | personal-operative   |

## Capability wiring

Each seed declares `provides` and/or `consumes` in its `x-garrison`
block. The composer runs the resolver over the union of selected
Fittings and refuses to mark Compose ready until the wiring resolves.

| Fitting             | Provides                              | Consumes                                          |
|---------------------|---------------------------------------|---------------------------------------------------|
| loop-heartbeat      | automation-runner:loop-heartbeat      | orchestrator (one)                                |
| tier-classifier     | agent-skill:tier-classifier           | —                                                 |
| memory              | memory-store:garrison-memory          | vault (optional-one)                              |
| http-gateway        | —                                     | orchestrator (one)                                |
| browser-automation  | —                                     | vault (optional-one)                              |
| trello-data-source  | —                                     | vault (optional-one)                              |
| personal-operative  | orchestrator:personal-operative       | —                                                 |

The vault capability is satisfied by the runtime-synthetic provider
(`__runtime__`) so `optional-one` consumers always resolve.

## Personal Operative — the default Orchestrator

`personal-operative` is the seed Orchestrator Fitting. It encodes the
heartbeat-driven personal-agent pattern that OpenClaw, Hermes Agent, and
similar projects converge on:

1. Wake on a heartbeat tick.
2. Triage a single ranked queue from inbox (Channels), scheduled jobs
   (Scheduler), and tasks (Data sources).
3. Route each item through the Classifier — T1–T2 execute directly,
   T3+ forces plan-then-route.
4. Honour the global guardrails (`max_tasks_per_tick`,
   `max_tool_calls_per_tick`, `max_spend_per_day`).
5. Verify before claiming success.
6. Persist context to compiled memory at the configured cadence.
7. Sleep until the next tick.

Tunable via four knobs in `x-garrison.config_schema`:

- `tone` — terse / conversational / formal.
- `idle_behavior` — passive (sleep when queue is empty) or proactive
  (one light-weight chore per idle tick).
- `priority_label` — task label name that jumps an item to the head of
  the queue.
- `silent_when_no_work` — when true, no "nothing to do" updates land in
  channels.
- `report_channel` — optional Channels Fitting id for end-of-day
  summaries and escalations.

The full Orchestrator system prompt lives at
`personal-operative/.apm/prompts/personal-operative.prompt.md`.

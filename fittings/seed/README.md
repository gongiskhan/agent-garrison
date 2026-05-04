# Seed Fittings

These six Fittings ship inside the Garrison repo as the bootstrap stack.
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

The vault capability is satisfied by the runtime-synthetic provider
(`__runtime__`) so `optional-one` consumers always resolve.

## Orchestrator gap

There is no orchestrator Fitting in this milestone. Compositions that
select `loop-heartbeat`, `http-gateway`, or any other Fitting that
consumes `orchestrator` will report `missing-required: orchestrator`
in Compose readiness until the reference orchestrator Fitting lands in
a later phase.

Until then, the gap is expected. Local dogfooding of the heartbeat /
gateway pair is still possible — the runtime spawns Claude Code with
the assembled orchestrator+soul system prompt regardless of whether an
orchestrator-providing Fitting is present.

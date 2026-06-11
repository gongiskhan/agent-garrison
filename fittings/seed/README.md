# Seed Fittings

These Fittings ship inside the Garrison repo as the bootstrap stack.
They are functional reference implementations and the targets of every
test in the codebase.

The directory holds more Fittings than the live stack: the 2026-06-07
Quarters pivot parked the personal-assistant generation (souls,
`personal-operative`, `loop-heartbeat`, `tier-classifier`, `scheduler`,
`coding-subagent`, `documents`, `projects-index`, `testing`,
`mcp-gateway`, `browser-automation`, `google-calendar`,
`morning-briefing`, `outpost-actions`, `vault-sync`). Those directories
stay on disk for history but are de-listed from `data/library.json` —
they carry dropped capability kinds and no longer parse against the
shrunk schema. `trello-data-source` was parked with them and **revived
2026-06-10** under the `memory` role (the `data-source` kind came back
with it).

## Roles

Survivor Fittings (the `data/library.json` set) by role — the six roles
of the Quarters pivot:

| Role          | Fittings                                                                 |
|---------------|--------------------------------------------------------------------------|
| orchestrator  | garrison-orchestrator                                                    |
| channels      | slack-channel, web-channel-default, deepgram-voice                      |
| gateway       | http-gateway                                                             |
| memory        | memory, trello-data-source                                               |
| observability | monitor-default                                                          |
| sessions      | artifact-store, workspaces, browser-default, terminal-armory-default, screen-share-default, worktree-management-sequoias, session-view-sequoias, outpost-tailscale-host |

The own-port Fittings (the `own_port` metadata flag — Monitor pattern)
serve their own UI/backend on their own port: monitor-default (7077),
terminal-armory-default (7078), screen-share-default (7079),
worktree-management-sequoias (7080), session-view-sequoias (7081),
outpost-tailscale-host (7082), web-channel-default (7083),
browser-default (7084), deepgram-voice (7085, headless backend).

## Capability wiring

Each seed declares `provides` and/or `consumes` in its `x-garrison`
block. The composer runs the resolver over the union of selected
Fittings and refuses to mark Compose ready until the wiring resolves.

| Fitting                      | Provides                                  | Consumes                                                                      |
|------------------------------|-------------------------------------------|--------------------------------------------------------------------------------|
| garrison-orchestrator        | orchestrator:garrison-orchestrator        | —                                                                              |
| http-gateway                 | —                                         | orchestrator (one)                                                             |
| memory                       | memory-store:garrison-memory              | vault (optional-one)                                                           |
| trello-data-source           | data-source:trello                        | vault (one)                                                                    |
| slack-channel                | channel:slack                             | vault (one)                                                                    |
| web-channel-default          | channel:web                               | voice (optional-one)                                                           |
| deepgram-voice               | voice:deepgram                            | vault (one)                                                                    |
| monitor-default              | monitor:monitor                           | —                                                                              |
| artifact-store               | artifact-store:fs-store                   | —                                                                              |
| browser-default              | —                                         | —                                                                              |
| workspaces                   | —                                         | view (any)                                                                     |
| terminal-armory-default      | terminal-session:terminal-armory-default  | outpost (any)                                                                  |
| screen-share-default         | screen-share:screen-share-default         | —                                                                              |
| worktree-management-sequoias | worktree:worktree-management-sequoias     | outpost (any)                                                                  |
| session-view-sequoias        | session-view:session-view-sequoias        | worktree (optional-one), terminal-session (optional-one), outpost (any)        |
| outpost-tailscale-host       | outpost:outpost-tailscale-host            | —                                                                              |

Notes:

- The capability-kind vocabulary is `capabilityKinds` in
  `src/lib/types.ts`: `orchestrator`, `memory-store`, `data-source`,
  `channel`, `vault`, `artifact-store`, `terminal-session`, `worktree`,
  `session-view`, `screen-share`, `outpost`, `monitor`, `voice`, `view`.
- The `vault` capability is satisfied by the runtime-synthetic provider
  (`__runtime__`), so vault consumers always resolve. Own-port Fittings
  that consume `vault` get the secrets injected into their spawn env
  (`vaultEnvForEntry`); a keyless start is healed via the spawn-record
  contract (see [`docs/UI-FITTINGS.md`](../../docs/UI-FITTINGS.md)).
- `view` is **derived, never declared**: the resolver synthesises one
  `view` provision per produced view, which is how Workspaces discovers
  tileable views with cardinality `any`.
- `deepgram-voice` provides `voice` to `web-channel-default` (push-to-talk
  STT, read-aloud TTS, live `/stream` endpointing); the Deepgram key
  stays server-side.
- `trello-data-source` pairs `data-source:trello` with a Trello-backed
  derived Tasks truth file (`tasks/trello.md`); its `for_consumers`
  block teaches the Operative the `trello.py` CLI verbs at prompt
  assembly time.

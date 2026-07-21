# Seed Fittings

These Fittings ship inside the Garrison repo as the bootstrap stack.
They are functional reference implementations and the targets of every
test in the codebase.

The directory holds more Fittings than the live stack: the 2026-06-07
Quarters pivot parked the personal-assistant generation (souls,
`personal-operative`, `loop-heartbeat`, `tier-classifier`, `scheduler`,
`coding-subagent`, `documents`, `projects-index`, `testing`,
`mcp-gateway`,
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
| sessions      | artifact-store, dev-env, browser-default, screen-share-default, outpost-tailscale-host |

The own-port Fittings (the `own_port` metadata flag — Monitor pattern)
serve their own UI/backend on their own port: monitor-default (27077),
screen-share-default (27079), outpost-tailscale-host (27082),
web-channel-default (27083), browser-default (27084),
deepgram-voice (27085, headless backend), dev-env (27086).

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
| dev-env                      | dev-env:dev-env                           | outpost (any)                                                                  |
| screen-share-default         | screen-share:screen-share-default         | —                                                                              |
| outpost-tailscale-host       | outpost:outpost-tailscale-host            | —                                                                              |

Notes:

- The capability-kind vocabulary is `capabilityKinds` in
  `src/lib/types.ts`: `orchestrator`, `memory-store`, `data-source`,
  `channel`, `vault`, `artifact-store`, `dev-env`, `screen-share`,
  `outpost`, `monitor`, `voice`, `view`.
- The `vault` capability is satisfied by the runtime-synthetic provider
  (`__runtime__`), so vault consumers always resolve. Own-port Fittings
  that consume `vault` get the secrets injected into their spawn env
  (`vaultEnvForEntry`); a keyless start is healed via the spawn-record
  contract (see [`docs/UI-FITTINGS.md`](../../docs/UI-FITTINGS.md)).
- `view` is **derived, never declared**: the resolver synthesises one
  `view` provision per produced view, which is how the sidebar Views
  section is populated.
- `dev-env` is a **singleton** kind. The Fitting's setup is
  `node ui/build.mjs && node scripts/install-hooks.mjs` (build the UI,
  install the Claude Code hook groups tagged `fitting:dev-env`); verify
  is `probe.mjs`. It owns `~/.garrison/sessions/state.json`; sessions
  run in the project repo root on the current branch (same-branch only,
  GARRISON-FLOW-V2 D10).
- `deepgram-voice` provides `voice` to `web-channel-default` (push-to-talk
  STT, read-aloud TTS, live `/stream` endpointing); the Deepgram key
  stays server-side.
- `trello-data-source` pairs `data-source:trello` with a Trello-backed
  derived Tasks truth file (`tasks/trello.md`); its `for_consumers`
  block teaches the Operative the `trello.py` CLI verbs at prompt
  assembly time.

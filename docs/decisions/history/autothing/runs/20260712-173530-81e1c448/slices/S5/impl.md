# S5 — Garrison Assistant Fitting (impl)

WS5 / D7. A new own-port Fitting under the **sessions** role with three modes —
Answer, Guide, Build (interview belongs to Build). It never edits artifacts
directly; everything it wants to change flows through the Improver review queue
as a proposal with provenance `assistant`.

Status: **green**. `tests/garrison-assistant.test.ts` 7/7; `validate-fitting`
PASS 4/4; own-port server live-smoke-verified.

## Fitting layout

```
fittings/seed/garrison-assistant/
  apm.yml                 faculty: sessions, component_shape: plugin, own_port,
                          default_port 7095, consumes memory-store (optional-one),
                          ui.views[] (faculty-tab), verify: server.mjs --probe
  dist/index.html         static three-mode surface (the derived `view`)
  lib/
    index-store.mjs       buildIndex()/answer() — keyword+section retrieval over
                          docs/**.md (autothing run logs skipped) + every Fitting's
                          apm.yml summary + SKILL.md/instructions/README. Symlinks
                          never followed (I2). No embeddings, no network.
    interview.mjs         nextStep(answers) adaptive questionnaire + draftProposals()
    proposals.mjs         fileProposals() -> Improver review-queue.json + proposals/<id>.json,
                          provenance "assistant"; refuses to overwrite a corrupt queue (I5)
    tours.mjs             launchTour(name) by-name launch directive + seed registry (WS6 wires the engine)
  scripts/
    server.mjs            own-port HTTP server (Answer/Guide/Build + /reindex + /health),
                          status-file registration, --probe
    start.mjs            runner entrypoint (scripts/start.mjs is what the runner spawns)
```

Registered in `data/library.json` and wired into `compositions/default/apm.yml`
(dependency + `selections.sessions` entry, port 7095), mirroring dev-env /
file-browser.

## Own-port contract (live-smoke-verified)

Spawned via `scripts/start.mjs` (the runner's convention). On listen the server
writes `~/.garrison/ui-fittings/garrison-assistant.json`
(`{fittingId, port, url, pid, startedAt, route, views}`) so the sidebar Views
live-link and the runner's lifecycle stop can track it, and removes it on
SIGTERM/SIGINT. Config port/host arrive as `GARRISON_GARRISONASSISTANT_PORT` /
`GARRISON_GARRISONASSISTANT_BIND_HOST` (the runner's `ownPortConfigEnv`
projection, matching ports-default / power-default). The port binds exactly —
EADDRINUSE exits 1, never an auto-shift. `GET /health` -> `{ok, port, pid, index}`.

## Answer — 3 grounded questions, real sources

Every cited source is a real repo file (the test asserts `readFileSync`
succeeds for each). Sources after dropping the ephemeral `docs/autothing/**`
run logs (index 2301 -> 1746 sections):

| Question (category) | Sources cited |
| --- | --- |
| "what is the runtimes faculty" (a Faculty) | `docs/FACULTIES.md`, `docs/DECISIONS.md` |
| "how do I use the taste Fitting" (a Fitting's usage) | `fittings/seed/taste/apm.yml`, `docs/RUNTIME_MATRIX.md`, `docs/CONTRIBUTING.md` |
| "how does composition switching work" (a workflow, WS4) | `docs/GARRISON_ROADMAP.md`, `docs/FACULTIES.md` |

Retrieval is deterministic keyword+section scoring (heading-match boost); no
model call. The `model` config (`ollama-local/qwen2.5:3b`) is the local-only
polish path, off by default — never an Anthropic endpoint.

## Guide — launch a tour by name

`launchTour("switch-composition")` ->
`{launch:true, name, title:"Switch the active composition", route:"/", mode:"guided", url:"/?tour=switch-composition"}`.
Unknown names throw `unknown tour "<name>" — known tours: …` (fails loud). The
seed registry (quarters-basics, compose-a-fitting, clone-a-fitting,
switch-composition) plus any `tours/*.json` shipped beside the Fitting; WS6
replaces the registry source while keeping this launch contract.

## Build — adaptive interview -> provenance-assistant proposals

One interview loop asked **4 adaptive** questions (later questions depend on
earlier answers):

1. `daily` — "What do you do most days in this project — the task you repeat the most?"
2. `byhand` — "What did you do BY HAND this week that a tool could have done?"
3. `repeat` — "What multi-step thing do you repeat that always follows the same steps?"
4. `byhand_detail` — branches on the `byhand` answer: a `lint/test/build/ci`
   answer asks "should it run on every commit, on a schedule, or only when you
   ask?"; a `report/status` answer asks "who reads it and how often?"; a
   `deploy/release` answer asks "what has to be TRUE before it's safe to run
   automatically?".

At completion it filed **2 proposals** into the real Improver review queue
(`~/.garrison/improver/review-queue.json` + `proposals/<id>.json`):

- `targetClass: quarters/skill` — a drafted SKILL candidate
- `targetClass: automations/job` — a drafted AUTOMATION candidate

Both carry `rule:"assistant"`, `provenance:"assistant"`, `status:"pending"` —
visible and approvable in the Improver UI (the queue-pane renders every
proposal with Approve/Reject; pending => Approve enabled). The Assistant writes
only the proposal, never the artifact.

## Codex hardening (5 fixes dispatched to impl-s5)

- **own-port status file** (impl-s5, committed `2150399`) — the server never
  registered its `ui-fittings/*.json`; now does, verified by live smoke.
- **config-env normalization** (impl-s5, `2150399`) — read the runner's
  `GARRISON_GARRISONASSISTANT_PORT/_BIND_HOST` instead of `PORT`/`BIND_HOST`.
- **I2 index symlink escape** — `walkMarkdown` used `statSync` (follows links); a
  symlink under `docs/` or a Fitting could leak an out-of-repo file into an
  answer. Now `lstat`-guarded (`isRealPath`), symlinks skipped.
- **I4 malformed `/interview` 500** — a `null`/non-`{id}` element crashed
  `nextStep`'s `a.id` deref -> 500. The route now validates the `answers[]`
  shape and returns 400 for bad input.
- **I5 queue-clobber on corrupt** — `loadQueue` returned `[]` on a corrupt queue
  file, so the next write destroyed prior proposals. It now throws loudly and
  refuses to overwrite.

## Tests (`tests/garrison-assistant.test.ts`, 7/7)

- manifest parses as a sessions own-port Fitting consuming memory-store optionally
- Answer mode: answers three questions, each citing real source files
- Guide mode: resolves a known tour to a launch directive and fails loud on unknown
- Build interview: asks >=4 questions, adapts to answers, then files a skill + an automation proposal
- Build interview: adapts differently for a non-CI by-hand answer
- hardening I2: the index never follows a symlink out of the repo
- hardening I5: fileProposals refuses to overwrite a corrupt queue (never data-loss)

## Commits

- `9cb023b` feat — Answer/Guide/Build Fitting (grounded Q&A, tour launcher, interview->proposals)
- `ea9dab4` / `55c5f88` test — manifest + grounded Answer + tour-launch + adaptive interview->proposals
- `e52ca37` fix — own-port contract: start.mjs entrypoint + EADDRINUSE guard
- `2150399` fix — own-port status file + config-env normalization + index autothing-skip (impl-s5 own-port findings)
- I2/I4/I5 hardening + their tests (lead, on top of the above)

Full suite: 2086 green (RUN_LOG, from the lead's build). Targeted file 7/7,
validate 4/4 on the current tree.

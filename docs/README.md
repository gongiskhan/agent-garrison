# Agent Garrison

Agent Garrison is an open-source, local-first **control plane over your real
`~/.claude`**. It lets you station APM-packaged **Fittings** into **Faculty**
slots, save the result as an APM manifest, run the composed **Operative**
locally, and stream every runner step.

Source-of-truth project overview for tooling agents:
[../CLAUDE.md](../CLAUDE.md). The original v1 bootstrap spec is preserved at
[SPEC.md](./SPEC.md), which is **superseded** — read it as history, not as
current shape.

## Start

Garrison runs as **profiled instances out of this one checkout**. Never launch
`next dev` directly; the launcher projects the ports, the Garrison home, and
the Claude config dir per profile.

```bash
npm install
npm run dev            # DEV instance  -> http://127.0.0.1:7777
```

| profile | offset | app | gateway | outpost | fittings | scheduler | home |
|---|---|---|---|---|---|---|---|
| dev | 0 | 7777 | 4777 | 3702 | 70xx | 7099 | `~/.garrison-dev` |
| **prod** | **+1000** | **8777** | **5777** | **4702** | **80xx** | **8099** | `~/.garrison` + real `~/.claude` |
| codex | +20000 | 27777 | 24777 | 23702 | 270xx | 27099 | `~/.garrison-codex` |

The compositions carry ONE port map (the 7xxx family); every instance is that
map plus a fixed offset defined in `src/lib/instance-profile.ts`. Never
hardcode a port. Only **prod** is published to the tailnet, and only prod owns
the real `~/.claude`.

Deploying committed code to the always-on prod instance:

```bash
npm run prod:redeploy  # build -> down -> restart garrison-prod -> up
```

The app has no auth and only talks to localhost (the tailnet address is
`tailscale serve` in front of prod). v1 targets Claude Code and shells out to
Microsoft APM for install, audit, and lockfile behavior. If `apm` is not
installed, the dashboard shows a preflight error instead of pretending the
Operative started.

## Repo Shape

Spec and design docs (all under `docs/`):

- `architecture.md` — `src/lib` module map and UI surfaces. Start here for
  implementation work.
- `METADATA.md` — `x-garrison` schema reference, including `setup`,
  `for_consumers`, and UI contract v2.
- `FACULTIES.md` — per-Faculty notes. **17 faculties**: 9 core roles
  (`orchestrator`, `channels`, `gateway`, `runtimes`, `memory`,
  `observability`, `sessions`, `surfaces`, `modes`), 7 optional capability
  faculties (`knowledge`, `research`, `building`, `code-intelligence`,
  `design`, `browser-qa`, `coordination`), plus `connectors`.
- `FITTINGS.md` — seed Fitting catalogue (partial; the repo ships ~62 seeds).
- `CAPABILITIES.md` — the **17** capability kinds: `orchestrator`, `modes`,
  `identity`, `memory-store`, `automation-runner`, `connector`, `runtime`,
  `mcp-gateway`, `channel`, `vault`, `dev-env`, `screen-share`, `outpost`,
  `monitor`, `voice`, `duty`, `view`. Note `modes` is superseded by `identity`
  (2026-07-13, MARATHON-V3 D7); `data-source` and `artifact-store` are dropped.
- `RUNTIME_MATRIX.md`, `RUNTIME_DEGRADATIONS.md` — runtime engine support.
- `UI-FITTINGS.md` — own-port Fitting contract.
- `V1_DOD.md` — Definition of Done checklist. **Stale**: predates the Quarters
  pivot; read it alongside the roadmap, not on its own.
- `GARRISON_ROADMAP.md` — live roadmap, 5 Stages (restructured 2026-05-26 from
  the prior 9 phases).

Governance:

- `GOVERNANCE.md` — positioning, the Honesty Test, contribution model,
  validation pipeline. Licence is **MIT** (selected 2026-07-01).
- `CONTRIBUTING.md` — how to submit a Fitting or contribute to the platform.
- `DECISIONS.md` — append-only log of design decisions.
- `decisions/` — long-form decision records (the Quarters pivot, the sessions
  split, …).

Historical records:

- `phases/` — the prior 9-phase plan's verification evidence, kept verbatim.
- `autothing/runs/` — per-run build artifacts. Actively written by new runs;
  completed runs with no referrers are pruned periodically.

Source layout:

- `compositions/<id>/apm.yml` — source of truth for each composition.
- `fittings/seed/` — local APM seed Fittings.
- `src/` — Next.js 14 app (Garrison dashboard / Compose / Quarters / Vault /
  sidebar Views / per-Fitting routes under `/fitting/<id>/`) plus `src/lib/`
  runtime modules (`runner.ts`, `capabilities.ts`, `vault.ts`, `metadata.ts`,
  `instance-profile.ts`, `quarters.ts`, `fitting-views.ts`, …).

Note the Armory and Run surfaces were folded (2026-06-18): `/armory` redirects
to `/compose`, `/run` redirects to the dashboard at `/`.

## Validating a Fitting

```bash
tsx scripts/validate-fitting.ts fittings/seed/basic-memory
```

Runs the four-check validation pipeline against any Fitting directory.
See [GOVERNANCE.md §4.3](./GOVERNANCE.md) for what each check does.

## Tests and typecheck

```bash
npm run typecheck
npm test
```

Integration smoke (live SDK + composition wiring):

```bash
npm run check:integration
```

# Agent Garrison

Agent Garrison is a local-first composer and runner for autonomous agent setups. It lets you station trusted APM-packaged components into primitive slots, inspect the manifest, run the operative locally, and stream every runner step.

## Start

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

The app has no auth and only talks to localhost. v1 targets Claude Code and shells out to Microsoft APM for install, audit, and lockfile behavior. If `apm` is not installed, the Run tab shows a preflight error instead of pretending the operative started.

## Repo Shape

- `AGENTS.md` is the source-of-truth bootstrap spec.
- `METADATA.md`, `PRIMITIVES.md`, `COMPONENTS.md`, and `V1_DOD.md` define the first implementation contracts.
- `compositions/<id>/apm.yml` is the source of truth for each composition.
- `components/seed/` contains local APM seed packages used during bootstrap.
- `data/vault.json` stores encrypted secrets and is created with file mode `0600`.

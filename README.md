# Agent Garrison

**Compose autonomous agents the way you want them, not the way someone else decided they should work.**

Agent Garrison is a local web app that lets you build and run **Operatives** — autonomous Claude Code setups — by selecting, configuring, and wiring together **Fittings** in named **Faculty** slots. Every layer is visible: the manifest, the prompts, the secrets vault, the capability wiring, the logs. Nothing important hides behind an opaque runtime.

Open-source. Local-first. Single-user. No cloud, no auth, no telemetry.

---

## Why Garrison

### Control for practitioners who already have opinions

Platforms like OpenClaw and Hermes make reasonable defaults for newcomers, but practitioners who have already formed views about how their agent should behave keep running into those defaults. Rate limiting that isn't theirs to tune. Routing behavior baked into the runtime. Memory strategies they didn't pick. Garrison removes these constraints by giving you a thin runtime and letting you decide what goes in each slot. The Orchestrator, the Soul, the Memory strategy, the Channels — every Faculty is filled by a Fitting you chose. Nothing gets decided for you.

### Transparency that makes customization practical

Because most of what an Operative does lives in natural language — skills, prompts, the Soul, the assembled system prompt — Garrison's outputs are readable and auditable end-to-end. You can open `assembled-system-prompt.md` after every run and see exactly what the agent was told. You can edit a Fitting's prompt, save it, and watch the dev watcher pick it up. Nothing important is hidden inside a library call. This transparency is what makes customization practical rather than aspirational.

### Deployability for builders who need governance

An agent you cannot explain to a business client is an agent you cannot sell to one. Because Garrison makes every layer visible and every behavior traceable to the Fitting that produced it, Operatives built on it are governable. Governance can be layered on progressively. Automation can be introduced incrementally — only what the builder chose to automate gets automated, in the way the builder chose. This is the architecture that lets a solo practitioner hand a working Operative to a paying customer.

---

## Built on APM

Garrison builds on **APM** (Agent Package Manager), Microsoft's open-source package manager for the agent layer. APM exists because building agents is genuinely new territory: even experienced software developers routinely underestimate the primitives involved — skills, access, channels, memory, orchestration — and there was no NPM-equivalent for that world before APM filled the gap. APM gained thousands of GitHub stars within days of release. Garrison aligns with APM's vision: it is the thin, composable runtime that takes APM's package model — manifest, install, audit, lockfile pinning — and turns it into running Operatives the builder fully controls.

Garrison adds one block to the APM manifest: `x-garrison`. That block carries the Faculty assignment, the capability declarations (`provides` / `consumes`), the verify hook, and the UI view definitions. APM owns the rest.

---

## Core concepts

| Term | What it means |
|------|--------------|
| **Operative** | A running autonomous agent — the composed, executing thing. |
| **Faculty** | A named capability slot in a composition: Orchestrator, Soul, Channels, Memory, Skills, and so on. |
| **Fitting** | The concrete implementation installed into a Faculty slot. A Fitting is a git-backed APM package with an `x-garrison` metadata block. |
| **Fittings Registry** | The curated catalog of available Fittings. Browsable at `/armory`. |
| **`x-garrison`** | The metadata block inside an APM `apm.yml` manifest where Garrison-specific declarations live. |

**Faculties:** 14 composition Faculties (`heartbeat`, `scheduler`, `data-sources`, `knowledge-base`, `automations`, `skills`, `memory`, `classifier`, `gateway`, `channels`, `observability`, `soul`, `orchestrator`, `artifact-store`) plus 4 Workbench Faculties (`terminal`, `screen-share`, `worktree-management`, `session-view`) and a derived `tasks` Faculty inferred from data sources.

---

## Quick start

### Prerequisites

- Node.js 20+
- Microsoft APM installed globally (`npm install -g apm`)
- Claude Code CLI installed and authenticated (`claude --version`)

### Install

```bash
git clone https://github.com/gongiskhan/agent-garrison
cd agent-garrison
npm install
```

### Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). The Compose tab is where you build an Operative; the Run tab is where you start one and watch it work.

### Other commands

```bash
npm run typecheck                                    # tsc --noEmit
npm test                                             # vitest run
npm run check:integration                            # live SDK + composition smoke
tsx scripts/validate-fitting.ts fittings/seed/<id>  # four-check validation pipeline
```

---

## A minimal composition

An Operative is defined by a single `apm.yml` file with an `x-garrison` composition block. The smallest useful one:

```yaml
name: my-operative
version: 0.1.0
target: claude
dependencies:
  apm:
    - path: ../../fittings/seed/personal-operative
    - path: ../../fittings/seed/soul
    - path: ../../fittings/seed/loop-heartbeat
    - path: ../../fittings/seed/slack-channel

x-garrison:
  composition:
    id: my-operative
    name: My Operative
    global_config:
      platform: claude-code
      guardrails:
        max_tasks_per_tick: 5
        max_spend_per_day: 25
    selections:
      heartbeat:
        - id: loop-heartbeat
          config:
            cadence_minutes: 40
```

The runner resolves capability wiring, runs `apm install`, materializes secrets from the vault, assembles the system prompt, and spawns the Operative.

---

## Repository layout

```
src/app/             Next.js routes — Compose, Run, Vault, Workbench,
                     Armory, per-Fitting sidebar surfaces, API routes.
src/lib/             Backend runtime: runner, vault, capability resolver,
                     metadata parser, artifact store, hosts, worktrees.
src/components/      React UI: Compose, Run, Vault, Armory, Workbench, Chat.
compositions/<id>/   apm.yml per composition. Filesystem is authoritative.
fittings/seed/       Seed Fittings that ship with the repo — the bootstrap
                     stack covering the most common Faculties.
data/library.json    Fittings Registry (curated catalog, 14 entries).
data/vault.json      AES-256-GCM encrypted secrets store (mode 0600).
scripts/             WS server, validation pipeline, integration check,
                     prompt refresh, Outpost host bridge.
tests/               Vitest suite: runner, capabilities, metadata,
                     fitting-view resolver, validation, seeds.
docs/                Spec, roadmap, per-phase records, governance, decisions.
```

---

## Status

Garrison is in active development. The phases below reflect what works today.

| Phase | What shipped |
|-------|-------------|
| **1 — Scaffold** | Compose tab, Run tab, vault, capability resolver, verify-step discipline, seed Fittings for a PA-shaped Operative. Done. |
| **2 — PA function** | Heartbeat, Trello data source, Slack channel, Tier Classifier, Documents Fitting. Partially landed; some T-items in progress. |
| **3 — Artifact Store + UI contract v2** | Documents Fitting, Artifact Store Faculty, per-Fitting sidebar views with a static view registry. Done. |
| **4 — Plan-then-execute** | Coding sub-agent Fitting with plan-then-execute variant. Done. |
| **5 + 5.5 — Workbench + Sequoias parity** | 4 Workbench Faculties, Workbench shell at `/workbench`, port allocation engine, env rewriting, Claude Code hook → session status pipeline. Done. |
| **6 — Outposts** | Multi-machine bridge Faculty. In progress. |
| **7 — Tasks Faculty** | Kanban-as-control-plane. Not started. |

**What is not implemented yet:**

- **Cross-session memory** — the Memory Fitting wraps an existing memory-compiler tool (`~/.claude/memory-compiler/`) but native cross-session memory as a first-class Garrison feature is not yet complete.
- **Runtime SDK** — Operatives are currently spawned by shelling out to the `claude` CLI. In-process orchestration via the Anthropic Agent SDK is planned but deferred.
- **AI-driven Fitting validators** — the validation pipeline runs architecture and quality checks; the security and prompt-injection checkers are placeholder pattern scanners pending the SDK milestone.

---

## Contributing

See [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) and [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) for guidelines and the Honesty Test that gates every design choice.

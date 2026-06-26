# Agent Garrison

**Compose autonomous agents the way you want them, not the way someone else decided they should work.**

Garrison is a local web app that composes and runs autonomous Claude Code setups. You pick the parts, wire them up, hit Run, and watch a long-running agent — an **Operative** — do its thing. Every layer is visible: the manifest, the assembled prompt, the secrets vault, the capability wiring, the logs.

Open-source. Local-first. Single-user. No cloud, no auth, no telemetry. Talks only to `localhost`.

> **New here?** Read [`docs/GARRISON_EXPLAINED.md`](./docs/GARRISON_EXPLAINED.md) — a single-document primer covering everything Garrison is, what it does, and how every piece fits together. Diagrams, the full Fitting catalogue, a worked example.

---

## What it does, in one picture

```
   COMPOSE                         RUN                       OBSERVE
   ───────                         ───                       ───────

   pick Fittings                   apm install               live logs (SSE)
   for each role                   materialise vault         per-Fitting status
   wire capabilities               run setup + verify        sidebar Views
   save to apm.yml                 assemble system prompt    embedded surfaces
                                   spawn via Agent SDK       own-port tools
                                            ↓
                                       OPERATIVE
                                       (long-running
                                        Claude Code session)
                                            ↓
                                   reachable via Channel
                                   Fittings (Slack, Web)

   QUARTERS (parallel)
   ───────────────────
   Skills · Hooks · MCPs · Plugins
   Scripts · Settings · Context · Plans
   (APM-managed, written to ~/.claude)
```

---

## The six words you need

| Word | Meaning |
|---|---|
| **Garrison** | The platform — this app. Composes, runs, observes, and manages Quarters. |
| **Operative** | The running autonomous agent — your real Claude Code session. |
| **Faculty** | A role slot in a composition. Six roles: `orchestrator`, `channels`, `gateway`, `memory`, `observability`, `sessions`. |
| **Fitting** | The thing you install into a role slot. A git-backed APM package with an `x-garrison` block. |
| **APM** | [Microsoft Agent Package Manager](https://github.com/microsoft/apm). Owns manifest, install, audit, lockfile. Garrison adds `x-garrison`. |
| **Quarters** | The `~/.claude` config surface — Skills, Hooks, MCPs, Plugins, Scripts, Settings, Context, Plans — managed by Garrison via APM. |

---

## Why Garrison

### Control for practitioners who already have opinions

Platforms like OpenClaw and Hermes make reasonable defaults for newcomers, but practitioners who have already formed views about how their agent should behave keep running into those defaults — rate limiting that isn't theirs to tune, routing baked into the runtime, memory strategies they didn't pick. Garrison removes these constraints. Every role is filled by a Fitting you chose. Nothing gets decided for you.

### Transparency that makes customisation practical

Most of what an Operative does lives in natural language — skills, prompts, the Soul, the assembled system prompt. Garrison's outputs are readable and auditable end to end. Open `assembled-system-prompt.md` after every run and see exactly what the agent was told. Edit a Fitting's prompt, save, and the dev watcher restarts the Operative in seconds.

### Deployability for builders who need governance

An agent you cannot explain to a business client is an agent you cannot sell to one. Because Garrison makes every layer visible and every behaviour traceable to the Fitting that produced it, Operatives built on it are governable. Automation gets layered in incrementally — only what you chose to automate gets automated, the way you chose.

---

## Quick start

### Prerequisites

- Node.js 20+
- Claude Code CLI installed and authenticated (`claude --version`)
- A Claude Max account (the SDK runs in-process with your auth; no API key billing)

### Install and run

```bash
git clone https://github.com/gongiskhan/agent-garrison
cd agent-garrison
npm install
npm start
```

Open [http://localhost:7777](http://localhost:7777). The Compose tab is where you build an Operative; the Run tab is where you start one and watch it work. The Quarters section surfaces your real `~/.claude` configuration managed via APM.

### Common commands

```bash
npm start                                            # next dev + outpost host
npm run typecheck                                    # tsc --noEmit
npm test                                             # vitest run
npm run check:integration                            # live SDK + composition smoke
npm run test:integration                             # GARRISON_INTEGRATION=1 vitest
npm run refresh:prompts                              # regenerate default prompts
tsx scripts/validate-fitting.ts fittings/seed/<id>   # four-check validation pipeline
```

---

## What's in the box

### Faculties — 6 roles

Post-2026-06-07 Quarters pivot, Faculties are **roles only**. The former flat 24-Faculty list collapsed into six:

```
   orchestrator   channels   gateway
   memory         observability   sessions
```

Everything else — Skills, Hooks, MCPs, Plugins, Scripts, Settings, Context, Plans — is now a **Quarters platform primitive** surfaced over your real `~/.claude` via APM, not a Faculty.

**Own-port Fittings** (serving their own React UI on their own port) survive at runtime under `sessions`, `channels`, and `observability` via the `own_port` metadata flag. Garrison links to them from the sidebar Views section:

```
   dev-env (7086)        screen-share (7079)   browser (7084)
   monitor (7077)        web-channel (7083)    outposts (7082)
   voice (7085)
```

Long-form intent per role: [`docs/FACULTIES.md`](./docs/FACULTIES.md).

### Quarters

The Quarters section (`/quarters`) gives you a live 10-category index over your real `~/.claude`:

```
   Skills     Hooks      MCPs       Plugins    Scripts
   Settings   Context    Plans      Commands   Rules
```

APM is the single writer for package-file surface. Garrison autosaves every change (no Save buttons). A drift poll surfaces any settings drift against the last-known baseline.

### Seed Fittings shipped in this repo

```
Brain                    Routing & cadence       Memory & knowledge
─────                    ─────────────────       ──────────────────
personal-operative       tier-classifier         memory
garrison-orchestrator    loop-heartbeat          projects-index
soul                     scheduler               documents
soul-engineer            morning-briefing        artifact-store
soul-architect                                   knowledge
soul-assistant           Channels                improver
soul-researcher          ────────
soul-companion           slack-channel           Data sources
                         web-channel-default     ─────────────
Runtimes                                         trello-data-source
────────                 Plumbing                google-calendar
agent-sdk-runtime        ────────
codex-runtime            http-gateway            Doing stuff
gemini-runtime           mcp-gateway             ─────────────
deepgram-voice           model-router            automations
                         vault-sync              coding-subagent
Outposts                                         testing
─────────                Own-port (views)
outpost-tailscale-host   ────────────────
outpost-actions          dev-env
                         screen-share-default
                         browser-default
                         monitor-default
```

Each Fitting is a self-contained APM package under `fittings/seed/<id>/`. Pick what you want; the rest stays uninstalled.

### Two kinds of Fitting

A useful distinction:

- **Agent-facing Fittings** ship skills, prompts, hooks, scripts, or MCP servers that the **running Operative** invokes during its work. Example: `tier-classifier`, `memory`, `trello-data-source`, `slack-channel`.
- **Tool-facing Fittings** ship a React UI on their own HTTP port. The **human** uses them in a browser tab; Garrison links to them from the sidebar Views group. Example: `dev-env` (port 7086 — one tab per Claude Code session with a Claude PTY, a shell PTY, and the live browser pane), `screen-share-default`, `monitor-default`.

Full breakdown: [`docs/GARRISON_EXPLAINED.md` §7](./docs/GARRISON_EXPLAINED.md#7-two-kinds-of-fitting-agent-facing-vs-tool-facing).

---

## How a composition runs

```
   1. apm install                  → resolves dependencies, installs packages,
                                     streams log to /run via SSE
   2. materialise .env from vault  → AES-256-GCM secrets → per-composition .env
   3. setup hooks                  → side-effect prep (clone repos, uv sync, ...)
   4. verify hooks                 → read-only sanity check; no verify = no ship
   5. start own-port Fittings      → dev-env, monitor, browser, etc.
   6. assemble system prompt       → Orchestrator + Soul + {{capabilities}}
                                     (each provider's for_consumers indented
                                     under its capability line); also projected
                                     to ~/.claude/rules/garrison-orchestrator.md
   7. spawn Operative              → @anthropic-ai/claude-agent-sdk, in-process
```

Two principles baked into the runner:

1. **Process survives tab close.** Closing the browser does not kill the Operative. Reopening shows a ring-buffer scrollback.
2. **Verify or don't ship.** Every Fitting declares a verify hook. The runner refuses to claim success without one.

---

## Capabilities — how Fittings see each other

Every Fitting declares `provides: [...]` and/or `consumes: [...]` in its `x-garrison` block. The resolver in `src/lib/capabilities.ts` walks the graph and refuses to mark Compose ready until everything resolves.

```yaml
# tier-classifier provides
provides:
  - { kind: agent-skill, name: tier-classifier }

# personal-operative consumes
consumes:
  - { kind: memory-store,      cardinality: any }
  - { kind: data-source,       cardinality: any }
  - { kind: channel,           cardinality: any }
  - { kind: vault,             cardinality: optional-one }
```

The `cardinality: any` literal is how the Orchestrator **discovers installed Fittings without hardcoding**. Add a new Fitting → it appears in the Orchestrator's `{{capabilities}}` block automatically. No Garrison code change.

Each provider Fitting can ship a `for_consumers` markdown block — usage guidance the runner injects under its line in the Orchestrator prompt at assembly time. Locality principle: the Fitting that ships a capability also ships the doc on how to use it.

Full vocabulary: [`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md).

---

## Repository layout

```
src/app/             Next.js routes — Compose, Run, Vault, Armory,
                     Quarters (/quarters), /fitting/<id>/... per-Fitting
                     routes. API under src/app/api/.
src/lib/             Backend runtime: runner.ts (lifecycle),
                     capabilities.ts (provides/consumes resolver),
                     metadata.ts (x-garrison parser + validator),
                     vault.ts (AES-256-GCM secret store),
                     artifact-store.ts, fitting-views.ts (UI contract v2
                     resolver), quarters/ (Quarters engine: global-
                     composition, primitive-state, claude-scan, reconcile,
                     state-transitions, orchestrator-projection).
src/components/      React UI: Compose, Run, Vault, Chrome, Armory,
                     Quarters panels, fitting-views registry + status hook.
packages/claude-pty/ PTY substrate — rich streaming, warm pool, xterm
                     screen reader. Used by dev-env Fitting.
packages/claude-chat/ Chat client built on claude-pty.
compositions/<id>/   apm.yml per composition. Filesystem is authoritative.
fittings/seed/       Local seed Fittings. Each is a self-contained APM
                     package; new ones ship as standalone git repos.
data/library.json    Curated Fittings Registry.
data/vault.json      AES-256-GCM encrypted secrets (mode 0600).
scripts/             validate-fitting.ts, integration-check.mjs,
                     refresh-default-prompts.ts.
tests/               Vitest suite: runner, capabilities, metadata,
                     fitting-view resolver, validation, seeds.
docs/                Spec, roadmap, per-stage records, decisions.
```

---

## Status

Garrison is in active development. The live journal is [`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md).

| Stage | Goal | Status |
|---|---|---|
| **1 — Replace IDE + CLI** | dev-env Fitting (PTY + shell + browser pane per session), worktree CRUD, session badges, screen-share, Documents + Artifact Store | Largely shipped; refining for daily use |
| **2 — Disciplined dev pipeline** | classify → plan → execute under `/goal` → validate → test → evidence → report | Design locked 2026-05-26; implementation pending |
| **3 — Mobile / orchestrator-driven** | Web channel polish, orchestrator spawns worktrees + pipelines, cross-surface continuity | Scoped; depends on Stage 2 |
| **4 — Replace claude.ai discussions** | PM/Architect hat, document-during-conversation, chat UX for long-form | Substrate shipped (Documents + Artifact Store); behaviour missing |
| **5 — Autonomous loop** | Tasks Faculty, heartbeat-driven pickup, plan-then-approve gate, evidence return | Depends on Stages 2–4 |

The **Quarters pivot** (2026-06-07) also shipped: Faculties shrank from 24 to 6 roles; Quarters config surface over `~/.claude`; orchestrator projection to `~/.claude/rules/garrison-orchestrator.md`; APM as single package writer via symlink-confined global composition. RC4 (hosted-session launcher) is deferred; the runner still genuinely spawns a process until it lands.

Some things **not implemented yet**:

- **Native cross-session memory.** The Memory Fitting is provided by `basic-memory` (`fittings/seed/basic-memory`), backed by Basic Memory: an Obsidian-native, plain-markdown vault (`~/ObsidianVault`) indexed into a local SQLite knowledge graph, with write/search/read MCP tools shared across Claude, Codex, and Gemini. First-class in-shell memory primitives are deferred.
- **AI-driven Fitting validators.** The validation pipeline runs architecture + quality checks for real; security + prompt-injection are placeholder pattern scanners pending the runtime SDK milestone.
- **RC4 hosted-session launcher.** Until it lands, `up()` spawns a Claude process via `spawnGateway`/`spawnClaude`; the projected orchestrator rules-file is the durable default.

---

## Contributing

See [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) and [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) — the latter is where the Honesty Test that gates every design choice lives.

---

## Documentation map

- **[`docs/GARRISON_EXPLAINED.md`](./docs/GARRISON_EXPLAINED.md)** — single-doc primer for new developers (start here)
- [`docs/SPEC.md`](./docs/SPEC.md) — the authoritative v1 spec
- [`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md) — live stage journal
- [`docs/FACULTIES.md`](./docs/FACULTIES.md) — per-role long form
- [`docs/FITTINGS.md`](./docs/FITTINGS.md) — Fitting authoring + seed catalogue
- [`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md) — capability vocabulary
- [`docs/METADATA.md`](./docs/METADATA.md) — `x-garrison` schema
- [`docs/UI-FITTINGS.md`](./docs/UI-FITTINGS.md) — own-port UI pattern
- [`docs/V1_DOD.md`](./docs/V1_DOD.md) — observable v1 Definition of Done
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) — decision log
- [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) — Honesty Test + contribution policy

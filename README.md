# Agent Garrison

**Compose autonomous agents the way you want them, not the way someone else decided they should work.**

Garrison is a local web app that composes and runs autonomous coding-agent setups. You pick the parts, wire them up, hit Run, and watch a long-running agent - an **Operative** - do its thing. Every layer is visible: the manifest, the assembled prompt, the secrets vault, the capability wiring, the logs.

**Platform, CLI, and model agnostic.** Claude Code is the default runtime, but it is one Fitting among several. Codex and Gemini CLI ship as runtime Fittings today, the Anthropic Agent SDK runtime too, and the Runtime Faculty's uniform adapter contract lets you add any other coding CLI (opencode, and others). The Orchestrator routes each task to whichever runtime, model, and effort you picked for it.

Open-source. Local-first. Single-user. No cloud, no auth, no telemetry. Talks only to `localhost` (and, when you choose, your own Tailscale tailnet - see [Reach it from your phone](#reach-it-from-your-phone)).

> **New here?** Read [`docs/GARRISON_EXPLAINED.md`](./docs/GARRISON_EXPLAINED.md) - a single-document primer covering everything Garrison is, what it does, and how every piece fits together. Diagrams, the full Fitting catalogue, a worked example.

---

## What it does, in one picture

```
   COMPOSE                         RUN                       OBSERVE
   ───────                         ───                       ───────

   pick Fittings                   apm install               live logs (SSE)
   for each role                   materialise vault         per-Fitting status
   wire capabilities               run setup + verify        sidebar Views
   save to apm.yml                 assemble system prompt    embedded surfaces
                                   spawn primary runtime     own-port tools
                                            ↓
                                       OPERATIVE
                                       (long-running session on
                                        Claude Code / Codex /
                                        Gemini / Agent SDK)
                                            ↓
                                   reachable via Channel Fittings
                                   (Slack, Web chat) - from your
                                   desk or your phone over Tailscale

   QUARTERS (parallel)
   ───────────────────
   Skills · Hooks · MCPs · Plugins
   Scripts · Settings · Context · Plans
   (APM-managed, written to ~/.claude)
```

---

## The words you need

| Word | Meaning |
|---|---|
| **Garrison** | The platform - this app. Composes, runs, observes, and manages Quarters. |
| **Operative** | The running autonomous agent - a real, long-running coding-CLI session (Claude Code by default, or Codex / Gemini / the Agent SDK). |
| **Faculty** | A role slot in a composition. 9 core roles (`orchestrator`, `channels`, `gateway`, `runtimes`, `memory`, `observability`, `sessions`, `surfaces`, `modes`), 7 optional capability faculties, and `connectors`. |
| **Fitting** | The part you install into a slot. A git-backed APM package with an `x-garrison` block. It does not just "fill" a role: a Fitting is the actual capability - a runtime that hosts the agent loop, a channel that carries messages, a connector that calls a live API, a memory store, a scheduler, a browser, a routing policy. |
| **Runtime** | The coding CLI that hosts the agent loop, provided by a Fitting under the `runtimes` role. One is primary; the rest are `delegate()` targets the Orchestrator routes work to. |
| **APM** | [Microsoft Agent Package Manager](https://github.com/microsoft/apm). Owns manifest, install, audit, lockfile. Garrison adds `x-garrison`. |
| **Quarters** | The `~/.claude` config surface - Skills, Hooks, MCPs, Plugins, Scripts, Settings, Context, Plans - managed by Garrison via APM. |

---

## Why Garrison

### Control for practitioners who already have opinions

Platforms like OpenClaw and Hermes make reasonable defaults for newcomers, but practitioners who have already formed views about how their agent should behave keep running into those defaults - rate limiting that isn't theirs to tune, routing baked into the runtime, memory strategies they didn't pick. Garrison removes these constraints. Every role is filled by a Fitting you chose. Nothing gets decided for you.

### Transparency that makes customisation practical

Most of what an Operative does lives in natural language - skills, prompts, the Soul, the assembled system prompt. Garrison's outputs are readable and auditable end to end. Open `assembled-system-prompt.md` after every run and see exactly what the agent was told. Edit a Fitting's prompt, save, and the dev watcher restarts the Operative in seconds.

### Deployability for builders who need governance

An agent you cannot explain to a business client is an agent you cannot sell to one. Because Garrison makes every layer visible and every behaviour traceable to the Fitting that produced it, Operatives built on it are governable. Automation gets layered in incrementally - only what you chose to automate gets automated, the way you chose.

---

## Quick start

### Prerequisites

- Node.js 20+
- The default runtime: Claude Code CLI installed and authenticated (`claude --version`), on a Claude Max account (runs with your auth, no API key billing)
- Optional other runtimes, only if you compose them: the `codex` CLI (`codex-runtime`), the `gemini` CLI (`gemini-runtime`), or the Anthropic Agent SDK (`agent-sdk-runtime`). Leave `primary_runtime` unset to use Claude Code.

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

## Reach it from your phone

Garrison talks only to `localhost`, but a single-user local app is most useful when you can also reach your Operative from the couch or the road. The path is [Tailscale](https://tailscale.com) plus the **web-channel Fitting** - no ports opened to the public internet, everything stays on your own tailnet.

1. **Bind the app to the tailnet.** `npm run start:mobile` serves Garrison on `0.0.0.0:7777` so your tailnet can reach it (plain `npm start` stays `localhost`-only). Or front it with `tailscale serve --bg 7777` to get an HTTPS tailnet URL.
2. **Expose the own-port views** (dev-env, monitor, and the web chat), which bind `127.0.0.1`, over HTTPS on the tailnet:
   ```bash
   node scripts/tailnet-serve-views.mjs        # tailscale serve each view; --dry-run to preview
   ```
   Each view lands at a deterministic HTTPS tailnet port (`8400 + localPort % 1000`, e.g. dev-env `7086` → `8486`). TLS is terminated by Tailscale, so WebSocket/SSE (the dev-env terminal, live logs, chat stream) keep working with no mixed-content errors. Garrison detects the tailnet and hands the browser the HTTPS URL automatically.
3. **Talk to the Operative from the phone.** The **`web-channel-default`** Fitting serves a mobile-first chat UI (default port `7083`) that round-trips through the gateway: you type on your phone, the Operative answers, replies can be read aloud, context usage and permission mode are visible. **`slack-channel`** gives you the same reach from Slack. Both are Channel Fittings - the Operative never spawns a CLI for them, it answers through the gateway it is already running behind.

The whole surface is yours and on your own devices: no account, no third-party server, no inbound firewall holes.

---

## What's in the box

### Faculties - roles, not primitives

Post-2026-06-07 Quarters pivot, Faculties are **roles** a Fitting fills. The former flat 24-Faculty list collapsed into **9 core roles**:

```
   orchestrator   channels        gateway     runtimes   memory
   observability  sessions        surfaces    modes
```

plus **7 optional capability faculties** (2026-06-24 - homes for the promoted Claude Code primitives, named by what they are *for*): `knowledge`, `research`, `building`, `code-intelligence`, `design`, `browser-qa`, `coordination`; plus the **`connectors`** faculty (2026-06-26) for authenticated, Vault-sealed connections to external services.

Everything else - Skills, Hooks, MCPs, Plugins, Scripts, Settings, Context, Plans - is a **Quarters platform primitive** surfaced over your real `~/.claude` via APM, not a Faculty.

**Own-port Fittings** (serving their own React UI on their own port) run under `sessions`, `surfaces`, `channels`, and `observability` via the `own_port` metadata flag. Garrison links to them from the sidebar Views section:

```
   dev-env (7086)        screen-share (7079)   browser (7084)
   monitor (7077)        web-channel (7083)    outposts (7082)
   voice (7085)          kanban-loop           improver          automations
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

A Fitting is not a config entry - it is a working part that *does something*. The seed set (registered in `data/library.json`, each a self-contained APM package under `fittings/seed/<id>/`) groups by what it does:

**Orchestration & personas** - decide what runs where, and who the Operative is
- `model-router` - the visible routing policy (Exceptions → Matrix → Continuations) that picks runtime, model, effort, and skill per task
- `garrison-orchestrator` - a thin delegating Orchestrator that routes work to specialist Soul sub-sessions
- `modes` - one Operative, three faces: Gary (personal assistant), Joe (dev, dispatches code to a native session), James (product/architect); shared voice, shared memory, name-based switching

**Runtimes** - host the agent loop (the CLI-agnostic core)
- `claude-code-runtime` - default primary; the node-pty engine driving the real interactive Claude Code CLI
- `codex-runtime` - drives `codex exec` behind the uniform runtime adapter
- `gemini-runtime` - drives `gemini -p` behind the same adapter
- `agent-sdk-runtime` - the Anthropic Agent SDK behind the adapter (structured, non-interactive)

**Memory** - recall across sessions, machines, and runtimes
- `basic-memory` - Obsidian-native markdown vault indexed into a local SQLite knowledge graph, with write/search/read MCP tools shared across Claude, Codex, and Gemini
- `vault-git-sync` - commits and pushes that vault to git on a schedule, so memory follows you across machines

**Channels** - how you reach the Operative
- `web-channel-default` - mobile-first browser chat UI (port 7083), text or voice, replies read aloud
- `slack-channel` - receives Slack mentions and DMs, round-trips replies through the gateway

**Connectors** - authenticated, Vault-sealed calls to live external services
- `google` - Gmail / Drive / Calendar as an OAuth2 action catalog
- `trello` - board lists and cards as a callable action catalog
- `deepgram-voice` - speech-to-text and text-to-speech on port 7085

**Coordination** - keep parallel sessions out of each other's way
- `coord-agentmail` - shared local agent-mail server: identities, messaging, advisory file leases
- `coord-mcp` - a planning-gate MCP: `begin_planning`/`end_planning` serialize planning per repo

**Automation & self-improvement** - run without a direct prompt
- `scheduler` - a cron-style always-on job scheduler daemon (no Claude dependency)
- `automations` - a YAML automations engine (8 step types incl. browser, connector, sub-automation) with a live SSE run viewer
- `kanban-loop` - a workflow state machine rendered as a phone-first Kanban board (some lanes hands-on, some run themselves)
- `improver` - nightly self-improvement: reads telemetry, transcripts, and evidence, then proposes reviewable skill / routing / memory changes

**Gateway** - the local entry point inbound channels and runtimes route through
- `http-gateway` - a small local HTTP gateway for inbound jobs, channels, and session checks

**Surfaces & tools** - own-port Fittings a human uses in a browser tab (Garrison links them under sidebar Views)
- `dev-env` (7086) - one tab per session: a Claude PTY + shell PTY + the live browser pane, with PR / commit flows on the current branch
- `monitor-default` (7077) - read-only visibility into every process Garrison spawns (PIDs, ports, logs)
- `screen-share-default` (7079) - ~2fps JPEG screen viewer for phone / remote access
- `browser-default` (7084) - a headless Chromium substrate the Operative can drive and see
- `file-browser` - a mobile-first file browser / viewer / editor (Monaco + Markdown) scoped to a workspace root
- `outpost-tailscale-host` (7082) - a bridge to a Tailscale-connected remote Mac

Pick what you want; the rest stays uninstalled. The long tail installs from the Armory (Fitting discovery on `/compose`).

### Two kinds of Fitting

The grouping above splits along one axis worth naming:

- **Agent-facing Fittings** give the **running Operative** new powers it invokes during its work: a runtime to run on, a memory to write to, a connector to call, a channel to answer, a scheduler to wake it, a routing policy to obey. This is most of the catalogue - the Operative is only as capable as the Fittings you stationed.
- **Tool-facing Fittings** serve a React UI on their own HTTP port for **you**, the human, in a browser tab (Garrison links them under sidebar Views). Example: `dev-env` (one tab per session with a Claude PTY, a shell PTY, and the live browser pane), `monitor-default`, `screen-share-default`, `file-browser`.

Full breakdown: [`docs/GARRISON_EXPLAINED.md` §7](./docs/GARRISON_EXPLAINED.md#7-two-kinds-of-fitting-agent-facing-vs-tool-facing).

---

## How a composition runs

```
   1. apm install                  → resolves dependencies, installs packages,
                                     streams log to /run via SSE
   2. materialise .env from vault  → AES-256-GCM secrets → per-composition .env
   3. setup hooks                  → side-effect prep (clone repos, uv sync, ...)
   4. verify hooks                 → read-only sanity check; no verify = no ship
   5. start own-port Fittings      → dev-env, monitor, browser, web-channel, etc.
   6. assemble system prompt       → Orchestrator + active Mode (soul) +
                                     {{capabilities}} (each provider's
                                     for_consumers indented under its capability
                                     line); handed to the gateway as the
                                     Operative's system prompt
   7. spawn the primary runtime    → the Runtime Fitting named by primary_runtime
                                     (default claude-code-runtime: node-pty +
                                     headless xterm driving the real CLI) via the
                                     gateway; secondary runtimes stay available
                                     as delegate() targets the Orchestrator routes to
```

Two principles baked into the runner:

1. **Process survives tab close.** Closing the browser does not kill the Operative. Reopening shows a ring-buffer scrollback.
2. **Verify or don't ship.** Every Fitting declares a verify hook. The runner refuses to claim success without one.

---

## Capabilities - how Fittings see each other

Every Fitting declares `provides: [...]` and/or `consumes: [...]` in its `x-garrison` block. The resolver in `src/lib/capabilities.ts` walks the graph and refuses to mark Compose ready until everything resolves.

```yaml
# trello (a connector) provides an action catalog and reads one Vault secret
provides:
  - { kind: connector, name: trello }
consumes:
  - { kind: vault, cardinality: one }

# web-channel-default provides a channel and optionally uses voice
provides:
  - { kind: channel, name: web }
consumes:
  - { kind: voice, cardinality: optional-one }
```

The `cardinality: any` literal is how the Orchestrator **discovers installed Fittings without hardcoding** - declare `consumes: [{ kind: connector, cardinality: any }]` and every stationed connector shows up. Add a new Fitting → it appears in the Orchestrator's `{{capabilities}}` block automatically. No Garrison code change. The live kinds are `orchestrator`, `modes`, `memory-store`, `automation-runner`, `connector`, `runtime`, `channel`, `vault`, `dev-env`, `screen-share`, `outpost`, `monitor`, `voice`, and the derived `view`.

Each provider Fitting can ship a `for_consumers` markdown block - usage guidance the runner injects under its line in the Orchestrator prompt at assembly time. Locality principle: the Fitting that ships a capability also ships the doc on how to use it.

Full vocabulary: [`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md).

---

## Repository layout

```
src/app/             Next.js routes - Compose, Run, Vault, Armory,
                     Quarters (/quarters), /fitting/<id>/... per-Fitting
                     routes. API under src/app/api/.
src/lib/             Backend runtime (flat, no sub-packages): runner.ts
                     (lifecycle), runtime-selection.ts (primary/secondary
                     runtime bridge), capabilities.ts (provides/consumes
                     resolver), metadata.ts (x-garrison parser + validator),
                     vault.ts (AES-256-GCM secret store), fitting-views.ts
                     (UI contract v2 router), and the Quarters engine as flat
                     modules: global-composition, primitive-state, claude-scan,
                     reconcile, state-transitions, orchestrator-projection.
src/components/      React UI: Compose, Run, Vault, Chrome, Connectors,
                     Quarters panels, fitting-views registry + status hook.
packages/claude-pty/ PTY substrate driving the interactive CLI under node-pty +
                     headless xterm - rich streaming, warm pool, xterm screen
                     reader. Powers claude-code-runtime, dev-env, web-channel.
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
| **1 - Replace IDE + CLI** | dev-env Fitting (PTY + shell + browser pane per session), session badges, screen-share, Documents + Artifact Store | Largely shipped; refining for daily use |
| **2 - Disciplined dev pipeline** | classify → plan → execute under `/goal` → validate → test → evidence → report | Design locked 2026-05-26; implementation pending |
| **3 - Mobile / orchestrator-driven** | Web channel polish, orchestrator spawns pipelines on the current branch, cross-surface continuity | Scoped; depends on Stage 2 |
| **4 - Replace claude.ai discussions** | PM/Architect hat, document-during-conversation, chat UX for long-form | Substrate shipped (Documents + Artifact Store); behaviour missing |
| **5 - Autonomous loop** | Tasks Faculty, heartbeat-driven pickup, plan-then-approve gate, evidence return | Depends on Stages 2–4 |

The **Quarters pivot** (2026-06-07) also shipped: the flat 24-Faculty list collapsed into roles (now 9 core roles, plus the 7 optional capability faculties and `connectors` added since); a Quarters config surface over `~/.claude`; APM as single package writer via a symlink-confined global composition; and the **Runtime Faculty** (2026-06-14) that makes Claude Code one runtime among several behind a uniform adapter. The orchestrator rules-file projection (`~/.claude/rules/garrison-orchestrator.md`) is implemented but not yet wired into `up()`; at runtime the assembled prompt is handed to the gateway instead. RC4 (hosted-session launcher) is deferred; the runner still genuinely spawns a process (via the primary Runtime Fitting) until it lands.

Some things **not implemented yet**:

- **Native cross-session memory.** The Memory Fitting is provided by `basic-memory` (`fittings/seed/basic-memory`), backed by Basic Memory: an Obsidian-native, plain-markdown vault (`~/ObsidianVault`) indexed into a local SQLite knowledge graph, with write/search/read MCP tools shared across Claude, Codex, and Gemini. First-class in-shell memory primitives are deferred.
- **AI-driven Fitting validators.** The validation pipeline runs architecture + quality checks for real; security + prompt-injection are placeholder pattern scanners pending the runtime SDK milestone.
- **RC4 hosted-session launcher.** Until it lands, `up()` spawns a Claude process via `spawnGateway`/`spawnClaude`; the projected orchestrator rules-file is the durable default.

---

## Contributing

See [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) and [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) - the latter is where the Honesty Test that gates every design choice lives.

---

## Documentation map

- **[`docs/GARRISON_EXPLAINED.md`](./docs/GARRISON_EXPLAINED.md)** - single-doc primer for new developers (start here)
- [`docs/SPEC.md`](./docs/SPEC.md) - the authoritative v1 spec
- [`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md) - live stage journal
- [`docs/FACULTIES.md`](./docs/FACULTIES.md) - per-role long form
- [`docs/FITTINGS.md`](./docs/FITTINGS.md) - Fitting authoring + seed catalogue
- [`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md) - capability vocabulary
- [`docs/METADATA.md`](./docs/METADATA.md) - `x-garrison` schema
- [`docs/UI-FITTINGS.md`](./docs/UI-FITTINGS.md) - own-port UI pattern
- [`docs/V1_DOD.md`](./docs/V1_DOD.md) - observable v1 Definition of Done
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) - decision log
- [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) - Honesty Test + contribution policy

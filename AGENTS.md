# Agent Garrison — Bootstrap Spec

**Greenfield project brief.** Drop into a fresh `agent-garrison` repo as the starting point. This document is the source of truth; everything else defers to it. The agent building this project should figure out its own implementation choices in service of the §10 Definition of Done.

---

## 0. Naming & framing

- **Project name:** Agent Garrison.
- **Repo:** `agent-garrison` (suggested GitHub: `gongiskhan/agent-garrison`).
- **Domain:** `agent-garrison.dev`.
- **What an individual agent is called:** an **operative**.
- **Metaphor:** a garrison is a fortified base where trained operatives are stationed, equipped, and dispatched. Maps onto the product: install the base → station components in primitive slots → dispatch the operative.
- **Positioning:** an open-source, local-first composer + runner for autonomous agent setups. Replaces the "install some tool and hope" flow with "see what real devs use, pick your stack, run it locally, inspect everything."
- **First user:** Gonçalo. Dogfood-first. If it doesn't help him daily for a month, it doesn't ship.

---

## 1. What it is, in one paragraph

Agent Garrison is a local web app that lets you compose an autonomous agent setup — an **operative** — from a closed set of **primitives** (heartbeat, scheduler, data sources, knowledge base, automations, testing, memory, classifier, gateway, channels, observability, soul, orchestrator, plus derived: tasks). Each primitive accepts **components** of a few well-defined shapes. Components are git-backed packages distributed via **Microsoft APM** (Agent Package Manager) — APM owns manifest, install, audit, lockfile pinning. Garrison adds a metadata layer in an `x-garrison` block inside APM's manifest. The app reads/writes the manifest, owns a local secrets vault, runs `apm install`, assembles the operative's system prompt, starts the underlying CLI agent (Claude Code in v1), streams logs, and exposes per-component UI extensions. Stop closes everything cleanly. Dev mode watches local-path components and re-applies on save.

**Tech stack is not pinned.** v1 should be implementable by whichever coding agent the user prefers. Default suggestion: Next.js 14 + TypeScript + Tailwind for the web app, since it gives a single-process full-stack story with no auth — but anything that delivers the §10 Definition of Done is acceptable.

---

## 2. Primitives (13 + derived)

Each primitive has a **cardinality** (single / multi) and a closed set of accepted **component shapes**. Tasks is *derived*. Workspace is reserved for v1.1 (see §11).

| # | Primitive | Cardinality | Component shapes | Notes |
|---|---|---|---|---|
| 1 | Heartbeat | single | script, skill, system prompt, manual instructions | The cadence that wakes the operative. Cron-style, loop-style, scheduled-task-style. Only loop variants are programmatic; the rest are manual instructions. |
| 2 | Scheduler | single | script, skill | Anything outside the heartbeat cadence. |
| 3 | Data sources | multi | MCP, CLI | Integration-flavoured. One-way fetch in v1; two-way sync later. |
| 4 | Knowledge base | multi | skill, MCP, script | Docs/codebases/refs the operative can *read*. Distinct from data sources (live API) and memory (self-learned). |
| 5 | Automations | multi | CLI+skill, MCP | Things the operative can *do* in the world: drive a browser, control a desktop, run scripted UI flows. |
| 6 | Testing framework | multi | script, skill | Includes E2E test writers. Uses Automations where it needs to drive things. |
| 7 | Memory | single | skill, system prompt, hook | What the operative knows — both within-session and across sessions. A single Memory component decides how it handles both. Config space includes things like recency window, persistence cadence, and where compiled memory is written. |
| 8 | Classifier | single | skill, system prompt | Decides what to do with each prompt. Tier model: T1–2 execute directly; T3+ plan-then-reclassify-then-route. The routing floor every prompt crosses. |
| 9 | Gateway | single | script + manual exposure instructions | The MCP-speaking entry point. Heartbeat dispatches through it. Channels POST to it. Exposure to the public internet (for inbound channels) is a manual step with documented patterns. |
| 10 | Channels | multi | plugin, skill, script | User-facing message surfaces: Telegram, Discord, Slack, WhatsApp (planned), custom UI. |
| 11 | Observability | multi | hook, script | How the loop reports health, errors, no-ops. Outputs to a Channel or a log sink. |
| 12 | Soul | single | system prompt | Identity, tone, voice, boundaries. Composes with the orchestrator at prompt-assembly time. **Orchestrator = how it behaves; Soul = who it is.** |
| 13 | Orchestrator | single, **governing** | system prompt | The behaviour spine. Coordinates all other primitives and owns global config. Rendered in the UI as the capstone, not just another row. |

**Tasks** — derived. Not user-selected. The orchestrator infers it from data sources (e.g. when a Trello data source is present, tasks flow through Trello). Source of truth for tasks = a markdown file synced to whatever system the data source declares.

**Note on the primitive set.** It's intentionally treated as a working draft. The model has been iterated on enough to be load-bearing for v1, but the goal of v1 is to prove the *system* — manifest, runner, vault, UI scaffolding — works. The primitives themselves will be refined as components get built and the boundaries get tested. Don't optimise the primitive list further before §10 is done.

---

## 3. Component model

**Component shapes are a closed set,** decided centrally, not user-extensible:

- script
- agent instructions
- manual instructions
- plugin
- skill
- hook
- system prompt
- (composite) CLI + skill
- (composite) MCP

Each component declares its target platform(s): `all`, `Claude Code`, `Codex`, or a future user-added platform.

### Component packaging — APM-native

Every Garrison component is a git repo packaged as an APM package. Standard APM layout:

```
my-component/
├── apm.yml                 # APM manifest, includes x-garrison block
└── .apm/
    ├── agents/        *.agent.md
    ├── instructions/  *.instructions.md
    ├── prompts/       *.prompt.md
    ├── skills/        <skill-name>/SKILL.md + assets
    └── hooks/         *.json + scripts/
```

APM handles install (resolves into the target CLI's native directory — `.claude/` for Claude Code, `.github/` for Copilot, etc.), audit (security scan for prompt injection / hidden Unicode), pack, and lockfile pinning. Garrison does not reimplement any of that.

### The `x-garrison` metadata block

APM's primitive set (agents, instructions, prompts, skills, hooks, plugins, MCP) is smaller than ours. Extra metadata lives in a custom YAML key inside `apm.yml` (APM preserves unknown `x-*` keys):

```yaml
x-garrison:
  primitive: classifier            # which Garrison primitive this fills
  cardinality_hint: single         # informational, validated against primitive
  config_schema:
    - key: tier_floor
      type: integer
      default: 3
      description: "Minimum tier this classifier raises every prompt to"
  verify:
    command: "test -f .claude/hooks/classifier.json && echo ok"
    expect: "ok"
  ui:
    extension: "./ui/ClassifierInspector.tsx"   # optional React component
```

Full schema lands in `METADATA.md` with a typed validator.

### Authoring

- **No in-app component authoring in v1.** Authoring = `git init`, write `apm.yml` with `x-garrison`, push. The composer reads from a curated library (§6).

### Ratings (data model only in v1; UI in v1.1)

Three axes, persisted in a JSON file (`data/ratings.json`):
1. GitHub stars on the component repo (link-out, no scraping).
2. Global Garrison rating.
3. Per-platform Garrison rating (rating declares the platform; recorded against both that platform and globally).

JSON file is fine for v1. Stays single-user. Multi-user / sync questions are a v1.2 concern at earliest.

---

## 4. Architecture

```
┌─ Agent Garrison web app (single local process) ──────────────┐
│                                                              │
│  Tabs:                                                       │
│   - Compose  (primitive rows, component pickers, config)     │
│   - Run      (start/stop, live logs, per-component verify)   │
│   - Vault    (secrets entry / round-trip)                    │
│   - Library  (browse curated components, ratings)            │
│   - <pane>   (one tab per primitive that has UI extensions)  │
│                                                              │
│  Backend:                                                    │
│   - HTTP/SSE routes for state, vault, library, runner        │
│   - Runner module: apm install + agent CLI lifecycle         │
│   - Vault module: AES-256-GCM + scrypt, file mode 0600       │
│   - Metadata module: x-garrison schema + validator           │
│   - Prompt assembly: orchestrator + soul concat              │
│                                                              │
│  Talks only to localhost. No auth. Single-user.              │
└──────────────┬───────────────────────────────────────────────┘
               │ child_process
┌──────────────▼───────────────────────────────────────────────┐
│  apm install / apm audit / apm pack / git                    │
│  agent CLI (Claude Code in v1; others later)                 │
└──────────────────────────────────────────────────────────────┘
```

Compositions are directories on disk. `apm.yml` is the manifest. **Filesystem is the source of truth** — no JSON shadow store of compositions. The UI is a view; the runner is the engine.

### Why a local web app, not a CLI / IDE / desktop app

A local web app served at `localhost:3000` matches the mental model of comparable open-source tools. One process, single command to start, open browser. No Electron. No editor fork. The web server shells out to APM and spawns the agent CLI directly.

Caveat for any hot-reloading dev server: long-lived child processes don't survive HMR. The runner should keep a process registry in a way that survives the dev loop, or the dev experience for testing the runner itself becomes painful. Production-mode start is fine.

---

## 5. The Runner

The runner is the most important new piece. Its responsibilities:

- `up(composition)` — `apm install`, materialise `.env` from vault, assemble orchestrator+soul system prompt, spawn the agent CLI with that prompt, start heartbeat / gateway / channels.
- `down(composition)` — stop processes, run teardown hooks, wipe materialised `.env`.
- `verify(composition)` — walk every component's `x-garrison.verify`, run it, report pass/fail.
- `dev(composition)` — `up` plus a file watcher on local-path deps; on change, `apm install` + restart the operative.
- `logs(composition)` — SSE stream of stdout/stderr from the operative and the runner itself.

Two principles bake in:

1. **Process survives tab close.** Closing the browser does not kill running operatives. Reopening shows scrollback (ring buffer per operative, ~10 MB or 5000 lines, whichever first).
2. **Verify-step discipline at runtime.** Every component declares a verify hook in its `x-garrison` block. The runner executes these on `up` and on demand. If verify fails, the runner reports broken state — never silent success. This is the single most important discipline in the system.

Orchestrator+soul prompt assembly: read both system-prompt files from the installed APM packages, concatenate orchestrator-then-soul, pass to the agent CLI via its system-prompt flag. This is the one place Garrison adds runtime logic APM doesn't cover.

---

## 6. The Library

A curated list of vetted components, sourced from a JSON file shipped with Garrison (later, from a git-hosted registry). Each entry:

```json
{
  "id": "tier-classifier",
  "primitive": "classifier",
  "repo": "https://github.com/example/garrison-tier-classifier",
  "summary": "Tier 1–7 routing floor; T3+ forces plan-then-reclassify-then-route.",
  "platforms": ["claude-code"],
  "ratings": { "github_stars_url": "...", "global": 4.5, "claude_code": 4.6 }
}
```

v1.1 opens issue-based community submissions (manual accept).

---

## 7. Global config (owned by the orchestrator)

Present on every composition:

- `projects_root` — where the operative goes to work on projects.
- `vault` — secrets store handle (AES-256-GCM JSON, scrypt KDF, 0600).
- `platform` — `claude-code` only in v1.
- `guardrails` — max tasks per tick, max spend/day, max tool calls per tick.
- `permissions_mode` — one of `full-auto | auto | allow-file-edits | conservative`.
- `observability_config` — where logs/alerts go (ties to Channels).

Vault details:
- AES-256-GCM, scrypt-derived key.
- File mode 0600 on `data/vault.json`.
- Two-way: only Garrison can decrypt, and only to materialise `.env` at runtime in the active composition directory. Secrets never leave the user's machine.
- Materialisation is per-composition, deleted on `down`.

---

## 8. Seed components (v1)

Six seed components, one per primitive that needs a working example. Each is its own git repo, packaged as an APM package with `x-garrison` metadata.

| Primitive | Component | What it does |
|---|---|---|
| Classifier | Tier classifier | Routing floor for every prompt: T1–2 execute, T3+ plan-then-reclassify-then-route. Configurable per-project floor. |
| Memory | Memory component | Handles both within-session recall and cross-session persistence. Config covers recency window, persistence cadence, and where compiled memory is written (e.g. an Obsidian vault, a flat file). |
| Heartbeat | Loop heartbeat | A scheduled loop that wakes the operative on a configurable cadence (default 40 min) and dispatches through the gateway. |
| Gateway | HTTP gateway | A small HTTP server (Node or Python) speaking MCP, with endpoints for inbound jobs, channel events, and session management. |
| Automations | Browser automation (Playwright + driving skill) | Canonical Automations seed — Playwright CLI plus a skill that drives it. |
| Data sources | Trello data source | A working data-source example. When present, tasks flow through Trello (the `Tasks` derived primitive picks Trello as its source of truth). |

**Port priority order** (smallest first, derisks the runner): tier classifier → loop heartbeat → memory → Playwright → Trello → gateway.

The list is suggestive, not prescriptive. The Definition of Done in §10 is what matters; equivalent components that prove the same primitive are fine.

---

## 9. UI extensions

Components can ship optional React UI extensions via `x-garrison.ui.extension`. Garrison lazy-imports the path and mounts the component inside the relevant primitive's tab.

Hosting model for v1: **static render, no sandbox.** The component author is trusted at v1 scale (single user, curated library). Components run in the host app's process. Move to iframe + postMessage when third-party authors start contributing — v1.1 concern.

A small UI kit (design tokens + a handful of Tailwind-based React primitives) gets published as its own APM package so community extensions stay visually coherent. Optional — extensions can ship vanilla Tailwind if they prefer.

---

## 10. v1 Definition of Done

Each item is observable. If it can't be pointed at, it doesn't count.

1. A single command (e.g. `npm start`, or stack equivalent) brings up the Garrison UI on `localhost:3000` with no auth.
2. Compose tab renders all 13 primitives in spec order. Cardinality rules enforced at compose time. Component-shape mismatches caught at compose time, not runtime.
3. Vault round-trips: secret entered in UI, page reload, secret still there. `data/vault.json` unreadable without Garrison. No plain-text secrets on disk.
4. All six seed components are installed in the curated library and pickable under the correct primitive.
5. Selecting Trello as a data source causes `Tasks` to surface as Trello-backed automatically (no extra UI row for Tasks).
6. Hitting **Run** on a configured composition:
   - Calls `apm install` and reports each step in the live log.
   - Materialises `.env` from vault into the composition directory.
   - Assembles orchestrator+soul system prompt and starts a Claude Code session with it.
   - Every component's `x-garrison.verify` hook passes.
   - Logs stream live to the Run tab.
7. Closing the browser tab and reopening shows the operative still running with log scrollback.
8. **Stop** kills processes cleanly, wipes materialised `.env`, reports stopped.
9. **Dev mode** watches a local-path component; editing a file in that component triggers `apm install` + operative restart within ~10 s.
10. At least one seed component ships a UI extension that renders inside its primitive's tab when installed.

---

## 11. Roadmap

### v1 — dogfood-ready (defined above)

### v1.1

- **Workspace primitive**: pane components (terminal-pane attached to a Gateway session, browser-pane, log-tail, file-explorer-pane) + a layout config. Enables the multi-pane dev-workspace experience some users want as a replacement for proprietary desktop agent UIs.
- Additional platform targets via APM's multi-target install (Codex, etc.).
- Component issue-based submission flow (manual accept).
- Ratings UI.
- UI-kit published as its own APM package (design tokens + small React primitive set).

### v1.2 — non-dev viability (only if dogfood proves the model)

- Guided "starter compositions" gallery for non-devs.
- Multi-composition dashboard (run multiple operatives concurrently).
- Two-way data sync.
- WhatsApp + custom-UI channel seeds.
- In-app assistant that helps non-devs pick a stack.

### Decisions deferred

- **Orchestrator shape**: single-session governing system prompt vs. multi-session coordinator. v1 commits to single-session. Multi-session is reopened by the Workspace primitive in v1.1.
- **Gateway persistence**: file-backed state vs. in-memory. v1 picks whichever the gateway seed component ships with; revisit in v1.2 if it's a problem.
- **Component repo layout**: one repo per component is the v1 default. Monorepo support comes free with APM's local-path resolution if anyone wants it later.

### Explicitly not v1

- Component import from arbitrary URL (security risk; deferred indefinitely or pushed to a "convenience pre-fill" affordance).
- Cross-platform translators (APM provides multi-target install for free).
- Standalone security AI scanner (APM's `apm audit` largely covers this).
- Multi-tenant / cloud / hosted modes.

---

## 12. Design principles

- **Opinionated, not neutral.** Garrison canonises a working pattern. Don't pretend to be a neutral catalogue.
- **Transparent, not magical.** Everything installable is inspectable. Every step the runner takes is visible in the Run tab. No hidden behaviour.
- **Local-first, single-user.** No auth, no multi-tenant, no cloud sync in v1. Everything runs on the user's laptop.
- **Verify or don't ship.** Every component declares a verify hook. The runner refuses to claim success without it.
- **Dogfood discipline.** If the maintainer doesn't use it daily, it doesn't ship.

---

## 13. First acts inside the new project

Produce these files in order, before any application code. The agent's instruction file (`CLAUDE.md`, `AGENTS.md`, or whatever the chosen agent reads on session start) holds this spec verbatim.

1. **Agent instruction file** — verbatim copy of this spec, named for the chosen agent.
2. `METADATA.md` — full `x-garrison` schema spec, ready to land as a typed validator module.
3. `PRIMITIVES.md` — long-form per-primitive notes: purpose, cardinality, component shapes, config items, example components, failure modes. Start it; expect it to keep evolving.
4. `COMPONENTS.md` — per-seed component catalogue with config schemas, target APM-package shape, and verify-hook example.
5. `V1_DOD.md` — verbatim Definition of Done from §10, made into a checklist.
6. `README.md` — short install story (one-command start, open browser).

**Then — and not before — start on the application skeleton.** Suggested build order:

1. App skeleton; Compose tab renders the 13 primitives (data only, no runner yet).
2. Vault.
3. Metadata validator + types.
4. Port one seed (tier classifier) to APM + `x-garrison`.
5. The runner — start, stop, logs SSE, verify, vault materialisation, prompt assembly. Drive it against the tier classifier.
6. Run tab in the UI talking to the runner.
7. Port the remaining five seeds.
8. Library tab with the curated JSON.
9. Dev mode (file watcher + re-apply).
10. Component UI extension loader.
11. Ratings JSON-store backend (UI in v1.1).

---

## 14. Inputs to mine before building

- **Microsoft APM** — `https://github.com/microsoft/apm`. Read the manifest spec, primitive types, install behaviour for the Claude Code target, the audit scanner, and how unknown YAML keys (`x-*`) are preserved.

That's it. Everything else is implementation detail to be decided as components get built.

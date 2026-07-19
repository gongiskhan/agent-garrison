# Garrison, Explained

> **STALE — pre-pivot narrative.** This document still describes 21 top-level
> Faculties, `soul` and `artifact-store` capabilities, Soul Fittings
> (`soul-engineer`, `personal-operative`) and a live `/armory` surface. All of
> those were removed or folded: Faculties are roles (17), `/armory` redirects
> to `/compose`, and Quarters is the `~/.claude` control surface. Kept for the
> long-form explanation of intent; do not treat its inventories as current.
> Start from [`../CLAUDE.md`](../CLAUDE.md) and
> [`architecture.md`](./architecture.md).

A single-document primer covering everything Garrison is, what it does, and how every moving piece fits together. Written for developers landing on the repo who want a mental model in one read.

> Looking for the spec or the live roadmap? This document is the **conceptual onboarding**. The authoritative shape is in [SPEC.md](./SPEC.md); current phase status is in [GARRISON_ROADMAP.md](./GARRISON_ROADMAP.md).

---

## Table of contents

1. [What Garrison is](#1-what-garrison-is)
2. [The mental model in 60 seconds](#2-the-mental-model-in-60-seconds)
3. [APM and where it fits](#3-apm-and-where-it-fits)
4. [Operatives — the running thing](#4-operatives--the-running-thing)
5. [Faculties — the named slots](#5-faculties--the-named-slots)
6. [Fittings — the things you station](#6-fittings--the-things-you-station)
7. [Two kinds of Fitting: agent-facing vs tool-facing](#7-two-kinds-of-fitting-agent-facing-vs-tool-facing)
8. [Capabilities — how Fittings see each other](#8-capabilities--how-fittings-see-each-other)
9. [UI surfaces (Views)](#9-ui-surfaces-views)
10. [The runner lifecycle](#10-the-runner-lifecycle)
11. [The Vault](#11-the-vault)
12. [The full Fitting catalogue](#12-the-full-fitting-catalogue)
13. [Putting it together: a worked example](#13-putting-it-together-a-worked-example)
14. [Glossary](#14-glossary)

---

## 1. What Garrison is

**Garrison is a local web app that composes and runs autonomous Claude Code setups.**

The product does three things and stops:

```
                     ┌─────────────────────────────────────┐
                     │              GARRISON               │
                     │                                     │
                     │   COMPOSE  →  RUN  →  OBSERVE       │
                     │                                     │
                     │   pick parts    spawn agent    watch logs,
                     │   wire them up  with assembled status, views
                     │                 prompt                       │
                     └─────────────────────────────────────┘
```

It is **open-source, local-first, single-user, no auth**, and talks only to `localhost`. It targets Claude Code in v1. The composed, running agent is called an **Operative**.

### What Garrison is *not*

- Not a chat product. There is no built-in chat surface. Talking to the Operative is the job of a **Channel Fitting** (Slack, Web Channel, etc.).
- Not a tool library. Garrison ships a small set of seed Fittings as references; the catalogue is meant to grow as community Fittings.
- Not a cloud platform. No auth, no multi-tenant, no telemetry, no remote inference. Everything runs on the user's laptop. The Operative uses the user's own Claude Max account in-process via the Anthropic Agent SDK.
- Not opinionated about *what* you compose. The platform thesis is "Faculties + Fittings compose; Garrison's shell renders what's installed." Garrison ships no chat box, no memory strategy, no orchestrator behaviour. All of that lives in Fittings.

### Why it exists

Platforms like OpenClaw and Hermes make reasonable defaults for newcomers, but practitioners who have already formed views about how their agent should behave keep running into those defaults — rate limiting that isn't theirs to tune, routing baked into the runtime, memory strategies they didn't pick. Garrison removes these constraints by giving you a thin runtime and letting you decide what goes in each slot. Every layer is visible: the manifest, the assembled prompt, the secrets vault, the capability wiring, the logs. Customisation is practical because nothing important hides behind a library call.

---

## 2. The mental model in 60 seconds

```
                  ┌──────────────────────────────────────────────┐
                  │  COMPOSITION  (one apm.yml on disk)          │
                  │                                              │
                  │  ┌────────────┐  ┌────────────┐  ┌────────┐  │
                  │  │ Faculty:   │  │ Faculty:   │  │ ...    │  │
                  │  │ orchestrator│ │ soul       │  │        │  │
                  │  │            │  │            │  │        │  │
                  │  │  ┌──────┐  │  │  ┌──────┐  │  │        │  │
                  │  │  │Fitting│ │  │  │Fitting│ │  │        │  │
                  │  │  └──────┘  │  │  └──────┘  │  │        │  │
                  │  └────────────┘  └────────────┘  └────────┘  │
                  │       provides            consumes           │
                  │           ↓                  ↑               │
                  │      ┌──────────────────────────┐            │
                  │      │  Capability resolver     │            │
                  │      │  (provides ↔ consumes)   │            │
                  │      └──────────────────────────┘            │
                  └──────────────────────────────────────────────┘
                                       ↓
                       ┌─────────────────────────────────┐
                       │           RUNNER                │
                       │                                 │
                       │  1. apm install                 │
                       │  2. materialise .env from vault │
                       │  3. run each Fitting's setup    │
                       │  4. run each Fitting's verify   │
                       │  5. assemble system prompt:     │
                       │       orchestrator + soul       │
                       │       + {{capabilities}}        │
                       │  6. spawn Operative (Claude     │
                       │       Agent SDK in-process)     │
                       └─────────────────────────────────┘
                                       ↓
                       ┌─────────────────────────────────┐
                       │          OPERATIVE              │
                       │  Long-running Claude Code agent │
                       │  reachable via Channel Fittings │
                       └─────────────────────────────────┘
```

The whole platform is that loop. Everything else is variation on the theme.

---

## 3. APM and where it fits

Garrison is built on **APM** — Microsoft's open-source [Agent Package Manager](https://github.com/microsoft/apm). APM is to agents what npm is to JavaScript: a package manifest, install resolver, audit scanner, and lockfile pinner for the agent layer (skills, instructions, prompts, hooks, MCP servers).

```
┌──────────────────────────────────────────────────────────────────────┐
│                            APM                                       │
│                                                                      │
│   manifest    install     audit      pack       lockfile             │
│   (apm.yml)   resolves    security   distribute pinned versions      │
│               into        scanner                                    │
│               .claude/    (prompt-inj,                               │
│                           hidden Unicode)                            │
└──────────────────────────────────────────────────────────────────────┘
                                  ↑
                                  │ "I am an APM package"
                                  │
┌──────────────────────────────────────────────────────────────────────┐
│                       A Garrison Fitting                             │
│                                                                      │
│   fittings/seed/my-thing/                                            │
│   ├── apm.yml         ← standard APM manifest                        │
│   │     name: my-thing                                               │
│   │     version: 0.1.0                                               │
│   │     dependencies: ...                                            │
│   │     x-garrison:   ← Garrison-specific metadata block             │
│   │        faculty: classifier                                       │
│   │        provides: [...]                                           │
│   │        consumes: [...]                                           │
│   │        verify: { command: ..., expect: ... }                     │
│   │        ui: { views: [...] }                                      │
│   │                                                                  │
│   └── .apm/           ← APM-recognised content                       │
│         skills/       ← skill packages                               │
│         instructions/ ← agent instructions                           │
│         prompts/      ← system/user prompts                          │
│         hooks/        ← Claude Code hooks                            │
│         agents/       ← named agent definitions                      │
└──────────────────────────────────────────────────────────────────────┘
```

**What APM owns:** the manifest format, fetching git-backed packages, audit/security scanning, installing into the target CLI's native directory (`.claude/` for Claude Code), and lockfile pinning.

**What Garrison adds:** the `x-garrison` block inside the manifest. APM preserves unknown `x-*` keys, so Garrison piggy-backs on the standard without forking the format. The block carries:

- Which **Faculty** this Fitting fills.
- What it **provides** and **consumes** (the capability wiring).
- A **verify** hook the runner uses to prove the Fitting works post-install.
- An optional **setup** hook for one-shot pre-verify prep.
- An optional **ui** block declaring React views.
- A **for_consumers** markdown block — usage guidance the Operative sees.
- An optional **config_schema** that drives the Compose UI.

Garrison's runner shells out to APM for install/audit, then reads the `x-garrison` blocks across the composition to do the rest (resolve capabilities, run hooks, assemble the prompt, spawn the agent). It does **not** reimplement what APM does.

---

## 4. Operatives — the running thing

An **Operative** is a composed, executing autonomous agent. Concretely:

- A long-running Claude Code session, spawned in-process via `@anthropic-ai/claude-agent-sdk`.
- Auth is the user's Claude Max account. No API key billing.
- Its system prompt is the **assembled** result of an Orchestrator Fitting + a Soul Fitting + a `{{capabilities}}` block listing all the other Fittings stationed in the composition.
- It survives browser tab close. Closing the tab does not kill the Operative. Reopening shows scrollback from a per-Operative ring buffer.
- It receives prompts through **Channel Fittings** (Slack, the Web Channel) and/or scheduled wake-ups from **Heartbeat Fittings**.
- It dispatches work through whatever Fittings the composition stations: sub-agents, memory, data sources, browser automation, etc.

The Operative is *one Claude Code session per composition* in v1. Multi-session orchestration is a runtime SDK milestone concern; until then, a single governing system prompt coordinates everything.

```
   inbound:                     outbound:
   ─────────                    ─────────
   Channel → Gateway → ┌─────────┐ → Channel reply
                       │         │
   Heartbeat tick    → │OPERATIVE│ → Memory write
                       │         │
   Sub-agent reply   → │  (one   │ → Data-source query
                       │  Claude │
   MCP gateway tool  → │  Code   │ → Artifact write
   call from a        │  session)│
   workbench session    │         │ → Document update
                       └─────────┘
                            ↓
                    log stream (SSE)
                    visible on /run
```

---

## 5. Faculties — the named slots

A **Faculty** is a slot in a composition. It has a name, a cardinality (`single` or `multi`), a closed set of accepted **Fitting shapes**, and an intent. There are **21 top-level Faculties** plus one derived (Tasks).

### The full Faculty roster

| # | Faculty | Cardinality | Purpose |
|---|---|---|---|
| 1 | `orchestrator` | single, governing | Behaviour spine. Owns global config. Coordinates everything else. |
| 2 | `soul` | single | Identity, voice, tone, boundaries. Composes with the Orchestrator at prompt-assembly time. |
| 3 | `heartbeat` | single | Wakes the Operative on a cadence. |
| 4 | `scheduler` | single | Anything outside the heartbeat cadence (cron-like). |
| 5 | `classifier` | single | Routing floor for every prompt (T1–T7). |
| 6 | `memory` | single | Within-session + cross-session recall. |
| 7 | `gateway` | single | MCP-speaking HTTP entry point. Channels POST to it. |
| 8 | `data-sources` | multi | One-way fetch from external systems (Trello, Calendar, etc.). |
| 9 | `knowledge-base` | multi | Readable references (docs, code, Documents Fitting). |
| 10 | `automations` | multi | Things the Operative can *do* in external systems (browser, desktop). |
| 11 | `skills` | multi | Reusable agent skills (summariser, test author, etc.). |
| 12 | `channels` | multi | Message surfaces (Slack, Web Channel). |
| 13 | `observability` | multi | Loop health, errors, no-ops. |
| 14 | `artifact-store` | single | Filesystem-backed storage for files Fittings produce. |
| 15 | `sync` | single | Periodic mirroring (e.g. vault sync to outposts). |
| 16 | `monitor` | single | Read-only visibility into spawned PIDs/ports/logs. |
| 17 | `sessions` | single (own-port) | Claude Code dev environment — session tabs, terminals, browser pane. |
| 18 | `screen-share` | single (own-port) | Screen-capture relay. |
| 19 | `outposts` | single (own-port) | Multi-machine bridge to other Macs over Tailscale. |
| 20 | `web-channel` | single (own-port) | Browser chat surface. |
| 21 | `browser` | single (own-port) | Headless Chromium substrate over HTTP/WS. |
| — | `tasks` (derived) | — | Surfaces automatically when a data-source declares a task source. Not user-selected. |

### Two breeds of Faculty

```
┌────────────────────────────────────┐    ┌───────────────────────────────────┐
│   AGENT-FACING Faculties           │    │  TOOL-FACING (own-port) Faculties │
│                                    │    │                                   │
│   orchestrator, soul, memory,      │    │   sessions, screen-share,         │
│   heartbeat, scheduler, classifier,│    │   outposts, web-channel,          │
│   gateway, data-sources, channels, │    │   browser, monitor                │
│   automations, skills, knowledge-  │    │                                   │
│   base, observability,             │    │                                   │
│   artifact-store, sync             │    │   Fittings here own their own     │
│                                    │    │   HTTP port and React UI.         │
│   Fittings here ship skills,       │    │   Garrison's sidebar Views        │
│   prompts, hooks, MCP servers,     │    │   group links to them.            │
│   or scripts the Operative uses.   │    │   They are user-facing tools.     │
└────────────────────────────────────┘    └───────────────────────────────────┘
```

The own-port set is defined in `src/lib/faculties.ts` (`OWN_PORT_FACULTIES`). See [§7](#7-two-kinds-of-fitting-agent-facing-vs-tool-facing) for the full agent-vs-tool distinction.

### The `tasks` Faculty is derived

`tasks` is never user-selected. When a data-source Fitting declares a task source in its manifest, Garrison surfaces a derived Tasks view automatically. Selecting Trello, for example, makes Tasks Trello-backed and points at the data source's declared markdown truth file.

### Long-form Faculty intent

Each Faculty has its own page of intent, failure modes, and config space in [FACULTIES.md](./FACULTIES.md). Read that when you're authoring a Fitting and need to know what the slot expects.

---

## 6. Fittings — the things you station

A **Fitting** is the concrete component installed into a Faculty slot. It is a git-backed APM package with an `x-garrison` metadata block. The `fittings/seed/<id>/` directories in this repo are local seed Fittings; community Fittings are separate git repos.

### Fitting shapes

A Fitting declares its shape — the *form* of what it ships. The set is closed:

| Shape | What it is |
|---|---|
| `script` | A Node/Python/shell script the runner spawns. |
| `agent-instructions` | An `.agent.md` agent definition. |
| `manual-instructions` | Markdown explaining a manual step the user must do. |
| `plugin` | A platform-native plugin (used for own-port UI Fittings). |
| `skill` | An APM skill: `.apm/skills/<name>/SKILL.md` + assets. |
| `cli` | A CLI binary or script the Operative shells out to. |
| `hook` | A Claude Code lifecycle hook. |
| `system-prompt` | A `.prompt.md` injected into the system prompt. |
| `cli-skill` | Composite: a CLI surface + a driving skill. |
| `mcp` | An MCP server the Operative connects to. |

Different Faculties accept different shapes. The validator enforces the matchup at compose time.

### Anatomy of a Fitting

```
fittings/seed/my-fitting/
├── apm.yml                         ← APM manifest with x-garrison
├── .apm/                           ← APM-recognised content
│   ├── skills/<name>/SKILL.md      ← the skill the Operative invokes
│   ├── prompts/<name>.prompt.md    ← prompt material
│   ├── instructions/<name>.md      ← agent instructions
│   └── hooks/<name>.json           ← Claude Code hooks
├── scripts/                        ← server/CLI scripts (for script-shape)
│   ├── start.mjs                   ← entrypoint
│   ├── server.mjs                  ← HTTP server (own-port Fittings)
│   └── probe.mjs                   ← verify-hook surface
├── ui/                             ← React UI (own-port Fittings)
│   ├── index.html
│   ├── main.tsx
│   ├── styles.css
│   └── build.mjs                   ← esbuild script
└── dist/                           ← build output (own-port Fittings)
```

Only the parts a given Fitting needs are present. A pure system-prompt Fitting has just `apm.yml` + `.apm/prompts/`. A full own-port UI Fitting has all of the above.

### What goes in `x-garrison`

```yaml
x-garrison:
  faculty: classifier               # which Faculty
  cardinality_hint: single          # informational, validated
  component_shape: skill            # YAML name retained for back-compat
  platforms: [claude-code]
  summary: "Tier 1–7 routing floor"

  config_schema:                    # drives the Compose UI form
    - key: tier_floor
      type: integer
      default: 3
      description: "Minimum tier this raises every prompt to"

  provides:                         # capabilities this Fitting offers
    - kind: agent-skill
      name: tier-classifier

  consumes:                         # capabilities this Fitting needs
    - kind: vault
      cardinality: optional-one

  for_consumers: |                  # usage guidance injected into
    Use this skill when the user...  the Orchestrator prompt

  setup:                            # optional: pre-verify prep
    command: ./scripts/setup.sh
    idempotent: true
    timeout_ms: 60000

  verify:                           # required: runner runs this
    command: test -f .claude/skills/tier-classifier/SKILL.md && echo ok
    expect: ok

  ui:                               # optional: React views
    views:
      - id: inspector
        placement: faculty-tab
        entry: ./ui/Inspector.tsx
        route: ""

  lifecycle: operative-bound        # default; own-port Fittings can be detached
```

Full schema in [METADATA.md](./METADATA.md).

### Verify or don't ship

The single most important Fitting discipline: every Fitting declares a `verify` hook. The runner refuses to claim success without it. Verify hooks are **read-only** by contract — they check that the installed artifacts exist and the server (if any) is reachable. They never mutate state.

The companion `setup` hook is the *side-effect-causing* step: cloning a sibling repo, running `uv sync`, writing host config. Setup runs on every `up`, before verify. A non-zero setup exit aborts the run — downstream verify and Operative spawn do not happen.

---

## 7. Two kinds of Fitting: agent-facing vs tool-facing

The user-asked-for distinction. There are two big breeds of Fitting, and the difference matters for both authoring and using them.

### A) Agent-facing Fittings — *things the Operative uses*

These ship skills, prompts, hooks, scripts, MCP servers, or CLIs that the **running Claude Code agent invokes during its work**. They have no user-facing UI of their own (or, at most, a small inspector that renders in the Compose tab).

Examples:

- `tier-classifier` — a skill the Operative consults to decide tier.
- `memory` — hooks + a skill the Operative uses for recall.
- `trello-data-source` — a CLI the Operative shells out to.
- `slack-channel` — a script that posts messages on the Operative's behalf.
- `browser-automation` — a Playwright CLI + a driving skill.
- `coding-subagent` — a CLI the Orchestrator dispatches coding work to.
- `soul`, `personal-operative` — pure system-prompt material.

These Fittings interact with the Operative through:
- The assembled system prompt (Orchestrator + Soul + `{{capabilities}}` block with `for_consumers`).
- Tool calls the Operative makes during the session.
- Inbound events through the gateway (channels, heartbeat).

### B) Tool-facing Fittings — *things the user uses*

These ship a React UI on their own HTTP port. The **human** opens them in a browser tab to work with them. The Operative may also drive them, but they are designed primarily for the user.

Examples:

- `dev-env` — per-session Claude Code dev environment (Claude + shell PTYs, browser pane; sessions on the current branch).
- `screen-share-default` — macOS screen-capture viewer.
- `outpost-tailscale-host` — remote-Mac bridge management.
- `web-channel-default` — mobile-friendly chat surface.
- `browser-default` — embedded Chromium with DevTools.
- `monitor-default` — read-only PID/port/log dashboard.

All tool-facing Fittings live under **own-port Faculties** (see [§5](#5-faculties--the-named-slots)) and follow the canonical pattern in [UI-FITTINGS.md](./UI-FITTINGS.md):

```
        Garrison shell (Next.js, port 27777)
        ┌───────────────────────────────────┐
        │  sidebar:                         │
        │   ┌──────────────────────────┐    │
        │   │ Views                    │    │
        │   │  • Dev Env   (27086) →────┼────┼──→ http://127.0.0.1:27086
        │   │  • Monitor   (27077) →────┼────┼──→ http://127.0.0.1:27077
        │   └──────────────────────────┘    │
        └───────────────────────────────────┘

      Each own-port Fitting:
       1. Binds its declared port (or falls back via findFreePort).
       2. Writes ~/.garrison/ui-fittings/<id>.json with {url, pid, port}.
       3. Serves GET /health for liveness probing.
       4. Cleans up the status file on SIGTERM/SIGINT.

      Garrison's sidebar polls /api/fittings/views, which aggregates the
      status files and probes /health. Links appear/disappear with the
      Fitting's lifecycle.
```

**Why URL-link instead of embedded?** Coupling between UI Fittings would re-introduce the problem composability solves. Linking by URL means:
- One Fitting can be written in React, another in Vue, another in plain HTML — Garrison doesn't care.
- A provider restart doesn't break consumers.
- If the providing Fitting isn't installed, the link silently disappears.

### A third pattern: embedded UI Fittings

A small middle ground exists: Fittings that render their UI **inside** the Garrison Next.js shell rather than on their own port. They declare views with `placement: faculty-tab` or `placement: sidebar-surface` under `x-garrison.ui.views[]`, and Garrison's static view registry (`src/components/fitting-views/registry.tsx`) maps `(fitting-id, view-id)` to a React component.

Documents and Artifact Store are the canonical embedded-UI Fittings. They live at routes like `/fitting/documents/<doc-id>`. UI contract v2 spec is in [SPEC.md §9](./SPEC.md#9-ui-extensions) and the renderer details are in [UI-FITTINGS.md](./UI-FITTINGS.md).

```
embedded UI (contract v2)    vs    own-port UI (Monitor pattern)
──────────────────────────         ───────────────────────────────
renders inside Garrison shell      renders on its own port
static React registry              independent HTTP server
build-time bundled                 ships its own dist/
faculty-tab or sidebar-surface     sidebar Views link (external open)
Documents, Artifact Store          Monitor, Dev Env, Browser, ...
```

The two patterns coexist and serve different use cases. Embedded for things that want tight integration with the Garrison shell. Own-port for things that benefit from being independently launchable, restartable, and writable in any framework.

---

## 8. Capabilities — how Fittings see each other

Faculties give a Fitting its **slot**. Capabilities give it a **contract** for talking to others.

Every Fitting may declare:

- `provides: [...]` — capabilities it offers the rest of the composition.
- `consumes: [...]` — capabilities it requires.

The resolver in `src/lib/capabilities.ts` walks the union of selected Fittings, matches consumers against providers, and enforces cardinality. **Compose refuses to mark ready until every consumes resolves.**

### The capability kinds

The current full set, enforced by the parser via `src/lib/types.ts`:

```
orchestrator   soul              agent-skill        memory-store
automation-    data-source       channel            vault
runner
artifact-      dev-env           screen-share       outpost
store
mcp-gateway    monitor
```

Each kind has well-understood semantics, documented in [CAPABILITIES.md](./CAPABILITIES.md). `vault` is special — it is provided synthetically by the runtime (`__runtime__` node), so any `optional-one vault` consumer always resolves.

### Cardinality literals on `consumes`

```yaml
consumes:
  - { kind: agent-skill, cardinality: any }
```

| Literal | Meaning |
|---|---|
| `one` (default) | Exactly one provider must match. |
| `optional-one` | Zero or one provider may match. |
| `any` | Zero or more providers may match (the consumer iterates `matched`). |

`any` is the mechanism the Orchestrator uses to **discover installed Fittings without hardcoding**. The seed Orchestrator (`personal-operative`) declares:

```yaml
consumes:
  - { kind: soul,             cardinality: one }
  - { kind: agent-skill,      cardinality: any }
  - { kind: memory-store,     cardinality: any }
  - { kind: automation-runner, cardinality: any }
  - { kind: data-source,      cardinality: any }
  - { kind: channel,          cardinality: any }
  - { kind: vault,            cardinality: optional-one }
```

When you add a new Fitting providing any of those kinds, the Orchestrator automatically sees it in its assembled prompt — no Garrison code change, no per-composition prompt fork.

### `for_consumers` — locality of usage guidance

A provider Fitting *should* ship a `for_consumers` block: free-form markdown explaining when and how the Operative ought to reach for the capability — trigger conditions, calling patterns, anti-patterns. The runner injects this verbatim under the provider's line in the Orchestrator's `{{capabilities}}` block at assembly time.

Locality principle: **the Fitting that ships a capability also ships the doc on how to use it.** The Orchestrator stays generic. Adding a Fitting adds its usage guidance automatically.

8 KB byte cap per `for_consumers`. Falls back to `summary` when absent.

### Worked example

```
COMPOSITION                                  CAPABILITY GRAPH
─────────────                                ────────────────

personal-operative ───────────►              orchestrator:personal-operative
  (Orchestrator)                                 ↓ consumes
                                              soul (one)         ◄── soul Fitting (provides soul:...)
                                              agent-skill (any)  ◄── tier-classifier (provides agent-skill:...)
                                              memory-store (any) ◄── memory (provides memory-store:...)
                                              automation-runner  ◄── loop-heartbeat (provides ...)
soul ─────────────────────────►                                  ◄── ...
  (Soul)                                      data-source (any)  ◄── trello-data-source (provides ...)
                                              channel (any)      ◄── slack-channel (provides channel:slack)
tier-classifier ──────────────►                                  ◄── web-channel-default (provides channel:web)
  (Skill)                                     vault (optional)   ◄── __runtime__ (always)

memory ───────────────────────►
  (Memory)

trello-data-source ───────────►
  (Data source)

slack-channel ────────────────►
  (Channel)

loop-heartbeat ───────────────►
  (Heartbeat)

http-gateway ─────────────────►              consumes orchestrator (one)
                                              ◄── personal-operative satisfies it
```

The resolver outputs a `SerializedCapabilityGraph` with one entry per Fitting, listing each consumes's `matched` providers. The runner reads this at prompt-assembly time.

---

## 9. UI surfaces (Views)

A **View** is a UI surface a Fitting declares in its `x-garrison.ui.views[]` block. Each view has:

| Field | What it does |
|---|---|
| `id` | Stable identifier within the Fitting. |
| `placement` | `faculty-tab` (renders inline next to the Compose config) or `sidebar-surface` (gets its own page at `/fitting/<id>/...` and a sidebar entry). |
| `entry` | Path relative to the Fitting root for the React component. Used by the static view registry. |
| `route` | React-router-style fragment under the Fitting prefix (e.g. `""`, `/:id`, `/:id/edit`). |

The sidebar **Views** group in Garrison's chrome auto-populates per composition. It surfaces two things:

1. **Embedded views** declared with `placement: sidebar-surface` — these render inside the Next.js shell via the static registry.
2. **Own-port live links** — the sidebar polls `/api/fittings/views`, which aggregates `~/.garrison/ui-fittings/*.json` and probes each `/health` endpoint. Links appear/disappear with the Fitting's lifecycle.

```
   Garrison sidebar
   ┌─────────────────────┐
   │  Compose            │
   │  Run                │
   │  Vault              │
   │  Armory             │
   │                     │
   │  Views ▼            │
   │   • Documents       │  ← embedded sidebar-surface (contract v2)
   │   • Artifact Store  │  ← embedded sidebar-surface (contract v2)
   │   • Dev Env       ⤴ │  ← own-port link (port 27086)
   │   • Monitor       ⤴ │  ← own-port link (port 27077)
   │   • Browser       ⤴ │  ← own-port link (port 27084)
   └─────────────────────┘
```

### Cross-Fitting linking

Fittings can emit `garrison://<fitting-id>/<rest>` URLs in chat replies, document bodies, etc. Renderers translate them to Next.js `<Link>`s pointing at `/fitting/<fitting-id>/<rest>`. `garrison://artifacts/<id>` for a markdown artifact resolves transparently to `garrison://documents/<id>`.

### Why a static registry instead of dynamic disk loading

UI contract v2 declares views in metadata but the host app maintains a static map of `(fitting-id, view-id) → React component` in `src/components/fitting-views/registry.tsx`. Authors of new embedded UI Fittings add their entry to the registry. This keeps Next.js bundling honest and avoids a separate Fitting-build pipeline. Dynamic disk loading is a v3 concern.

Own-port UI Fittings are unaffected — they ship their own dist and don't touch the registry.

Full UI-Fitting authoring guide: [UI-FITTINGS.md](./UI-FITTINGS.md).

---

## 10. The runner lifecycle

The runner (`src/lib/runner.ts`) is the most important new piece in Garrison. It does five things:

```
   ┌─ up(composition) ───────────────────────────────────────────────┐
   │                                                                 │
   │  1. apm install                                                 │
   │     ├─ resolves dependencies from apm.yml                       │
   │     ├─ installs into apm_modules/_local/<id>/                   │
   │     ├─ streams live log to /run via SSE                         │
   │     └─ audits content (apm audit) for prompt-injection etc.     │
   │                                                                 │
   │  2. materialise .env from vault                                 │
   │     ├─ decrypts secrets via the user's passphrase               │
   │     └─ writes a per-composition .env (deleted on `down`)        │
   │                                                                 │
   │  3. run each Fitting's x-garrison.setup (if present)            │
   │     ├─ in the Fitting's installed dir                           │
   │     ├─ before verify                                            │
   │     └─ non-zero exit aborts `up`                                │
   │                                                                 │
   │  4. run each Fitting's x-garrison.verify                        │
   │     ├─ read-only sanity check                                   │
   │     ├─ refuses silent success (no verify hook → hard failure)   │
   │     └─ verify failure marks the Operative broken                │
   │                                                                 │
   │  5. start eager-toggled own-port Fittings                       │
   │     ├─ spawn only the operative-bound Fittings toggled eager    │
   │     ├─ they bind ports, write status files, serve /health       │
   │     ├─ non-eager Fittings wait for a Views-UI start (on demand) │
   │     └─ detached Fittings are skipped (user manages them)        │
   │                                                                 │
   │  6. assemble the system prompt                                  │
   │     ├─ read Orchestrator prompt + Soul prompt                   │
   │     ├─ substitute {{capabilities}} placeholder with             │
   │     │      one bullet per resolved provider, with each          │
   │     │      provider's for_consumers indented underneath         │
   │     ├─ write assembled-system-prompt.md (auditable)             │
   │     └─ pass to the SDK as `append`                              │
   │                                                                 │
   │  7. spawn Operative via @anthropic-ai/claude-agent-sdk          │
   │     ├─ in-process (no `claude` CLI subprocess)                  │
   │     ├─ auth: user's Claude Max account                          │
   │     ├─ permission mode: bypassPermissions (no prompt UI yet)    │
   │     └─ Query.interrupt() is the kill switch                     │
   │                                                                 │
   └─────────────────────────────────────────────────────────────────┘

   ┌─ down(composition) ──────────────────────────────────────────────┐
   │  ▸ Query.interrupt() the Operative                              │
   │  ▸ stop operative-bound own-port Fittings by PID                │
   │    (PID read from ~/.garrison/ui-fittings/<id>.json — never     │
   │     greps lsof)                                                 │
   │  ▸ wipe materialised .env                                       │
   │  ▸ leave detached Fittings running                              │
   └─────────────────────────────────────────────────────────────────┘

   ┌─ verify(composition) ────────────────────────────────────────────┐
   │  ▸ walk every Fitting's verify hook on demand                    │
   │  ▸ report pass/fail (no side effects)                            │
   └──────────────────────────────────────────────────────────────────┘

   ┌─ dev(composition) ───────────────────────────────────────────────┐
   │  ▸ up + chokidar watcher on local-path deps                      │
   │  ▸ on change: apm install + restart the Operative                │
   └──────────────────────────────────────────────────────────────────┘

   ┌─ logs(composition) ──────────────────────────────────────────────┐
   │  ▸ SSE stream of Operative + runner stdout/stderr                │
   │  ▸ Per-Operative ring buffer for tab-reopen scrollback           │
   └──────────────────────────────────────────────────────────────────┘
```

### Two principles baked in

1. **Process survives tab close.** Closing the browser does not kill running Operatives. The ring buffer replays on reopen.
2. **Verify-step discipline.** Every Fitting declares a verify hook. The runner refuses to claim success without it. This is the single most important discipline in the system.

---

## 11. The Vault

Garrison's local secrets store. Single file: `data/vault.json`, file mode `0600`.

- **Encryption:** AES-256-GCM, key derived from the user's passphrase via scrypt.
- **Lifecycle:** secrets only leave the encrypted file to be materialised into a per-composition `.env` at runtime. The `.env` is deleted on `down`.
- **Capability:** the runtime advertises `vault` as a singleton capability (`__runtime__` synthetic provider) so any Fitting consuming `vault` resolves.
- **Surface:** the **Vault** tab in the UI. Enter a secret, page reload, secret persists. The vault file is unreadable without Garrison.
- **What goes in it:** Slack signing secret, Trello API token, channel webhook URLs — anything a Fitting declares as `secret-ref` in its `config_schema`.

Secrets never leave the user's machine.

---

## 12. The full Fitting catalogue

The seed Fittings shipped in this repo, grouped by what they do. The Armory (`/armory` in the running app) browses these and any community Fittings registered in `data/library.json`.

### The agent's brain: Orchestrators and Souls

| Fitting | Role | Notes |
|---|---|---|
| `personal-operative` | Orchestrator (default) | Heartbeat-driven loop: triage inbox/scheduled/tasks → classify → route → verify → persist. Composition-aware via `cardinality: any` on every kind. |
| `garrison-orchestrator` | Orchestrator (delegating) | Routes work to specialist Soul sub-sessions via `garrison-control` MCP. Does no work itself. |
| `soul` | Soul (the PM/Architect/PA persona) | Default Soul for the personal Operative. |
| `soul-engineer` | Soul (specialist) | Coding specialist. Full filesystem and shell access. |
| `soul-architect` | Soul (specialist) | Design thinking. Read access; produces markdown design docs. |
| `soul-assistant` | Soul (specialist) | Personal life logistics. Meal planning, family scheduling, todos. No web access. |
| `soul-researcher` | Soul (specialist) | Web search + fetch; produces cited markdown research notes. |
| `soul-companion` | Soul (specialist) | Conversational companion. Quick answers, light and fast. |

### Routing & cadence

| Fitting | Faculty | What it does |
|---|---|---|
| `tier-classifier` | classifier | Tier 1–7 routing floor. T3+ forces plan-then-reclassify-then-route. |
| `loop-heartbeat` | heartbeat | Scheduled loop. Default 40-min cadence. Dispatches via the gateway. |
| `scheduler` | scheduler | Cron-style job scheduler. Add/remove/list/run-now via CLI. |
| `morning-briefing` | automations | Scheduled cron Fitting that posts the day's plan to the report channel. |

### Memory & knowledge

| Fitting | Faculty | What it does |
|---|---|---|
| `basic-memory` | memory | Within-session recall + cross-session persistence in a plain-markdown Obsidian vault (`~/ObsidianVault`) indexed into a local SQLite knowledge graph, with write/search/read MCP tools shared across Claude, Codex, and Gemini. |
| `projects-index` | knowledge-base | Lazy filesystem walk of `~/Projects` for dev-hat context. |
| `documents` | knowledge-base | Markdown documents workspace layered on Artifact Store. Sidebar-surface UI. |
| `artifact-store` | artifact-store | Filesystem-backed storage with namespaces (`documents/`, `automations/`, `voice/`). |

### Channels (talking to the user)

| Fitting | Faculty | What it does |
|---|---|---|
| `slack-channel` | channels | Inbound webhook channel. Receives Slack app_mention + DM events. |
| `web-channel-default` | web-channel | Mobile-first browser chat surface. Own-port (27083). Proxies the gateway. |

### Doing stuff in the world

| Fitting | Faculty | What it does |
|---|---|---|
| `browser-automation` | automations | Playwright CLI + driving skill. |
| `coding-subagent` | skills | Plan-then-execute coding sub-agent. Spawns isolated SDK session in a project folder. |
| `testing` | skills | Project-aware test runner. Auto-detects npm/pytest/cargo/go test. |

### Data sources

| Fitting | Faculty | What it does |
|---|---|---|
| `trello-data-source` | data-sources | One-way Trello fetch. Backs the derived Tasks Faculty. |
| `google-calendar` | data-sources | Bidirectional calendar sync. |

### Plumbing

| Fitting | Faculty | What it does |
|---|---|---|
| `http-gateway` | gateway | Small stdlib HTTP gateway. Inbound jobs, channel events, session checks. SDK-backed `POST /chat/stream`. |
| `mcp-gateway` | gateway | Exposes installed Faculties as MCP tools to workbench-launched Claude Code sessions. Stdio + HTTP transports. |
| `vault-sync` | sync | Periodic host→outpost directory mirror (e.g. Obsidian vault). Scheduler-driven. |

### Outposts (multi-machine)

| Fitting | Faculty | What it does |
|---|---|---|
| `outpost-tailscale-host` | outposts | Bridge for a Tailscale-connected remote Mac. Spawn processes, read files via the Outpost Protocol. |
| `outpost-actions` | skills | Agent skill for invoking ops on remote outposts — run commands, read/write files. |

### Workbench (tool-facing, own-port)

| Fitting | Faculty | Port | What it does |
|---|---|---|---|
| `dev-env` | sessions | 27086 | Per-session Claude Code dev environment — Claude + shell PTYs, quick-prompt bar, live browser pane, current-branch sessions, session dashboard. |
| `screen-share-default` | screen-share | 27079 | macOS screen-capture — ~2fps JPEG polling for phone/remote access. |
| `browser-default` | browser | 27084 | Headless Chromium with screencast, input, raw CDP, and DevTools reverse-proxy. |
| `monitor-default` | monitor | 27077 | Read-only PID/port/log dashboard. |

The complete list of UI Fittings and the canonical own-port pattern they all follow: [UI-FITTINGS.md](./UI-FITTINGS.md). Long-form Fitting authoring guide: [FITTINGS.md](./FITTINGS.md).

---

## 13. Putting it together: a worked example

A minimal personal-assistant composition, exercised end to end.

### Step 1: the manifest

`compositions/pa/apm.yml`:

```yaml
name: pa
version: 0.1.0
target: claude
dependencies:
  apm:
    - path: ../../fittings/seed/personal-operative
    - path: ../../fittings/seed/soul
    - path: ../../fittings/seed/loop-heartbeat
    - path: ../../fittings/seed/tier-classifier
    - path: ../../fittings/seed/memory
    - path: ../../fittings/seed/http-gateway
    - path: ../../fittings/seed/slack-channel
    - path: ../../fittings/seed/trello-data-source

x-garrison:
  composition:
    id: pa
    name: Personal Assistant
    global_config:
      projects_root: ~/Projects
      platform: claude-code
      guardrails:
        max_tasks_per_tick: 5
        max_spend_per_day: 25
    selections:
      heartbeat:
        - id: loop-heartbeat
          config:
            cadence_minutes: 40
      data-sources:
        - id: trello-data-source
          config:
            board_id: "abcd1234"
            tasks_truth_file: tasks/trello.md
```

### Step 2: compose-time validation

The resolver walks the union of selected Fittings:

- `personal-operative` consumes `soul (one)`, `agent-skill (any)`, `memory-store (any)`, `automation-runner (any)`, `data-source (any)`, `channel (any)`, `vault (optional-one)`.
- `soul` provides `soul:personal-operative-soul` → matches.
- `tier-classifier` provides `agent-skill:tier-classifier` → matches.
- `memory` provides `memory-store:garrison-memory` → matches.
- `loop-heartbeat` provides `automation-runner:loop-heartbeat` → matches.
- `trello-data-source` provides `data-source:trello` → matches.
- `slack-channel` provides `channel:slack` → matches.
- `__runtime__` provides `vault` (synthetic) → matches.

Plus the reverse direction:
- `loop-heartbeat` consumes `orchestrator (one)` → matched by `personal-operative`.
- `http-gateway` consumes `orchestrator (one)` → matched by `personal-operative`.
- `trello-data-source` consumes `vault (one)` → matched by `__runtime__`.
- `slack-channel` consumes `vault (one)` → matched by `__runtime__`.

All resolves green. Compose marks ready.

### Step 3: hit Run

The runner:

1. Streams `apm install` log into the Run tab.
2. Materialises `.env` (Slack signing secret, Trello API token).
3. Runs each Fitting's `setup` hook — `basic-memory` ensures the `~/ObsidianVault` vault and its local SQLite index exist.
4. Runs each Fitting's `verify` hook — all green.
5. Starts the HTTP gateway on `127.0.0.1:24777`.
6. Assembles `assembled-system-prompt.md`:

```
[personal-operative.prompt.md content...]

[soul.prompt.md content...]

## Capabilities available in this composition
- agent-skill:tier-classifier
    [for_consumers text from tier-classifier...]
- memory-store:garrison-memory
    [for_consumers text from memory...]
- automation-runner:loop-heartbeat
    [for_consumers text...]
- data-source:trello
    [for_consumers text...]
- channel:slack
    [for_consumers text...]
- vault
    [for_consumers text from __runtime__...]
```

7. Spawns the Operative in-process via the SDK with that prompt.

### Step 4: it runs

- A Slack `@bot what's on my plate today?` event hits Slack's webhook URL.
- `slack-channel` verifies the signature, posts to the gateway's `POST /chat/stream`.
- The gateway dispatches to the running Operative via the SDK.
- The Operative consults Trello (via the `trello-data-source` CLI), the classifier (T1 — direct execute), and Memory (compiled markdown).
- It generates a reply, posts it back through `chat.postMessage` to the Slack thread.
- Every step appears in the live log on `/run`.

40 minutes later, `loop-heartbeat` ticks. It POSTs a synthetic job into the gateway. The Operative wakes, repeats the same flow autonomously.

The user opens `/fitting/documents/` in the sidebar — the Operative may have captured a "today's plan" document there via the Documents Fitting.

### Step 5: hit Stop

`Query.interrupt()` kills the Operative. Operative-bound own-port Fittings get `SIGTERM` via their status-file PIDs. The materialised `.env` is wiped. Detached Fittings (none here) keep running.

The ring buffer of logs persists. Reopen the tab and you see what happened.

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **Garrison** | The platform (this app). Composes, runs, and observes Operatives. |
| **Operative** | A composed, running autonomous agent. One per composition in v1. |
| **Composition** | An on-disk `apm.yml` + selections that define one Operative. Filesystem is the source of truth. |
| **Faculty** | A named slot in a composition (`orchestrator`, `memory`, `channels`, ...). |
| **Fitting** | The concrete component installed into a Faculty slot. A git-backed APM package with an `x-garrison` block. |
| **APM** | Microsoft's open-source Agent Package Manager. Owns manifest, install, audit, pack, lockfile. |
| **`x-garrison`** | The metadata block inside an APM `apm.yml` where Garrison's declarations live. |
| **Armory** | The `/armory` Fittings registry browser. |
| **Workbench** | The grouping of tool-facing, own-port Faculties (sessions, screen-share, etc.). |
| **View** | A UI surface a Fitting declares — either embedded (`faculty-tab` / `sidebar-surface`) or own-port. |
| **Channel** | A Fitting in the `channels` Faculty. External-world message surface (Slack, Web Channel). |
| **Capability** | A typed contract between Fittings. Declared via `provides` / `consumes`. |
| **`for_consumers`** | Free-form markdown a provider Fitting ships explaining how the Operative should use it. |
| **Verify hook** | The Fitting-declared command the runner runs to prove the Fitting works. Read-only. |
| **Setup hook** | The Fitting-declared command that does side-effect-causing prep before verify. |
| **Own-port Fitting** | A Fitting that serves its own React UI on its own HTTP port and writes a status file at `~/.garrison/ui-fittings/<id>.json`. |
| **Embedded Fitting** | A Fitting whose UI renders inside the Garrison Next.js shell via the static view registry. |
| **`garrison://` URL** | The cross-Fitting link scheme. Renderers translate to Next.js `<Link>`s. |

---

## What to read next

- **Spec and shape of v1** → [SPEC.md](./SPEC.md)
- **Live phase status** → [GARRISON_ROADMAP.md](./GARRISON_ROADMAP.md)
- **Authoring a Fitting** → [METADATA.md](./METADATA.md) + [FITTINGS.md](./FITTINGS.md)
- **Capability vocabulary** → [CAPABILITIES.md](./CAPABILITIES.md)
- **Faculty intent and failure modes** → [FACULTIES.md](./FACULTIES.md)
- **Own-port UI pattern** → [UI-FITTINGS.md](./UI-FITTINGS.md)
- **v1 Definition of Done** → [V1_DOD.md](./V1_DOD.md)
- **Decision log** → [DECISIONS.md](./DECISIONS.md)
- **Governance / Honesty Test** → [GOVERNANCE.md](./GOVERNANCE.md)

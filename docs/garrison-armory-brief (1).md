# Garrison Armory: tools as a Faculty

## Context

Garrison's primary axis is Operatives — agentic primitives composed via Faculties and Fittings, wired through provides/consumes declarations in the `x-garrison` block of `apm.yml`. Alongside Operatives, the day-to-day workflow needs a set of *non-agentic* tools that integrate tightly with how the user works: worktree creation, session monitoring, terminals, screen sharing, browser surfaces, and similar.

Today these tools live as standalone apps (Sequoias is the current example — a Next.js worktree manager). That path has two problems:

1. Each tool is a monolith that fits a single workflow snapshot; when the workflow shifts, the tool stops fitting and a new one gets built.
2. Tools don't compose with each other or with Garrison's existing primitives, so capability gets duplicated rather than reused.

The decision is to fold the tooling surface into Garrison itself, using the same Faculty/Fitting wiring that already governs Operatives.

## Decision

Tools are **not** a parallel top-level area in Garrison. They are **another Faculty** (or family of Faculties) in the existing architecture, called the **Armory** (placeholder name — see below). The Garrison shell exposes the Armory the same way it already exposes other Faculty surfaces such as chat and the planned observability surface: by dynamically rendering whatever Fittings are installed under that Faculty in the active composition.

There is no new architectural concept introduced. The Armory reuses Faculties, Fittings, the `x-garrison` block, and the provides/consumes wiring graph exactly as Operatives do.

### Naming

The faculty needs a name suggesting tools/equipment that fits the Garrison metaphor:

- **Armory** — primary recommendation. "Where the gear lives," pairs naturally with Operatives, single-word noun.
- Alternatives if Armory doesn't land: Workbench, Kit, Loadout, Quartermaster.

The rest of this document uses **Armory**.

## How an Armory Fitting expresses itself

An Armory Fitting is a UI Fitting — same kind already used by the chat surface — that participates in the wiring graph. Concretely it can:

- **Render a panel** in the Armory area of the Garrison shell.
- **Provide** data or state through `provides` declarations (e.g., the current set of worktrees, the active session list).
- **Consume** capabilities through `consumes` declarations and **expose actions** other panels or Operatives can invoke (e.g., create a worktree, kill a session, open a PR).

Most useful Fittings do all three. No new primitive is added; this is just the standard wiring contract applied to UI tooling.

## Open and extensible faculty set

Garrison ships a small seed set of well-known Armory faculties with stable contracts:

- `worktree-management`
- `session-view`
- `terminal`
- `screen-share`
- `browser`

Users can declare ad-hoc Armory faculties in their composition's `x-garrison` block when they need something one-off (e.g., a web Excel surface, a custom dashboard). Ad-hoc faculties don't get the same composition guarantees as well-known ones — they wire up and render, but other Fittings can't depend on contracts that aren't published.

## Garrison shell integration

The Armory area in the shell is dynamic, not hand-coded. The shell:

1. Reads the active composition's `x-garrison` block.
2. Identifies all installed Fittings whose declared faculty is an Armory faculty.
3. Renders each panel Fitting as an entry in the Armory area.
4. Wires `provides`/`consumes` declarations into the same graph used elsewhere in Garrison.

This is the same pattern the existing chat surface and the planned observability surface follow. No special-case UI is built for the Armory; it is structurally identical to other Faculty surfaces, just populated by a different family of Fittings.

This assumes parity with how UI Fittings already integrate via APM. If APM's existing UI Fitting support doesn't cover what the Armory needs, the gap is in the broader UI Fitting mechanism, not in the Armory specifically — and the fix benefits both.

## Worked example: Sequoias decomposition

Sequoias is the verification target. Today it's a single Next.js app for worktree management. Decomposed into Armory Fittings, it becomes three Fittings filling three faculties:

- **worktree-management Fitting** — provides the current set of worktrees; exposes an action to create a new worktree with the user's preferred port allocation and startup commands.
- **session-view Fitting** — consumes the worktree stream from `worktree-management`; provides session state (running, idle, needs attention, finished); exposes actions (open PR, kill session, refocus).
- **terminal Fitting** — consumes the active worktree selection; renders an xterm-based terminal in that directory. The terminal Fitting is already on the Garrison roadmap; here it slots under the Armory.

The decomposition delivers the property Sequoias-as-monolith doesn't: when the worktree workflow changes (different port scheme, different startup commands, different VCS layout), only the `worktree-management` Fitting is replaced. The session view and terminal keep working because they consume the contract, not the implementation.

This is also the verification milestone for the Armory pattern itself: once Garrison can host all three Fittings and Sequoias can be retired in favor of them, the pattern is proven.

## Operative bridge (deferred, design-now-cost-zero)

Action declarations on Armory Fittings use the same `provides`/`consumes` contract Operatives already use. Once that's true, an agent-skill Operative can invoke an Armory tool action the same way it invokes any other tool. Concretely: "spin up a worktree for the Armory brief and open a terminal in it" becomes a single instruction the orchestrator routes through the wiring graph.

This bridge is **not** a v1 deliverable. The point is that designing the action contract this way now costs nothing extra and unlocks the bridge later without rework.

## Out of scope

- **Public discovery, curated lists, ratings, marketplaces.** These are downstream consequences of having something useful, not preconditions for it. Garrison must first be useful for a single user before any discovery layer is worth designing.
- **Multi-domain tooling** (marketing, finance, operations, etc.). Those belong to Ekoa. The Armory is scoped to tools an agentic-development workflow actually consumes.

## Roadmap delta

What changes:

- The currently-planned "Tools area" line item is replaced by: **Armory faculty (or family of faculties) + seed Fittings**.
- Screen-share moves from a free-floating planned tool into a Fitting under the `screen-share` faculty in the Armory.
- The terminal Fitting already on the roadmap is reclassified as an Armory Fitting under the `terminal` faculty.
- Sequoias' three-Fitting decomposition becomes the Armory verification milestone.

What does **not** change:

- The five capability kinds (orchestrator, agent-skill, memory-store, automation-runner, vault) for Operatives.
- The composer/UX taxonomy of Faculties.
- The provides/consumes wiring contract.
- The APM-based packaging substrate and `x-garrison` block.

The Armory is purely additive — a new Faculty (or family of Faculties), with the same wiring, surfaced dynamically in the existing shell.

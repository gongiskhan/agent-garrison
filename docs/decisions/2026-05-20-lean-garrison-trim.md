# Lean Garrison trim — Chat, Tools, test box, sub-agent pane removed

**Date:** 2026-05-20
**Status:** Settled

## Context

Garrison drifted from its stated mandate — **compose, run, observe
Operatives on localhost** — into building Operative-facing UI itself.
The drift surfaced as:

- A built-in `/chat` page wired to the gateway, duplicating what a
  Channel Fitting (Slack today; a Web Channel Fitting planned) is
  supposed to do.
- A `/tools` discovery page that treated five Faculties
  (`terminal`, `screen-share`, `worktree-management`, `session-view`,
  `outposts`) as a privileged category Garrison "knows about" — at
  odds with the rule that Garrison only knows about **views**, not
  "tools".
- An "Operative test box" in `/run` that POSTed to the gateway from
  inside Garrison — again duplicating Channel-Fitting work, with the
  added confusion of pretending not to be a channel.
- A "Sub-agent pane" in `/run` that read the coding-subagent
  Fitting's on-disk registry directly, reaching into a specific
  Fitting's internals from the platform.
- CLAUDE.md, GARRISON_ROADMAP.md, and docs hardcoding specific
  downstream-consumer paths (`~/.claude/memory-compiler/`,
  `~/Projects/awc-gateway-slack/`, `mac-mini/gateway/heartbeat/trello.py`)
  and consumer-feature naming ("EKOA port", "Kanban-as-control-plane",
  "Trello-as-tasks") as if they were Garrison's mission.

The [Honesty Test](../GOVERNANCE.md#3-the-honesty-test) rejects all
of these: they only make sense for a specific consumer (Gonçalo's
Ekus / EKOA stack), not for Claude Code on its own merits.

## Decision

1. **Delete the built-in Chat surface.** No `/chat` route, no
   `ChatPanel`, no `ChatContext`, no `/api/runner/[id]/chat` proxy,
   no `/api/monitor/discover`. Operative interaction goes through
   Channel Fittings via the gateway. The gateway's `/chat` HTTP
   endpoints stay — they're what channels POST to.

2. **Delete the Tools area.** No `/tools` route, no `ToolsPanel`,
   no `useToolDiscovery` hook, no `/api/tools/discover`. The
   sidebar's Views section already auto-surfaces Fittings with
   embedded views (`placement: sidebar-surface`) and own-port live
   links (status read from `~/.garrison/ui-fittings/*.json`). Rename
   the underlying hook and route to honest names:
   `useFittingViewStatus` reading `/api/fittings/views`.

3. **Delete the Operative test box.** No `sendTestMessage` in
   `src/lib/runner.ts`, no `/api/runner/[id]/test` route. A Channel
   Fitting is the right place for "send a message to the Operative."

4. **Delete the Sub-agent pane.** No
   `/api/runner/[id]/subagent-logs`, no `/api/runner/[id]/subagent-kill`.
   The coding-subagent Fitting still writes its execution registry —
   if it wants a live view, it owns one as a Fitting view.

5. **Codify the downstream-consumer rule** as a sub-section under
   the Honesty Test in `GOVERNANCE.md` §3.1. Strip consumer-specific
   paths and feature naming from `CLAUDE.md`, reframe `GARRISON_ROADMAP.md`
   as a journal that historically references the consumers but does
   not adopt their workflows as Garrison's mission, and update
   `docs/SPEC.md` / `docs/UI-FITTINGS.md` to remove `/chat` and
   `/tools` from the visible-surface list.

## Resulting shell

Garrison's visible surfaces after this trim:

- **Garrison** (home) · **Compose** · **Armory** · **Run** · **Vault**
- **Views** group in the sidebar — auto-populated per composition,
  surfaces embedded sidebar-surface views and own-port live links
- Per-Fitting routes at `/fitting/<id>/...` for read-only overview
  and any views the Fitting declares

No Chat, no Tools, no Operative-test surface, no Sub-agent inspector.

## Consequences

- The Web Channel Fitting becomes load-bearing for the
  browser-conversation use case. Until it ships, Slack is the only
  channel surface.
- Fittings that want a live observation surface (e.g. coding-subagent)
  must declare their own view. Garrison no longer ships per-Fitting
  observability inside the Run page.
- Documentation contributors must apply the Honesty Test §3.1 to
  new entries: consumer-specific examples belong in the Fittings'
  READMEs, not in Garrison's docs.

## See also

- [GOVERNANCE.md §3.1 — Downstream consumers](../GOVERNANCE.md#31-downstream-consumers)
- [2026-05-17 — Dissolve Workbench](./2026-05-17-dissolve-workbench.md) —
  the immediate predecessor decision; this trim continues the same
  direction (Garrison knows about Fittings, not categories).

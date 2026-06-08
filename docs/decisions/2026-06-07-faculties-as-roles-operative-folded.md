# Faculties become roles; the Operative folds into your real Claude Code — the Quarters pivot

**Date:** 2026-06-07
**Status:** In progress (engine + read-only Quarters + roles cut shipped; hosted launcher + full docs sync pending)

## Context

Garrison previously **composed and spawned an Operative** — a separate
Anthropic-SDK agent assembled from a soul + orchestrator prompt, with an
mcp-gateway sidecar, driven by 24 flat Faculties and 13 `agent-skill`
Fittings. The **Quarters brief** supersedes the earlier "configuration plane"
brief and reframes the product: *Garrison becomes a transparent front-end /
control plane over the user's real `~/.claude` Claude Code install*, with
**APM (Microsoft Agent Package Manager) as the single writer** for the package
surface. "The Operative" stops being a separately-spawned SDK agent and
**becomes the user's real Claude Code**; Channels/Gateway route to it as
runtime.

Positioning unchanged: open-source, local-first, single-user, localhost-only.
This pass keeps the seed **single-user** (the user's own install) per the
brief — not genericised for multi-user yet.

## Verified ground truth (probed against the installed tools, not assumed)

APM 0.11.0; Claude Code 2.1.168.

1. **APM is project-scoped** — `apm install` deploys into `<cwd>/.claude/`
   (`skills/`, `rules/`, `commands/`). `--global` targets `~/.apm/`, not
   `~/.claude`. So the only way to write the real `~/.claude` is to run from a
   project root whose `.claude` resolves there.
2. **Symlink write-through works.** `~/.garrison/global-composition/` holds
   `apm.yml` + `apm_modules/` + `.claude` → symlink to `~/.claude`. `apm install`
   writes *through* the link into the real `~/.claude` and leaves the link
   intact. `$HOME` is never polluted.
3. **APM is non-destructive to loose primitives** (collision-only overwrite,
   even with `--force`). A hand-authored `skills/foo` not in `apm.yml` survives
   and is not claimed by the lock.
4. **owned vs loose is APM-native.** owned = dep in `apm.yml` + in
   `apm.lock.yaml` `deployed_files`; loose = on disk, not in the lock.
5. **Park leaves orphans.** Dropping a dep + reinstall leaves the previously
   deployed files on disk; Garrison owns the orphan cleanup on park.
6. **`apm uninstall` rejects local-path deps** — removal of local fittings is
   "edit `apm.yml` + reinstall + Garrison cleans orphans".
7. **APM has no hooks/settings mechanism.** A bare `apm install` leaves
   `settings.json` byte-identical and writes no hooks. **The brief's "hooks are
   APM's" is wrong for the installed APM** — hooks/scalar settings stay on the
   Garrison-direct writers (the S3 `_garrison`-tagged path); APM owns only the
   package-file surface.
8. **SP2 — `~/.claude/rules/*.md` auto-loads (verified empirically AND in the
   primary docs).** A sentinel `~/.claude/rules/<x>.md` with no `paths:`
   frontmatter was auto-loaded by a standard headless `claude --print` run.
   Docs (code.claude.com/docs/en/memory) confirm: "Personal rules in
   `~/.claude/rules/` apply to every project" and "Rules without `paths`
   frontmatter are loaded at launch with the same priority as `.claude/CLAUDE.md`".
   **Precedence caveat:** CLAUDE.md and rules are delivered as a *user message*
   after the system prompt — "no guarantee of strict compliance"; for
   system-prompt-level authority, `--append-system-prompt` is the documented
   mechanism (per-launch). So the orchestrator rules-file is the durable,
   reversible **default**; `--append-system-prompt` is the higher-authority
   launch-time **fallback**.

   *Methodology note:* SP2 was first answered by a docs-guide subagent. That
   answer was not treated as load-bearing — a subagent's say-so is not
   verification. The fact was promoted to load-bearing only after the empirical
   `claude --print` probe and a primary-source docs read agreed.

## Decisions (condensed from the plan; full set D1–D10 in the plan)

1. **Symlink-confined global composition** drives the real `~/.claude`. All
   paths route through `claude-home.ts` (env-overridable for the sandbox).
2. **State model** = owned / loose / **parked** (off-disk under
   `~/.garrison/parked/`, surfaced in a Seed view, out of Quarters). APM is the
   single writer for package files; Garrison owns orphan-cleanup on park.
3. **Faculties shrink 24 → 6 roles**: `orchestrator`, `channels`, `gateway`,
   `memory`, `observability`, `sessions`. Skills/Hooks/MCPs/Plugins/Scripts/
   Settings/Context/Plans become Quarters **platform primitives**, not
   Faculties. Own-port residue (terminal/screen-share/worktree/session-view/
   outposts/browser/monitor/web-channel/voice) survives at runtime under
   sessions/channels/observability via a metadata `own_port` flag, not as
   selectable faculties.
4. **Capability kinds shrink** — dropped `soul`, `agent-skill`,
   `automation-runner`, `data-source`, `mcp-gateway`.
5. **The Operative folds in.** The separately-spawned SDK agent + souls +
   mcp-gateway sidecar are retired. The orchestrator becomes an **APM-managed
   instructions primitive** — its prompt is projected to
   `~/.claude/rules/garrison-orchestrator.md` (reversible; `--append-system-prompt`
   fallback). Prompt-based, never programmatic config.
6. **No save buttons.** Every Quarters config surface autosaves (discrete =
   immediate, text/number/json = debounced). Settings drift is surfaced via a
   read-only `/api/settings/drift` poll (echo-suppressed against the last-seen
   baseline).
7. **"Memory" → "Context"** for the CLAUDE.md editor; "Memory" is reserved for
   the faculty/compiler that *produces* the document.

## What shipped in this pass (all green: typecheck, vitest, e2e, build)

- **Engine (EA1–EA4):** `global-composition.ts` (symlink + `apm install`
  through it + lock reader), `primitive-state.ts` + `claude-scan.ts`
  (loose/owned/parked classifier), `reconcile.ts` (importer → reusable lib,
  hash-compare echo suppression), `state-transitions.ts` (promote/park/unpark
  with Garrison orphan-cleanup), `provenance.ts`, `apm-exec.ts` (injectable
  `ApmRunner`), `apm-manifest.ts`, `atomic-write.ts`.
- **Quarters UI (UI1):** 10-category index over the real `~/.claude`, sidebar
  Quarters group, `/api/quarters`.
- **No-save autosave (UI2 + the Memory retirement):** Settings rewritten to
  autosave (no Save button) + live drift poll; the old Save-button MemoryPanel
  retired — `/memory` now 308-redirects to the autosave Context surface.
- **Roles cut (RC1+RC2):** faculties 24→6, capability kinds shrunk, spawn
  machinery (souls + mcp-gateway) deleted from the runner; `spawnGateway`/
  `spawnClaude` kept as the execution lane.
- **Orchestrator projection (RC3):** `orchestrator-projection.ts` —
  `buildOrchestratorInstructions` (pure soul+orchestrator+`{{capabilities}}`
  fold) + `projectOrchestrator` (APM instructions primitive →
  `~/.claude/rules/garrison-orchestrator.md`, owned + provenance) +
  `orchestratorAppendSystemPrompt` (fallback).
- **Survivor re-tag:** the 10 own-port survivor Fittings declare their **role**
  directly on disk (not a deprecated faculty folded via alias), so "faculties
  are roles" is honest on disk and the per-load deprecation warnings are gone.
  Aliases stay in `metadata.ts` for external/back-compat with a warning.

## Deferred (explicitly, not silently)

- **RC4** — hosted authoring (`hosted-authoring.ts`, `scoped-reconcile.ts`) and
  the **Run → hosted-session launcher** reframe. Until then, `up()` still spawns
  a Claude process via `spawnGateway`/`spawnClaude` (the Run copy is accurate,
  not stale — it genuinely spawns); the launcher that passes the projected
  orchestrator is not wired yet.
- **RC5 docs sync** — `CLAUDE.md`, `FACULTIES.md`, `CAPABILITIES.md`,
  `METADATA.md`, `DECISIONS.md`, `FLOW_PLAN.md` still describe the retired
  24-faculty/souls/mcp-gateway world. This record is the first installment.
- **garrison-control MCP** — gated on **SP1** (APM MCP write-through, unverified).
- **EA5** — retire the S2 own-installer (`claude-install.ts`) as a strangler.
- **UI6 / UI7** — Logs+Sessions read-only tailing (currently placeholder
  panels); Compose reframed as the role-fitting editor for the global
  composition.
- **EA2 follow-ups** — plugins classification (SP6), `installed_plugins.json`
  schema; `writeFileAtomic` mode caveat for 0600 files.

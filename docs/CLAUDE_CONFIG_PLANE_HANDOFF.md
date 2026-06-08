# Garrison as the Config Plane for Claude Code → the Quarters pivot — handoff / starting point

**Status:** two layers.
- **Layer 1 (committed on the branch, S1–S5):** the original "configuration
  plane" — merge-managed Settings, install/ownership backend, hooks, CLAUDE.md
  editor, importer. Commits `6bf6e52 240a43b 282f3ad a91ba55 2580877 40035fe
  c4625bc e391f06` (+ `c95f8ec` autothing foundation). Gated green per slice.
- **Layer 2 (the current direction, large uncommitted working tree):** the
  **Quarters pivot** — Garrison becomes a transparent front-end over the user's
  real `~/.claude`, APM is the single writer, and "the Operative" folds into the
  user's real Claude Code. Engine + read-only Quarters + the roles cut shipped
  (typecheck/lint/vitest/build green at authoring); hosted launcher + docs sync
  pending.

**Plans of record (read these first to continue):**
- `~/.claude/plans/brief-garrison-zippy-sparrow.md` — the authoritative Quarters
  brief + decisions D1–D10 (the source of truth for the pivot).
- [`FLOW_PLAN.md`](./FLOW_PLAN.md) — the S1–S5 slice table + acceptance.
- [`decisions/2026-06-07-faculties-as-roles-operative-folded.md`](./decisions/2026-06-07-faculties-as-roles-operative-folded.md)
  — the Quarters-pivot decision record (the most current narrative; verified
  APM/Claude-Code ground truth, what shipped, what's deferred).
- `docs/autothing/` — build bookkeeping: `decisions.md` (blockers),
  `evidence-index.json`, `evidence/*` (videos/screens), `slices/S*/gate-status.json`.

---

## 1. The vision

Garrison stops *spawning its own agent* and instead becomes a **control plane
over the user's real Claude Code install** (`~/.claude`):

- **APM (Microsoft Agent Package Manager) is the single writer** for the package
  surface (`skills/`, `commands/`, `rules/`). Garrison never hand-writes those.
- **"The Operative" folds in** — the separately-spawned Anthropic-SDK agent
  (soul + orchestrator prompt + mcp-gateway sidecar) is retired. The orchestrator
  becomes an APM-managed **instructions primitive** projected to
  `~/.claude/rules/garrison-orchestrator.md` (reversible; `--append-system-prompt`
  is the higher-authority launch-time fallback). Channels/Gateway route to the
  user's real Claude Code as the runtime.
- **No save buttons.** Every config surface autosaves; external drift is surfaced
  read-only.

Positioning unchanged: open-source, local-first, single-user, localhost-only.
Seed stays single-user (the user's own install).

### Verified APM/Claude-Code ground truth (probed, not assumed — APM 0.11.0, CC 2.1.168)
1. APM is **project-scoped**: `apm install` writes `<cwd>/.claude/`; `--global`
   targets `~/.apm/`, not `~/.claude`.
2. **Symlink write-through works**: `~/.garrison/global-composition/` holds
   `apm.yml` + `apm_modules/` + `.claude → ~/.claude` (symlink); `apm install`
   writes *through* the link into the real `~/.claude`. `$HOME` is never polluted.
3. APM is **non-destructive to loose primitives** (collision-only overwrite, even
   `--force`). Hand-authored files not in `apm.yml` survive.
4. **owned vs loose is APM-native**: owned = dep in `apm.yml` + in
   `apm.lock.yaml` `deployed_files`; loose = on disk, not in the lock.
5. **Park leaves orphans** — Garrison owns orphan cleanup on park.
6. `apm uninstall` **rejects local-path deps** — removal = edit `apm.yml` +
   reinstall + Garrison cleans orphans.
7. **APM has no hooks/settings mechanism** — a bare `apm install` leaves
   `settings.json` byte-identical. Hooks/scalar settings stay on the
   Garrison-direct writers (the S3 `_garrison`-tagged path). APM owns only
   package files.
8. **`~/.claude/rules/*.md` auto-loads** (verified empirically + in docs) — this
   is why the orchestrator projects to a rules file. Precedence caveat: CLAUDE.md
   and rules arrive as a *user message* (no strict-compliance guarantee);
   `--append-system-prompt` is the system-prompt-authority fallback.

---

## 2. Layer 1 — the S1–S5 config plane (committed)

| slice | what | route | key files |
|-------|------|-------|-----------|
| **S1 settings** | Settings surface over `~/.claude/settings.json`, **merge-managed / never-clobber** (patch only changed keys, byte-preserve unknown keys, surface external drift) | `/settings` | `src/lib/claude-settings-file.ts`, `src/lib/settings.ts`, `src/components/settings/SettingsPanel.tsx` |
| **S2 install** | Global **install/ownership backend** + lockfile; skills → `~/.claude/skills/`; **adopt** brown-field existing files; refuse to clobber unowned targets | `/armory` | `src/lib/claude-install.ts`, `src/lib/claude-install-source.ts`, `src/lib/claude-home.ts` |
| **S3 hooks** | Hook fittings via the shared **owner-scoped** writer (`_garrison`-tagged groups coexist/uninstall independently); deleted dead `claude-hooks.ts`; session-view migrated | `/settings` | shared writer in the settings libs |
| **S4 memory** | **CLAUDE.md editor** (user `~/.claude/CLAUDE.md` + a project CLAUDE.md), never-clobber; compiler untouched | `/memory` | `src/lib/claude-md.ts`, memory UI |
| **S5 importer** | `scripts/import-claude-install.ts` — scan `~/.claude` → emit fittings (+`--adopt`) | (cli) | `scripts/import-claude-install.ts` |

Per-slice gates (tests/typecheck/lint/build/e2e) were taken green and committed
before the evidence pass — see `docs/autothing/slices/S*/gate-status.json`.
**Known blocker (S5):** hook-fitting *emission* is reported-only (untagged group
count); only **skill** fittings are emitted+validated. The resolver→`hook-group`
path isn't wired. Logged in `docs/autothing/decisions.md`.

---

## 3. Layer 2 — the Quarters pivot (uncommitted working tree)

This is the active direction and supersedes the Layer-1 framing. It is **not yet
committed** — it's the body of work this handoff is capturing onto `main`.

### What shipped in this pass (green at authoring: typecheck, vitest, e2e, build)
- **Engine (EA1–EA4)** — new libs under `src/lib/`:
  - `global-composition.ts` — the **symlink-confined global composition**
    (`~/.garrison/global-composition/` with `.claude → ~/.claude`); runs
    `apm install` through it; reads the lock.
  - `claude-scan.ts` — disk-scan of the `~/.claude` package-file shapes
    (`skills/<n>/`, `commands/<x>.md`, `rules/<x>.md`).
  - `primitive-state.ts` — the **owned / loose / parked** classifier (owned = in
    `apm.lock.yaml deployed_files`; loose = on disk not in lock; parked = moved
    off-disk under `~/.garrison/parked/`).
  - `reconcile.ts` — the S5 importer **promoted to a reusable lib** (capture loose
    primitives; hash-compare echo suppression).
  - `state-transitions.ts` — **promote / park / unpark** with Garrison
    orphan-cleanup.
  - `provenance.ts` — the **provenance ledger**: ownership for non-file surfaces
    (hooks in `settings.json`, MCP in `mcp.json` — neither in the lock) + the
    per-primitive `lastWrittenHash` that powers **echo suppression** (a watcher
    event whose on-disk hash equals our last write is ignored).
  - `apm-exec.ts` — injectable `ApmRunner` seam (tests stub APM's on-disk effects
    so the unit gate stays fast/deterministic).
  - `apm-manifest.ts` — authoring of `apm.yml dependencies.apm[]` (shared by the
    per-operative and global composition writers).
  - `atomic-write.ts` — crash-safe / torn-read-safe writes (no-save autosave +
    a watcher reading the instant a write lands).
  - `orchestrator-projection.ts` (RC3) — `buildOrchestratorInstructions` (pure
    soul+orchestrator+`{{capabilities}}` fold) + `projectOrchestrator` (→
    `~/.claude/rules/garrison-orchestrator.md`, owned + provenance) +
    `orchestratorAppendSystemPrompt` (fallback).
  - `plans.ts` — markdown plan files under `~/.claude/plans` (autosave, filename
    guard).
- **Quarters UI (UI1)** — a 10-category index over the real `~/.claude`, a
  sidebar **Quarters** group, `/api/quarters`. New under `src/app/quarters/`,
  `src/components/quarters/`, `src/app/api/quarters/`.
- **No-save autosave (UI2 + Memory retirement)** — Settings rewritten to autosave
  (no Save button) + a live **drift poll** (`/api/settings/drift`, echo-suppressed
  against the last-seen baseline). The old Save-button `MemoryPanel` is **retired**
  (`src/components/memory/MemoryPanel.tsx` deleted); `/memory` 308-redirects to the
  autosave **Context** surface. ("Memory" → "Context" for the editor; "Memory"
  stays the faculty/compiler that *produces* the document.)
- **Roles cut (RC1+RC2)** — Faculties **24 → 6 roles**; capability kinds shrunk;
  the spawn machinery (souls + mcp-gateway) **deleted** from the runner
  (`src/lib/soul-spawn-config.ts`, `src/lib/mcp-gateway/launch.ts` and their tests
  removed). `spawnGateway`/`spawnClaude` are kept as the execution lane.
- **Survivor re-tag** — the 10 own-port survivor Fittings declare their **role**
  directly on disk with an `own_port: true` flag (not a deprecated faculty folded
  via alias). Aliases stay in `metadata.ts` for back-compat with a warning.

### The 6 roles (was 24 Faculties)
`orchestrator`, `channels`, `gateway`, `memory`, `observability`, `sessions`.
Everything else (Skills/Hooks/MCPs/Plugins/Scripts/Settings/Context/Plans) is a
**Quarters platform primitive**, not a Faculty. The own-port residue
(terminal / screen-share / worktree / session-view / outposts / browser / monitor
/ web-channel / **voice**) survives at runtime under sessions/channels/
observability via the metadata `own_port` flag.

**Dropped capability kinds:** `soul`, `agent-skill`, `automation-runner`,
`data-source`, `mcp-gateway`.

### State model
`owned` (APM-managed, in the lock) · `loose` (on disk, hand-authored or orphaned)
· `parked` (moved off-disk under `~/.garrison/parked/`, surfaced in a Seed view,
out of Quarters). APM is the single writer for package files; Garrison owns
orphan cleanup on park.

---

## 4. New files added by the Quarters pivot (untracked → will land in this commit)

**Libs** — `src/lib/`: `global-composition.ts`, `claude-scan.ts`,
`primitive-state.ts`, `reconcile.ts`, `state-transitions.ts`, `provenance.ts`,
`apm-exec.ts`, `apm-manifest.ts`, `atomic-write.ts`, `orchestrator-projection.ts`,
`plans.ts`, `quarters.ts`.

**API routes** — `src/app/api/quarters/`, `src/app/api/plans/`,
`src/app/api/settings/drift/`.

**UI** — `src/app/quarters/`, `src/components/quarters/`, `src/hooks/`.

**Tests** — `tests/`: `global-composition.test.ts` +
`.integration.test.ts`, `primitive-state.test.ts`, `reconcile.test.ts`,
`state-transitions.test.ts` + `.integration.test.ts`,
`orchestrator-projection.test.ts`, `quarters.test.ts`, `atomic-write.test.ts`,
`e2e/quarters.spec.ts`.

(Deletions in this pass: `src/components/memory/MemoryPanel.tsx`,
`src/lib/mcp-gateway/launch.ts`, `src/lib/soul-spawn-config.ts`, and the tests
`http-gateway-orchestrator-mode`, `mcp-gateway-probe-strict`,
`runner-mcp-gateway-launch`, `morning-briefing-fitting`,
`outpost-actions-fitting`, `vault-sync-fitting`.)

---

## 5. Operational seams (important for continuing)

- **Sandbox env seam:** all host-config libs route paths through `claude-home.ts`,
  overridable via **`GARRISON_CLAUDE_HOME` / `GARRISON_HOME`** (default = the real
  `~/.claude`). Automated runs (e2e/video) point these at a seeded sandbox under
  `~/.garrison-test/` so the daily install isn't mutated. **Use this seam when
  testing** — do not run destructive ops against the live `~/.claude`.
- **Ports:** the live `next dev` is on **7777** (occupied); the playwright
  `webServer` for automated runs uses **3401**.
- **Gates:** `npm test` · `npm run typecheck` · `npm run lint` · `npm run build` ·
  `npm run test:e2e`.
- **Pre-existing flaky test (not a regression):**
  `tests/orchestrator-integration.test.ts > … recalls in-session memory` is a
  live Claude-Code SDK test (~51 s, spawns a real operative) that fails on model
  non-determinism. Excluded from per-slice gates; reported honestly at the global
  gate.

---

## 6. Deferred / next steps (the roadmap to finish the pivot)

From the decision record's "Deferred (explicitly)" list — these are where to pick
up:

- **RC4 — hosted authoring + Run reframe.** `hosted-authoring.ts`,
  `scoped-reconcile.ts`, and the **Run → hosted-session launcher** that passes the
  projected orchestrator. Until then `up()` still spawns a Claude process via
  `spawnGateway`/`spawnClaude` (the Run copy is accurate — it genuinely spawns).
- **RC5 — docs sync.** `CLAUDE.md`, `FACULTIES.md`, `CAPABILITIES.md`,
  `METADATA.md`, `DECISIONS.md`, `FLOW_PLAN.md` still describe the retired
  24-faculty/souls/mcp-gateway world. The decision record is the first installment.
- **garrison-control MCP** — gated on **SP1** (APM MCP write-through, unverified).
- **EA5** — retire the S2 own-installer (`claude-install.ts`) as a strangler once
  the global-composition path fully subsumes it.
- **UI6 / UI7** — Logs + Sessions read-only tailing (currently placeholder
  panels); Compose reframed as the role-fitting editor for the global composition.
- **EA2 follow-ups** — plugins classification (SP6), `installed_plugins.json`
  schema; `writeFileAtomic` mode caveat for 0600 files.
- **S5 follow-up** — emit installable **hook** fittings (resolver→`hook-group`),
  not just skills.

---

## 7. How to run / test

```
VAULT_UNLOCKED=true npm start          # dev server on 7777
npm test                                # vitest (engine specs: global-composition,
                                        #   primitive-state, reconcile, state-transitions,
                                        #   orchestrator-projection, quarters, atomic-write …)
npm run typecheck && npm run lint && npm run build
GARRISON_CLAUDE_HOME=~/.garrison-test npm run test:e2e   # against a sandbox, never live ~/.claude
```

Quarters UI: `/quarters`. Settings (autosave + drift): `/settings`. Context
(CLAUDE.md editor; `/memory` redirects here): the autosave Context surface.

---

## 8. One-line orientation for a fresh worktree

> Garrison is being rebuilt from "spawns its own Operative" into a **transparent
> control plane over the real `~/.claude`**, with APM as the single package
> writer, a owned/loose/parked state model, 6 roles instead of 24 faculties, and
> the orchestrator projected as a `~/.claude/rules/*.md` instructions primitive.
> Layer 1 (S1–S5) is committed; the Quarters engine + read-only UI + roles cut
> are in this commit; the hosted-session launcher (RC4) and docs sync (RC5) are
> the next big pieces. Start from `~/.claude/plans/brief-garrison-zippy-sparrow.md`
> and the 2026-06-07 decision record.

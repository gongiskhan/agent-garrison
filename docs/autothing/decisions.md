# autothing build decisions & blockers

Build-time decisions and blockers for the config-plane build. Kept separate from the project's canonical `docs/DECISIONS.md` (which collides case-insensitively with `docs/decisions.md` on macOS — so autothing uses this path instead).

## 2026-06-07 — baseline

- **Pre-existing flaky test (NOT mine, NOT a regression):** `tests/orchestrator-integration.test.ts > operative recalls in-session memory across turns` fails on the branch baseline — a LIVE Claude-Code SDK test (spawns a real operative, ~51s) asserting the model recalls the word "teal" across turns. It failed on live-model non-determinism ("I don't have memory of that…"), unrelated to config-plane code. **Per-slice `tests` gate excludes this file**; the global gate runs the full suite and reports it honestly as a pre-existing non-blocking flake.
- **Sandbox for automated runs:** the build's exploration/e2e/walkthrough drive the *real running app*, whose API routes default to the user's live `~/.claude/`. To avoid mutating the daily-use install, new host-config libs read a `GARRISON_CLAUDE_HOME` / `GARRISON_HOME` env seam (default = real paths); the e2e/video dev-server points them at a seeded sandbox under `~/.garrison-test/`.
- **Port 7777 is occupied** by the user's live `next dev`; automated runs use the playwright `webServer` on port 3401.

## 2026-06-07 — S5 importer scope

- **Hook-fitting emission deferred (honest partial):** the seed importer fully emits + validates SKILL fittings (the dominant case; an emitted fitting passes `validate-fitting`). It REPORTS untagged hook groups in settings.json but does not yet emit installable hook fittings — that requires wiring the source resolver to produce `hook-group` artifacts from a fitting definition (hooks install via a manifest's `hookGroups`, which the importer would author and the resolver would read). Scoped as a follow-up; not a regression.

## 2026-06-08 — Quarters-pivot finish wave (Q1–Q4) scope + deferrals

Continuing `/autothing finish the work at docs/CLAUDE_CONFIG_PLANE_HANDOFF.md`.
Layer 1 (S1–S5) and the Layer-2 engine + read-only Quarters + roles cut are
committed (`5e640e2`). This wave finishes the *achievable* deferred items and
honestly logs the rest. Scope set with advisor review.

**Building this wave:** Q1 RC5 docs sync · Q2 Logs+Sessions read-only tailing
(UI6/UI7) · Q3 S5 hook-fitting emission · Q4 EA2 follow-ups (atomic-write 0600 +
plugins classification). See `docs/FLOW_PLAN.md` for the slice table + gates.

**Deferred (explicitly, not silently — same honesty bar as garrison-control):**
- **RC4 (full) — hosted authoring + Run→hosted-session launcher.** Deferred
  *whole*, not half-wired. Reason (advisor-confirmed): the pivot retires the
  spawned process so the user's real Claude Code becomes the runtime; wiring
  `projectOrchestrator` into `up()` while `up()` still does
  `spawnGateway`/`spawnClaude` with `--append-system-prompt-file` would deliver
  the orchestrator instructions twice into a process the pivot is deleting — an
  architecturally incoherent half-migration, worse than the current honest state.
  `runner.ts` is intentionally untouched this wave. `orchestrator-projection.ts`
  stays unit-tested in isolation. The Run copy remains accurate ("it genuinely
  spawns").
- **Compose reframe** (the other half of the decision record's UI6/UI7 line):
  reframing `/compose` from the 24-faculty station grid into the role-fitting
  editor for the global composition. Large UI rework; deferred. Logged here so it
  does not vanish — `/compose` still shows the legacy station grid until done.
- **garrison-control MCP** — gated on **SP1** (APM MCP write-through), unverified
  ground truth. Not built blind.
- **EA5 strangler** — retiring `claude-install.ts` once global-composition
  subsumes it. Deleting a working installer in an unattended run is too risky;
  deferred until the global-composition install path is daily-use-proven.

**Expected terminal state:** `completed-with-blockers` (the correct deliverable,
not a failure) — the deferrals above plus backend/docs/CLI slices that have no
meaningful walkthrough video keep the global gate honest. Q2 is the one UI slice
that can earn a verified walkthrough video (read-only Logs/Sessions vs the
sandbox dev-server).

## 2026-06-07 — sequencing

- **Objective-gates-first, evidence pass second:** per advisor guidance for an unattended multi-slice build, all five slices were taken to code-complete + committed-test-green + typecheck/lint/build green and committed BEFORE the walkthrough/e2e evidence pass. The committed vitest specs (33 across the feature) are the correctness gate; the walkthrough videos are the evidence layer. This deviates from autothing's strict per-slice-video-before-next-slice; recorded in friction-log.

## 2026-06-09 — Quarters-CRUD wave (manage everything from the UI)

Added full create/edit/delete to the Quarters surfaces Garrison is
writer-of-record for, governed by one invariant (see FLOW_PLAN): the UI
freely CRUDs loose files / untagged hooks / mcp.json; owner-managed things
(APM lock, `_garrison` hooks, Claude Code's plugin manager) route through
the owner's mechanism or stay read-only. Slices C1 (MCP) · C2 (skills) ·
C3 (commands+rules) · C4 (hooks) · C5 (plugins-remove), serial/lead-authored.

**Deferred (logged, not dropped):**
- **Plugin install from a marketplace** — needs marketplace resolution + git
  clone; stays with Claude Code's `/plugin` (gated on SP6). Only uninstall ships.
- **MCP secrets to the vault** — MCP `env`/`headers` are written as plaintext to
  mcp.json (matches Claude Code's own format; not a regression). Routing MCP
  secrets through the AES vault is a future enhancement, not done here.
- **File-primitive rename** — editing keeps the name fixed (rename = a move);
  out of scope this wave.

**Cooperative-ownership caveat (plugins + hooks + mcp + settings):** a RUNNING
Claude Code may rewrite these files on exit, same as the settings.json surface.
The plugin uninstall confirm warns to restart. Verified the plugin manifest is
the source of truth (no `enabledPlugins` in settings.json; marketplaces only
list availability) before building removal.

## AS-wave — Agent SDK Runtime (2026-06-16)

**Pre-existing red, NOT in scope:** `tests/programmatic-purge.test.ts` was already
failing before this build on `fittings/seed/knowledge/scripts/knowledge.mjs ::
--print` (a headless-billing ban hit from the v4 knowledge fitting). This wave
does not touch knowledge.mjs; the fence slice evolved the purge test to scope the
`@anthropic-ai/` exception to the single fenced `agent-sdk-runtime/lib/sdk-client
.mjs` (every other ban intact) and added zero new offenders. `fence-ok` rides a
dedicated test, not this unrelated red.

**BLOCKER — AS-ollama-live (`sdk-ollama-live-ok`):** a CLEAN tool-call round trip
could not complete on the locally-pulled Ollama models over the Anthropic-compat
endpoint. Attempted THREE times (self-unblock): `qwen3:8b/full` → "API Error:
Content block not found" on the tool-result block + wrong tool; `qwen2.5:7b/full`
→ stall under the ~14k claude_code preset floor (killed 200s); `qwen2.5:7b/lean`
→ stall (machine load ~13, killed 150s). The adapter/fence/harness are PROVEN
live (real SDK 0.3.179 + real Ollama 0.14.3: fence=non-anthropic,
baseUrl=localhost:11434, preset=claude_code, settingSources=[project], a real
tool_use detected, token accounting). External cause: the available local models
can't complete the Claude-Code tool protocol over Ollama's Anthropic-compat
endpoint. Real fix: a tool-tuned local model (none pulled; pulling+running 30B+
under load is the failed-remediation path the brief's env note warns against) OR
a cloud provider key in the Vault (absent). NOT an adapter defect.

**BLOCKER — AS-route LIVE (`sdk-route-live-ok`):** resolution + capability gating
(MCP@deepseek refused/redirected) PASSED via committed gate
(`tests/agent-sdk-route.test.ts`, 5/5). Only the LIVE gateway route is blocked —
it needs a completing live agent-sdk turn (same local-model limitation as
AS-ollama-live).

**AS-quarters video:** the COMMITTED e2e (`tests/e2e/agentsdk-quarters.spec.ts`)
is the correctness gate and is green; it satisfies the brief's `sdk-quarters-ok`.
The walkthrough evidence video is pending (load-sensitive); the slice is
`in_progress` until the video lands.

## HV wave — Holistic Composition View (2026-06-20)

Extends the existing Quarters engine (no second mirror, no new faculties).
Components (Skills/Hooks/MCPs/Plugins) surfaced in the Compose grid from the
StateModel. Key decisions: ~/.claude.json is the AUTHORITATIVE MCP source (legacy
~/.claude/mcp.json only fills when claude.json is absent); disabled mcp/hooks are
PARKED off-disk under ~/.garrison/parked/{mcp,hooks}.json and read back via
active∪parked so the disable→enable loop round-trips; ~/.claude.json writes use a
compare-and-swap + bounded-retry guard that ABORTS leaving the live file
untouched on a persistent race (never restore-old-backup — that would silently
revert a concurrent Claude write). MCP CRUD repointed to ~/.claude.json for
coherence (legacy mcp-writer.ts kept for the in-home mcp.json + its test).

### Pre-existing test failures (NOT caused by the HV wave — out of scope)
Baseline `vitest run` already had 2 failing files (verified by reading the
baseline output; both git-unmodified by this session):
- `tests/gemini-runtime.test.ts:13` — buildArgs expects `-y`/`--skip-trust`;
  deterministic pre-existing mismatch in the gemini adapter (untouched by HV).
- `tests/orchestrator-integration.test.ts:91` — live PTY turn-1 marker; the
  load-sensitive flake the AS-wave already documented (71s live claude session).
The HV wave introduced zero new failures; its only suite delta was updating
`tests/reconcile.test.ts` to the new adopt-not-defer semantics (HV7).

## DS wave — Dev-Env durable sessions (2026-06-20)

Plan: `~/.claude/plans/we-need-to-find-tingly-lighthouse.md` (Ultraplan-refined,
then corrected against the live tree this session). Makes dev-env sessions
survive a computer reboot and pivots the session model onto Claude Code's own
`~/.claude` data.

Key decisions (and corrections to the cloud plan, verified on the real machine):
- **Live registry is the liveness source.** `~/.claude/sessions/<pid>.json` (one
  per running interactive `claude`, deleted on exit) replaces the ps/lsof
  `liveProcess` probe added earlier this session. Reading small JSON files +
  `process.kill(pid,0)` is cheaper/more precise and yields `sessionId` directly.
- **Status stays hook + `claudeBusy()` driven.** The cloud plan claimed CC
  2.1.183 omits `status`/`updatedAt` from the registry; on THIS machine every
  registry file carries `status` (+ `statusUpdatedAt` on 2.1.181/183). Registry
  status is read as a *supplement* only — busy/idle/waiting still comes from
  hooks + the live-screen `claudeBusy()` probe (proven to catch the no-hook
  thinking phase); the registry's thinking-phase responsiveness is unproven.
- **Open-set persists reboot.** A per-record `openedInDevEnv` flag is the durable
  "which tabs were open" set (it CANNOT be re-derived from liveness after a
  reboot, when nothing is live). Migration-on-read seeds it from the OLD
  visibility (live/has-PTY/active) — NOT unconditionally true, which would
  resurrect every stale ledger row as a tab.
- **Lazy resume.** Restored tabs spawn `claude --resume <claudeSessionId>` only
  on click; no mass spawn / token cost on boot.
- **Titles reuse `ai-title`** (latest wins) → first-user-message → null. Haiku
  fallback is an out-of-scope future enhancement, not a committed slice.
- **Tab membership becomes the open-set**, not "every live/active session." An
  external (iTerm) claude surfaces in the new Agents panel instead of
  auto-tabbing — an intentional, acknowledged change from earlier this session's
  auto-show-live-sessions fix (the liveness win is relocated, not lost).
- **Destructive reboot verification is sandboxed.** The `tmux -L garrison
  kill-server` reboot test runs ONLY on a throwaway `garrison-test` socket +
  isolated state/home + a non-7086 port; the live `tmux -L garrison` (holding
  the user's real ekoa-dev/ios-thing/garrison/pnmui-mon sessions) is never
  touched.

Phase 0 detect: foundation present (CLAUDE.md/docs/area-skills/gates green; codex
logged in; walkthrough tools installed) → Phase 1 no-op. Slices DS1-reader →
DS2-wire → DS3-ui, serial by data dependency.

### BLOCKER (external) — Codex cross-model gate out of credits (2026-06-20)
At DS2-wire Codex review **round 8**, `codex exec` failed with:
`ERROR: Your workspace is out of credits. Add credits to continue.`
(exit 1; no output schema written). This is a genuine EXTERNAL blocker: the
ChatGPT/Codex workspace billing is exhausted, which a skill cannot resolve
(adding credits is an operator/billing action). It disables the cross-model
gate (3A review + 3B Playwright) for ALL remaining slices.

- **Failed remediation command:** `codex exec -s read-only --skip-git-repo-check
  -C <repo> --output-schema codex-review.schema.json --output-last-message
  <out> "<review prompt>"` → `out of credits`. Re-auth/login does not help (it's
  credits, not auth). Operator must top up the Codex/ChatGPT workspace credits.
- **DS2-wire state at the block:** objective gates GREEN (vitest 36/36 across
  dev-env-claude-sessions/resume-by-id/open-set/sessions-endpoints, typecheck 0).
  Codex adversarial review ran **7 rounds** (r1→r7), each surfacing real findings
  that were ALL fixed forward with committed regressions:
  identity-collapse on /open, state-write races (mutex + unique temp), shell
  injection in resumeId, worktree-pin, hook map-key routing, fallback/cleanup +
  worktrees serialization, resume-by-id wiring, three hook/open duplicate/
  overwrite variants, tombstone-resurrection, and the two-concurrent-hooks
  collapse. Round 8 (confirming the r7 fix) could not run. So DS2 has NO clean
  `approve` and is recorded **blocked** on the cross-model gate, NOT `passed`.
- **Decision (updated):** the /goal Stop-hook re-fired requiring a terminal
  verdict (buildable-remaining 0), and the autothing recipe says to log the
  out-of-credits cross-model blocker and CONTINUE to `completed-with-blockers`.
  So DS3-ui was built (objective gates green + UI screenshot-verified) and
  recorded **blocked** on the same external Codex-credits blocker as DS2; the
  global gate is **completed-with-blockers**. On credit top-up: re-run DS2 r8
  (expected approve) → DS2 passed; run DS3 cross-model (3A+3B) → DS3 passed.

### Pre-existing full-suite failures (NOT caused by the DS wave — out of scope)
`vitest run` (whole repo) shows 11 failures across 7 files, ALL pre-existing in
the working tree and outside the DS diff (DS touches only dev-env scripts/UI +
new `tests/dev-env-*`):
- `fittings/seed/memory/` **directory is absent** at baseline (basic-memory
  migration) → `tests/seed.test.ts` (3), `tests/validation.test.ts` (1),
  `tests/fitting-files-api.test.ts` fail with "seed memory should have an
  apm.yml: expected null".
- `tests/dev-env.test.ts` (1) — library/metadata ZodError (readLibrary), baseline.
- `tests/gemini-runtime.test.ts` (1) + `tests/orchestrator-integration.test.ts`
  (1) — the documented deterministic / live-PTY baselines.
- `tests/runner-eager-lifecycle.test.ts` (4) — runner lifecycle; `src/lib/runner`
  is git-unmodified by DS.
The DS suite is fully green: dev-env-claude-sessions 11, resume-by-id 5,
open-set 13, sessions-endpoints 7 = 36/36; typecheck 0; dev-env bundle build 0.

## run 20260622-143110-e93ec4b5

- PRE-EXISTING (not introduced by this run; present at BASE c092101): 6 vitest failures —
  tests/validation.test.ts + tests/seed.test.ts (x3) + tests/claude-install.test.ts reference a
  `fittings/seed/memory` seed that does not exist (likely a memory→basic-memory rename left stale
  ids/tests); tests/gemini-runtime.test.ts buildArgs; tests/fitting-files-api.test.ts. Out of the
  modes slice's scope — logged, not fixed here.
- modes faculty modeling: added a dedicated single-cardinality `modes` faculty (the sanctioned
  "new faculty when a real Fitting needs one" trigger) rather than overloading the singleton
  `orchestrator` faculty. `automation-runner` capability kind already existed (re-added 2026-06-13),
  so only `modes` kind was added.
- DEFERRED to s1c: resolve `briefs_path` against the composition dir in the souls config (setup.mjs
  only pre-creates a placeholder dir relative to the fitting install dir).
- DEFERRED doc nit: CLAUDE.md up-order step 6 still says "Anthropic Agent SDK in-process" (stale vs
  PTY-everywhere) — a follow-up doc pass, out of s0/s1 scope.

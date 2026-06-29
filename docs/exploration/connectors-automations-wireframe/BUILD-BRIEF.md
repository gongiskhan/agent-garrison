# Connectors + Automations — Build Brief

**Status:** spec, ready to build. Nothing built yet. Companion to the wireframe
(`index.html` in this folder — open it; it is the visual + behavioral spec).
This brief is the engineering source of truth: locked decisions, **verified code
anchors** (so you don't re-explore), build order, and done-criteria.

> Scope intent: **build all of it, in one continuous effort.** This is large and
> multi-faculty by design. Do not descope, defer, or stop after a "phase." The
> phases below are a dependency-ordered build sequence, not delivery milestones.

---

## 1. Goal

Bring ekoa's automation engine (`../ekoa-dev`, the `cortex/src/automation` +
`ekoa/components/automations` code) into Garrison as new Fittings — bash & browser
steps, vision-driven self-healing, live streaming, per-step feedback,
human-in-the-loop — **except** ekoa's `ekoa_action` step (dropped). But instead of
reusing Garrison's early substrate as-is, **audit each substrate against ekoa's and
take the best of each, upgrading or chucking Garrison's where it loses.** Add a
**Connectors** faculty, a **Vault that seals every credential** (the marquee
differentiator), and a **chat-to-build** authoring flow.

## 2. Reference

- **`index.html`** (this folder) — the wireframe. Every screen, all 8 step types
  with their authoring form + what each renders, the run viewer, the Vault marquee,
  the chat-to-build flow, File Browser, scheduler, and the decisions/phasing.
- Memory **`garrison-connectors-automations-design`** — the locked decisions.
- Source under audit: `../ekoa-dev/cortex/src/automation/*` (engine, planner,
  rehearsal, executor, fingerprint, cache, browser-session, streaming) and
  `../ekoa-dev/ekoa/components/automations/*` (run-viewer, step-forms, etc.).

## 3. Guardrails (non-negotiable)

- **Honesty Test** (`docs/GOVERNANCE.md` §3): every capability must be justifiable
  for Claude Code on its own merits — ekoa is a consumer, never a reason. No
  hardcoded user paths or consumer names in Garrison code/docs/manifests.
- **Never create a git branch** unless explicitly told. Work on the current branch.
- **Verify or don't ship:** every new Fitting declares a `verify` hook; the runner
  never claims success without it. Setup = side-effecting prep; verify = read-only.
- **Coordinate:** this touches shared structure (`src/lib/types.ts`,
  `metadata.ts`, `capabilities.ts`, Compose UI) heavily and other sessions are
  active in this repo — `begin_planning` and `declare_intent` before the structural
  edits; honor a WAIT.
- Permission mode is `bypassPermissions`. No emojis in UI code (text/SVG/icon
  fonts). No Save buttons in Quarters surfaces (autosave + drift).
- YAML field names don't churn for cosmetic gain (`component_shape`,
  `cardinality_hint` stay).

## 4. Locked decisions

| # | Decision |
|---|----------|
| 1 | Trello → Connectors; **drop Data Sources**; a DB (Supabase) is just a Connector; future DB Fittings reconsidered later. |
| 2 | **Connectors** faculty; remove Data Sources; new `connector` capability kind. |
| 3 | **One Connector = One Fitting** (clean APM packaging). |
| 4 | Automations stored as **YAML files**, machine-local: `~/.garrison/automations/<id>.yml`. |
| 5 | Planner (+ per-step vision/fixer) **routes through the Model Router** — no hardcoded model. |
| 6 | Connector defs ship one-Fitting-each; marquee services (Slack/Google) as seed Fittings, the long tail via the Armory. |
| 7 | **Drop `ekoa_action`** (8 step types, not 9). |
| F1 | **Vault master key = OS keychain ONLY, no passphrase.** A passphrase is a stealable/phishable surface (unacceptable if leaked); losing keychain access in a catastrophic failure is acceptable (reconnect). No passphrase anywhere. |
| F2 | Browser orchestration layer (cache→vision→execute) lives **inside the Automations Fitting** (no existing `src/lib` home; lib only if already there). Browser Fitting stays a pure service. |
| F3 | Automation files **machine-local** (`~/.garrison/automations/`). |
| F4 | Trello **derived Tasks disconnected, not rewired** — move the fitting to Connectors but don't wire `tasks:` anywhere (retiring Trello-as-tasks for our own Kanban). |

---

## 5. Work areas (with verified anchors + acceptance)

### A. Vault upgrades — the marquee (`src/lib/vault.ts`)
Current (verified): AES-256-GCM, scrypt KDF (N=16384,r=8,p=1), `data/vault.json`
0600, in-memory passphrase. Crypto is solid. **Gaps to fix:**
- **Non-atomic write** — uses `fs.writeFile` + `fs.chmod` (two syscalls). Switch to
  the existing `writeFileAtomic`/`writeJsonAtomic` from `src/lib/atomic-write.ts`
  (`{ mode: 0o600 }`). *Immediate correctness fix.*
- **Keychain-only master key** (decision F1): random master key in the OS keychain
  (macOS Keychain / libsecret / Windows Credential Manager), **no passphrase**.
  Replaces `DEV_PASSPHRASE`/scrypt-from-passphrase.
- **Per-connector secret scoping:** today `vaultEnvForEntry`
  (`src/lib/own-port-lifecycle.ts`) delivers the **entire** vault to any fitting
  that `consumes: {kind: vault}`. `secret-ref` is a placeholder (`metadata.ts:15`).
  Make it real: a fitting declares the named secrets it may read; only those
  materialize.
- **OAuth refresh-token storage + rotation:** the secret record gains type/TTL/refresh
  fields; expired tokens auto-refresh; a revoked grant flips the connector to
  "Reconnect." (None today.)
- **JIT materialization + value redaction:** secrets enter only the one process for
  the one call; auto-redact values in stdout/stderr/run-records (today `spawn.ts:190`
  redacts env *keys* only, by name pattern).
- **Access audit log:** which connector, which secret, when, outcome.
- `materializeEnv` is in `src/lib/runner.ts` (~129/160/618).
- **Advertise it everywhere** (per the wireframe Vault section): "Vault-sealed"
  badges on connector cards, connect forms, and key-using steps; a Vault surface
  with the per-connector secret map, OAuth health, audit log, rotation.

**Accept:** keychain-only unlock works with no passphrase; vault writes atomically;
a connector reads only its own secret; an OAuth token auto-refreshes; secret values
never appear in logs; the audit log records a read.

### B. Scheduler → platform-agnostic Node daemon (`fittings/seed/scheduler`)
Current (verified): `scripts/scheduler.mjs` `daemon()` ticks every 60s; jobs in
`~/.garrison/scheduler-jobs.json`; cron grammar; the only "always-on" path is an
**unbuilt** `io.garrison.scheduler` launchd agent, and it's labelled
`platforms:[claude-code]`. `lib/scheduler-beats.mjs` (in kanban-loop) is reusable.
**Build:** extract `daemon()` into a standalone always-on Node service that runs
independent of Claude Code and any one OS (systemd / Docker / PM2 / launchd
launchers — same Node code), fires whether or not the operative is up, SIGTERM-safe,
exposes `/health`. Keep the job store + cron + beats. Fold in ekoa's
listener-supervisor pattern (one worker per polling trigger) for connector listeners.
Drop the `claude-code`-only label.

**Accept:** a cron automation fires with Claude Code **not** running; `/health` ok;
existing kanban ticks + improver nightly still register and fire unchanged.

### C. Connectors faculty + `connector` kind; drop `data-source`
**Add** faculty `connectors` (multi, agent-tier) in `src/lib/types.ts:10-41`
`facultyIds`; add `connector` to `capabilityKinds:74-100`. **Drop** `data-source`
kind + its references: `metadata.ts` alias `"data-sources":"memory"` (:153),
`faculties.ts:65`, `Sidebar.tsx:268` icon, `docs/FACULTIES.md` §3.
**Move to Connectors (one Fitting each):** `trello-data-source` → `trello`
connector, `google-calendar` → connector, `deepgram-voice` → connector. **Slack
stays dual** (channel + connector for outbound). **Migrate consumers** off
`data-source`: `fittings/seed/knowledge/apm.yml:28`,
`morning-briefing/apm.yml:31`, `personal-operative/apm.yml:54` → `connector`.
**Derived Tasks (decision F4):** drop the Trello `tasks:` wiring entirely
(`src/lib/compositions.ts` derivedTasks) — disconnect, don't migrate.
Each connector Fitting declares: an action catalog (name, args, `mutates`), an auth
method (oauth2/api_key) **sealed via the Vault per A**, optional triggers
(webhook→Gateway, listener→Scheduler).

**Accept:** `data-source` is gone (typecheck + tests green); Trello/Google/Deepgram
appear under Connectors; connecting one seals its key in the Vault; an automation's
`connector` step calls a catalog action; the 3 consumers resolve via `connector`.

### D. File Browser fitting; drop the Artifact Store
**Drop** `src/lib/artifact-store.ts` + its 3 HTTP routes (`documents/list`,
`documents/[id]`, `artifact-store/list|[id]`) + the `artifact-store` capability
kind. It's a drop-safe file-organizer (verified: only those consumers). The
`documents` fitting reads its folder directly via fs.
**Build** a new own-port **File Browser** Fitting (provides `view`): a mobile-first
view surface that browses configurable roots, previews any file type (images inline;
video + PDF open-in-tab for v1), renders markdown (use `marked` ^14 — already a dep),
and **edits with Monaco by reusing the existing `src/components/FittingEditor.tsx`**
(`@monaco-editor/react` ^4.7 — already a dep) with presets incl. markdown. Tree /
editor / preview collapse to switchable tabs on phone & tablet. Browse roots:
`~/.garrison` (automations, runs, briefs, improver), `$PROJECTS_ROOT` (dev-env
parity), and the composition dir. A light index under `~/.garrison/ui-fittings/`.

**Accept:** browse roots render a tree; an image previews; a PDF/video opens in a
tab; a markdown file renders; a YAML automation edits + saves via Monaco; layout is
usable on a phone width.

### E. Automations engine Fitting (own-port; provides `automation-runner`)
**Data:** automations are YAML files at `~/.garrison/automations/<id>.yml`
(id, name, trigger {manual|cron|webhook|listener}, inputs, steps). **8 step types**
(no `ekoa_action`): `browser`, `verify`, `navigate`, `wait`, `local_command`,
`api_call`, `connector` (renamed from ekoa `integration`), `sub_automation`.
**Run viewer** (own React UI, the wireframe §08): live step list with status + tier
(`cached`/`vision`/`recovered`) + duration, type-specific output panels (terminal
for local_command, request/response for api_call, connector result, vision verdict
for verify), the **live browser stream** for browser steps, inline self-healing
notices, per-step feedback (thumbs up/down/correction). **SSE events** (port ekoa's
set): `run_step`, `run_complete`, `run_error`, `run_patch`(proposing/applied/aborted),
`run_pause_for_user`, `run_resumed`, `run_awaiting_consent`, `run_awaiting_connector`,
`step_output_chunk`, `run_streaming_available`.
**Planner via Model Router** (decision 5): the goal/brief → steps planner is a Router
**`skill`** target; per-step vision + fixer calls route through the Router too
(`src/lib/model-router.ts` `resolveRoute`; `RouterTarget` types `native-model|skill|
workflow|ollama`; note `DisciplineSettings.distribution` already supports
`automation:<id>` — automations are already a routing concept). No hardcoded model.

**Accept:** an automation YAML round-trips; a manual run executes the non-browser
steps and streams each over SSE into the run viewer; the planner produces steps via
the Router; `automation-runner` is provided; the Operative can call an automation as
a tool (MCP Gateway).

### F. Browser Fitting upgrades + the orchestration layer
**Browser Fitting** (`fittings/seed/browser-default`): keep the CDP service +
DevTools proxy + element-pick + `/viewport`/`/input`/`/cdp`. **Add** (per the audit):
post-action **observation** capture (screenshot + url + fingerprint + a11y), a
**fingerprint** endpoint, **accessibility-snapshot** extraction, opt-in
**persistent profile** (cookies/consent survive runs), opt-in **stealth** init.
**Orchestration layer** (decision F2 — **inside the Automations Fitting**, not
`src/lib`): the cache→vision→execute loop — port ekoa's
`fingerprint.ts` (page-fingerprint cache key), `executor.ts` (locator fallback
ladder), `cache.ts` (fingerprint-keyed action/assertion cache), and the tier model
(cache hit → vision resolve via Router → execute → write cache). Live stream renders
in the run viewer from the Browser Fitting's `/viewport`.
**Chuck** the thin `browser-automation` seed (subsumed).

**Accept:** a `browser` step vision-resolves an action, caches it by fingerprint, and
replays from cache on the next run; the live stream renders in the run viewer; a
persistent profile carries a cookie across runs; `browser-automation` is removed.

### G. Self-healing + human-in-the-loop
**Fixer loop** (port ekoa `rehearsal.ts`): on a recoverable step failure, an LLM
fixer (via Router) proposes one patch — `insert_before` / `replace_current` /
`skip_current` / `pause_for_user` / `abort` — applied + retried at the same index,
budget-capped (max fixer calls, max patches/step, wall-clock). Regex fast-path for
CAPTCHA/MFA/payment. **Pause-for-user:** the run pauses and shows a **drivable** live
browser canvas (Browser Fitting `/input`) the user finishes, then Continue.
**Consent:** first use of each shell command *shape* needs approval. **awaiting_connector:**
a connector step whose service isn't connected pauses with a "Connect <service>"
deep-link → resume. A failing run is shown failing — never edited to look passed.

**Accept:** a deliberately-broken step triggers a patch + retry; a CAPTCHA page
pauses for the user and resumes after Continue; a new command shape prompts consent;
an unconnected connector pauses with a connect link.

### H. Chat-to-build authoring (reuse the Discuss handoff)
Reuse the verified Kanban Discuss mechanism: `fittings/seed/kanban-loop/scripts/
discuss.mjs` (`buildDiscussUrl` → `/embed/web-channel-default?mode=james&context=
<b64>&kickoff=<b64>`; `buildDiscussKickoff`). The web-channel is a **generic relay**.
**Important (verified):** the gateway reads the mode from the leading `"James,"` in
the message text and **ignores `body.context`** — so the kickoff message must carry
the instructions inline. Brief is auto-linked when the card leaves the list (server
recomputes the same `briefRelPath`); `engine.mjs` injects the brief into downstream
prompts. **Build:** a `discuss-automation` skill (Armory Fitting) with kickoff
"What would you like to automate?"; James asks/suggests, writes a brief to
`~/.garrison/automations/briefs/<slug>.md`; back in the fitting the planner (Router)
turns the brief into steps, **rehearses** (dry-run + self-correct, visible), and
hands a reviewable automation — same live planning/rehearsal visibility as ekoa. The
plain-English goal textarea is gone; steps remain hand-editable after.

**Accept:** "Discuss an automation" opens the web-channel with the kickoff; the
conversation produces a brief; the brief drives the planner; rehearsal runs visibly;
the result lands as an editable automation.

---

## 6. Build order (one continuous build)

0. **Substrate:** Vault upgrades (A) → scheduler daemon (B). The trust backbone.
1. **Connectors** (C): faculty + kind + drop data-source + the 3 connector Fittings
   + Vault↔Connectors UI.
2. **File Browser** (D): drop artifact-store; plain-files foundation.
3. **Automations core** (E): YAML files + non-browser steps + run viewer + Router
   planner.
4. **Browser** (F): Browser Fitting upgrades + orchestration layer + browser/verify
   steps + live stream; chuck `browser-automation`.
5. **Self-heal + chat-to-build** (G, H): fixer + pause/consent + the Discuss skill.

Do not stop between these — it's one build.

## 7. Global done-criteria

- `npm run typecheck` and `npm test` green; `data-source` + `artifact-store` +
  `browser-automation` removed cleanly (no dangling refs).
- Every new Fitting has `setup` + `verify` hooks and installs into a composition.
- Each work-area's **Accept** above passes.
- **End-to-end proof:** the wireframe's example automation (open latest Google Doc →
  download PDF → email it via the Google connector → verify) plans from a Discuss
  conversation, rehearses, runs through the run viewer with the live browser stream,
  self-heals an injected failure, and completes — with the Google key sealed in the
  keychain-backed Vault and never in a log.
- Evidence per the project's walkthrough discipline (a recorded walkthrough of the
  end-to-end run + the Vault sealing story).

No code is built until this brief is turned into a plan. This document + `index.html`
are the spec.

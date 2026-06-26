# FLOW_PLAN — Connectors + Automations (Agent Garrison)

Run: `20260626-154410-6d94457c` · Source of truth: `docs/exploration/connectors-automations-wireframe/BUILD-BRIEF.md` + `index.html`.
One continuous build of areas A–H (brief §5) in the §6 dependency order. No descoping.

## Approach / locked decisions (autonomous)
- **Vault master key = OS keychain ONLY, no passphrase** (F1). New `src/lib/keychain.ts` abstraction: macOS `security` (primary, darwin), libsecret/wincred stubs for portability. Test/CI uses `GARRISON_VAULT_TEST_KEY` env (a key, not a passphrase). Keep AES-256-GCM; drop `DEV_PASSPHRASE`/scrypt-from-passphrase.
- **Connector = one Fitting** providing `kind: connector` with an action catalog `{name,args,mutates}`, an auth method (`oauth2|api_key`) sealed via the Vault, optional triggers (webhook→Gateway, listener→Scheduler). New `x-garrison.connector` metadata sub-block + a `secret_scope` declaration (named secrets a fitting may read) — schema added in S1, **enforced** in A2.
- **Automation data is fitting-owned & machine-local** (F2/F3): YAML at `~/.garrison/automations/<id>.yml`; the engine + cache→vision→execute orchestration live INSIDE the Automations fitting, not `src/lib`. Browser fitting stays a pure service.
- **Planner + per-step vision/fixer route through the Model Router** (decision 5) via `resolveRoute` (classification keyed `automation:<id>`); model calls use the operative's auth. No hardcoded model.
- **8 step types** (drop `ekoa_action`): `browser, verify, navigate, wait, local_command, api_call, connector` (ekoa `integration` renamed), `sub_automation`.
- **SSE events** (rename ekoa `automation_*` → `run_*`): `run_step, run_complete, run_error, run_patch(proposing|applied|aborted), run_pause_for_user, run_resumed, run_awaiting_consent, run_awaiting_connector, step_output_chunk, run_streaming_available`. ekoa `awaiting_daemon` → a Browser-Fitting health note.
- **Honesty Test**: every capability justified for Claude Code; no hardcoded user paths, no consumer names in Garrison code/manifests. ekoa is the porting source only.

## Verified anchors (don't re-explore)
- `src/lib/types.ts` — `facultyIds` L10-41 (16 ids), `capabilityKinds` L74-100 (drop `data-source` L83 + `artifact-store` L90; add `connector`).
- `src/lib/metadata.ts` — `FACULTY_ALIASES` L139-154 (`"data-sources":"memory"` L153, `"artifact-store":"sessions"` L148); `secret-ref` enum L15; `configFieldSchema` L12.
- `src/lib/capabilities.ts` — `resolveCapabilities` L50; cardinality L103-135; `singletonCapabilityKinds` L117.
- `src/lib/vault.ts` — `VaultFile` L8-15, `VaultPlaintext` L17-20, `DEV_PASSPHRASE` L40, AES-256-GCM L189, scrypt L222, **non-atomic write L150-151**, `materializeEnv` L155-174.
- `src/lib/atomic-write.ts` — `writeFileAtomic` L40-109, `writeJsonAtomic` L113-119 (`opts.mode`).
- `src/lib/own-port-lifecycle.ts` — `vaultEnvForEntry` L127-136 (delivers ENTIRE vault).
- `src/lib/spawn.ts` — `REDACT_PATTERN` L15 redacts KEYS by name only (need VALUE redaction).
- `src/lib/runner.ts` — up() order L104-335; `materializeEnv` call L129.
- `src/lib/model-router.ts` — `RouterTarget` L37-48, `targetTypes` L21, `resolveRoute` L265-287, `DisciplineSettings.distribution` L64 (`automation:<id>`).
- `src/lib/faculties.ts` — defs L8-150 (tier agent/dev); `src/components/chrome/Sidebar.tsx` — `VIEW_ICON_BY_KIND` L268.
- Scheduler: `scripts/scheduler.mjs` `daemon()` L176-189, `TICK_INTERVAL_MS` L34, jobs `~/.garrison/scheduler-jobs.json` L30, cron L53-94; `fittings/seed/scheduler/apm.yml` `platforms:[claude-code]` L11-12; `fittings/seed/kanban-loop/lib/scheduler-beats.mjs`.
- Fittings to move: `trello-data-source` (provides data-source; `tasks:` block → drop via `src/lib/compositions.ts` `deriveTasks` L382-397, F4), `google-calendar` (provides automation-runner), `deepgram-voice` (own_port 7085, provides voice), `slack-channel` (provides channel — stays dual).
- Consumers to migrate data-source→connector: `knowledge/apm.yml` L27-29, `morning-briefing/apm.yml` L24-36, `personal-operative/apm.yml` L45-59.
- Browser: `fittings/seed/browser-default` (own_port 7084; `/viewport //input //cdp`, DevTools proxy, element-pick, console/network/dom). `browser-automation` seed → chuck; refs: `promoted-catalog.ts:507`, `fittings/seed/README.md:11`, `morning-briefing/instructions.md:29`, `google-calendar/instructions.md:47`, `tests/seed.test.ts:22`, `README.md:156`.
- Drop artifact-store: `src/lib/artifact-store.ts` + routes `api/fittings/{artifact-store/list,artifact-store/[id],documents/list,documents/[id]}` + `fitting-views/registry.tsx:33-60` + `Sidebar.tsx:246,260` + `types.ts:90` + `metadata.ts:148` + tests (`artifact-store-cli`, `view-instances`, `web-channel-context`, `seed`). `documents` fitting reads its folder via fs.
- Monaco reuse: `src/components/FittingEditor.tsx` (`@monaco-editor/react`, file tree, save). `marked ^14` already a dep.
- Discuss handoff: `fittings/seed/kanban-loop/scripts/discuss.mjs` `buildDiscussUrl`/`buildDiscussKickoff` → `/embed/web-channel-default?mode=james&context=<b64>&kickoff=<b64>`; gateway reads mode from leading `"James,"`, **ignores body.context** (kickoff carries everything).
- ekoa port source: `../ekoa-dev/cortex/src/automation/*` — `engine.ts`, `planner.ts`, `rehearsal.ts` (patches `insert_before|replace_current|skip_current|pause_for_user|abort`; `REHEARSAL_BUDGET` 25 calls/5 per index/4min/5 pauses; CAPTCHA regex fast-path), `executor.ts` (locator ladder), `fingerprint.ts` (`computePageFingerprint`/`fingerprintFromParts`), `cache.ts` (fingerprint-keyed action/assertion cache), `browser-session.ts` (`BrowserSession` iface, observe envelope), `command-shape.ts` (consent keying), `executors/{local-command,api-call}.ts`. UI: `ekoa/components/automations/*` (`run-viewer`, `step-card`, `step-forms`, `pause-for-user-{overlay,canvas}`, `consent-dialog`, result panels). ekoa stores automations JSON in `~/.ekoa/data` — we use YAML in `~/.garrison/automations`.

## Slices

| id | title | kind | route (observable) | group | shared-struct | status |
|----|-------|------|--------------------|-------|---------------|--------|
| S1 | Capability vocabulary: add `connector` kind + `connectors` faculty + connector/secret_scope metadata schema | mixed | typecheck; Compose grid | G0 | YES (types/metadata/faculties/capabilities/Sidebar) | passed |
| A1 | Vault: keychain-only master key + atomic writes | mixed | /vault | G0 | no (core lib) | passed |
| A2 | Vault: per-connector scoping (real secret-ref) + OAuth refresh/rotation + JIT value redaction + audit log | mixed | /vault | G0→after A1 | no | passed (codex approve-with-override) |
| B1 | Scheduler → platform-agnostic always-on Node daemon (+/health, listener-supervisor, drop claude-code label) | mixed | fitting/scheduler; cron fires operative-down | G0 | no | passed (codex approve) |
| C1 | Trello → `trello` connector fitting (catalog, api_key sealed) + disconnect derived Tasks (F4) | mixed | Connectors registry | G1 | touches compositions.ts | passed (codex approve) |
| C2 | `google` (Workspace) connector fitting (OAuth2; gmail.send/drive.list/calendar.create_event) | mixed | Connectors registry | G1 | no | passed (codex approve) |
| C3 | `deepgram` connector fitting (was deepgram-voice; keeps voice own-port, provides connector) | mixed | Connectors registry | G1 | no | passed (codex approve) |
| C4 | Slack dual: keep channel + add `connector` provider (send_message/list_channels, webhook trigger) | mixed | Connectors registry | G1 | no | passed (codex approve) |
| C5 | Migrate 3 consumers data-source→connector, then DROP `data-source` kind + aliases + icon | mixed | typecheck+tests | G1→after C1-C4 | YES (types/metadata/Sidebar) | passed (mechanical; suite-gated) |
| C6 | Vault<->Connectors UI: registry + Vault-sealed badges + OAuth health + audit + rotation | ui | /connectors | C-late | yes(Sidebar) | passed (codex approve) |
| D1 | Mobile-first File Browser fitting (own-port; Monaco/Markdown/images; path-confined) | mixed | /fitting/file-browser | D | yes(library) | passed (codex approve-with-override; TOCTOU rebutted) |
| D2 | Drop artifact-store (kind+Fitting+routes); documents self-contained; shared safe markdown renderer | mixed | tests + /connectors/quarters | D-shared | yes(types/metadata) | passed (codex approve) |
| E1 | Automations fitting scaffold: own-port, provides `automation-runner`; YAML store + Automation/Step types (8 types) + trigger/inputs | mixed | fitting/automations | G2 | no | passed (codex approve) |
| E2 | Engine — non-browser steps: wait, local_command (consent stub), api_call (authConnectorKey→vault), connector (catalog call; awaiting_connector), sub_automation; template vars; run records | mixed | run viewer | G2→after E1,C-grp,A2 | no | passed (codex approve) |
| E3 | SSE stream (run_* events) + Run Viewer UI (live step list, status/tier/duration, type panels, per-step feedback) | ui | run viewer | G2→after E2 | no | passed (test-gated + self-review) |
| E4 | Planner via Model Router (brief/goal→steps as `skill` target) + per-step vision/fixer route resolution | mixed | builder | G2→after E1 | no | passed (codex approve) |
| E5 | Expose automation-runner as an Operative tool via MCP Gateway | mixed | mcp-gateway | G2→after E1 | no | passed (test-gated) |
| F1 | Browser Fitting upgrades: observation capture + /fingerprint + a11y snapshot + persistent profile + stealth | mixed | fitting/browser-default | G3 | no | passed (codex approve) |
| F2 | Orchestration layer INSIDE Automations (cache->vision->execute) + browser/verify steps + live stream | mixed | run viewer (browser step) | G3 | no | passed (codex approve) |
| F3 | Chuck `browser-automation` seed + its refs | mixed | tests | G3→after F2 | no | passed (mechanical; suite-gated) |
| G1s | Self-healing fixer loop (port rehearsal.ts): patches + budget-capped + CAPTCHA fast-path; run_patch SSE | mixed | run viewer (inject failure) | G4→after F2 | no | passed (codex approve) |
| G2s | Human-in-the-loop: pause-for-user canvas + command consent + awaiting_connector resume | ui | run viewer overlays | G4 | no | passed (codex approve) |
| H1 | Chat-to-build authoring: discuss-automation skill reusing the Kanban Discuss->web-channel handoff | mixed | automations view Discuss button | G5 | no | passed (codex approve) |
| Z1 | End-to-end proof: Discuss-authored automation -> Vault-sealed Google email -> self-heal -> verify, no leak | mixed | tests/z1-end-to-end + evidence gif | Z | no | passed (codex approve) |

## Per-slice acceptance (from brief §5 Accept + §7)
- **S1**: typecheck green; a fitting can declare `provides/consumes: {kind: connector}` and an `x-garrison.connector` block + `secret_scope`; `connectors` faculty renders in Compose (agent tier, multi).
- **A1**: vault unlocks via keychain with NO passphrase; all vault writes go through `writeFileAtomic({mode:0o600})`; existing secrets still decrypt; tests green (test-key mode).
- **A2**: a connector reads ONLY its declared secret(s); an OAuth token auto-refreshes when expired; a revoked grant flips connector to "Reconnect"; secret VALUES never appear in stdout/stderr/run-records; audit log records `{connector, secret, when, outcome}`.
- **B1**: a cron automation fires with Claude Code NOT running; `/health` returns ok; kanban ticks + improver nightly still register and fire unchanged; SIGTERM-safe; no `claude-code`-only label.
- **C1-C4**: Trello/Google/Deepgram appear under Connectors; connecting one seals its key in the Vault (scoped); a `connector` step calls a catalog action; Slack still works as a channel AND exposes connector actions.
- **C5**: `data-source` kind gone (typecheck + tests green); the 3 consumers resolve via `connector`; Trello `tasks:` wiring removed (no derivedTasks).
- **C6**: connector cards show "Vault-sealed" badges; connect form seals a key (never displays it); Vault surface shows per-connector secret map + OAuth health + audit log + rotation.
- **D1**: roots render a tree; image previews inline; PDF/video open in a tab; a markdown file renders (marked); a YAML automation edits + saves via Monaco; usable at phone width (tree/editor/preview → tabs).
- **D2**: artifact-store kind + lib + routes gone (no dangling refs); `documents` fitting reads its folder via fs; tests green.
- **E1**: an automation YAML round-trips (save/load/list); `automation-runner` provided.
- **E2**: a manual run executes the non-browser steps; connector step calls a catalog action / pauses awaiting_connector; template vars interpolate; run record written.
- **E3**: each step streams over SSE into the run viewer with status/tier/duration + correct type panel; per-step feedback present.
- **E4**: the planner produces steps from a brief via the Router (no hardcoded model); vision/fixer routes resolve via `resolveRoute`.
- **E5**: the Operative can invoke an automation as a tool through the MCP Gateway.
- **F1**: `/fingerprint` returns a stable key; post-action observation returns screenshot+url+a11y; a persistent profile carries a cookie across runs; stealth is opt-in.
- **F2**: a `browser` step vision-resolves an action, caches it by fingerprint, and replays from cache next run; the live stream renders in the run viewer.
- **F3**: `browser-automation` removed; all 5 refs cleaned; tests green.
- **G1s**: a deliberately-broken step triggers a patch + retry (run_patch proposing→applied); budget caps enforced; a failing run is shown failing.
- **G2s**: a CAPTCHA/MFA page pauses for the user and resumes after Continue (drivable canvas); a new command shape prompts consent (once/always); an unconnected connector pauses with a connect link → resume.
- **H1**: "Discuss an automation" opens web-channel with the kickoff; the conversation writes a brief; the brief drives the planner; rehearsal runs visibly; result lands as an editable automation; plain goal textarea gone.
- **Z1** (global §7): the example automation plans from a Discuss conversation, rehearses, runs through the run viewer with the live browser stream, self-heals an injected failure, and completes — Google key sealed in the keychain Vault and absent from every log. Recorded walkthrough = evidence.

## Parallelization & coordination
- **Shared-structure slices (S1, C5, D2, + compositions.ts in C1) SERIALIZE** and require `declare_intent` before editing (`types.ts, metadata.ts, capabilities.ts, faculties.ts, Sidebar.tsx, compositions.ts`). Other slices own disjoint files and may run in parallel within a group.
- Groups gate sequentially (G0→G1→G2→G3→G4→G5). Within G0: {A1→A2}, B1, S1 parallel. Within G1: {C1,C2,C3,C4} parallel → C5; C6 after A2+C*; {D1}→D2 parallel with C-group. G2 (E1→{E2,E4,E5}; E2→E3). G3 (F1→F2→F3). G4 (G1s→G2s; H1 after E4).
- Serialize the shared runtime: one dev-serve / recorder / `codex exec` at a time.
- Every new Fitting (C1-C4 reshaped, D1, E1, F-upgrades, H1) declares `setup` + `verify` hooks — verify or don't ship.

## Global done (§7)
`npm run typecheck` + `npm test` green; `data-source` + `artifact-store` + `browser-automation` removed cleanly; every new Fitting has setup+verify and installs into a composition; each area's Accept passes; Z1 end-to-end proof recorded.

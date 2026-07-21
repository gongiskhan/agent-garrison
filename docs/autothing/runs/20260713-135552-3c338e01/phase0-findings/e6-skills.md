I'll investigate both findings thoroughly. Let me start by mapping the relevant directories in parallel.
Good map. Now let me examine the key fittings and skills in detail.
The gary/joe/james personas live in the `modes` fitting. Let me read the persona and bundle content in a batch.
Now the shared voice, the base soul, the soul-* persona fittings, and the E6b separate-fitting bundles.
Now the remaining soul personas and the E13 ownership/state files.
Now state-transitions, the quarters index, quarters-runtimes, and the image/video search.
Now the Quarters detail, categories, mode-state readers, and the image/video search.
Let me pin down the image/video specifics, the Quarters UI categories, and how mode state is read at runtime.
Let me confirm the model-router image handling, the Quarters index labeling, and the walkthrough video machinery.
I have comprehensive evidence for both findings. Compiling the report now.

---

## FINDING-E6 — Skill inventory (raw material for per-duty Fittings + Identity fitting)

### (a) The `garrison-*` skill family in `~/.claude/skills/` (15 dirs)

All are the build-discipline pipeline, one skill per phase verb. Roles (from each `SKILL.md` frontmatter):

| Skill dir | One-line role |
|---|---|
| `garrison` (parent, not `garrison-*`) | Thin doorway into the Orchestrator: registers a run as a Kanban card and drives the gated phase pipeline. |
| `garrison-plan` | Autonomous plan-mode: read-only Explore+Plan subagents write a durable FLOW_PLAN file. |
| `garrison-implement` | Code-writing step; the target gates send work back here to fix forward. |
| `garrison-test` | Committed re-runnable correctness test + clean build/typecheck/lint (the objective gate). |
| `garrison-adversarial-review` | Fresh-context decorrelated code review against acceptance criteria only. |
| `garrison-adversarial-test` | Fresh-context independent functional test (writes its own Playwright probes). |
| `garrison-review` | Same-context Claude code review (standalone reporting). |
| `garrison-security-review` | Opt-in per-slice security checklist (authz/injection/secrets/tenant). |
| `garrison-ux-qa` | UX/interface-quality gate — walks the running UI against a fixed 6-section rubric, desktop+mobile screenshots, mechanical contrast/tap-target checks (`~/.claude/skills/garrison-ux-qa/SKILL.md:1-18`). |
| `garrison-walkthrough` | Records self-verified video evidence; delegates to the `walkthrough` skill. |
| `garrison-validate` | Reads gate-status.json, checks every DoD gate, writes durable `validated` record, ends Done\|Implement. |
| `garrison-codex-checkpoint` | Run-level cross-model OpenAI Codex security checkpoint via the codex-runtime bridge. |
| `garrison-report` | Slack notification when a run finishes (walkthrough gallery + log links). |
| `garrison-parallel-work` | Decides how to split multi-agent work (teams vs workflows vs sequential). |
| `garrison-project-foundation` | Idempotent audit/scaffold of a repo's Claude-Code foundation (CLAUDE.md, /docs, area skills). |
| `garrison-browser` | Inspects the browser tab in the Garrison Browser Fitting (screenshots/console/network/DOM). |

### (b) What `garrison-skills` bundles vs. what separate fittings own

**`fittings/seed/garrison-skills/apm.yml`** (faculty `building`, `component_shape: skill`, `cardinality_hint: single`) bundles the **entire build-discipline family as one fitting** — `apm.yml:13-24` lists: the `garrison` doorway plus every phase verb (plan, implement, test, adversarial-review, adversarial-test, security-review, ux-qa, walkthrough, validate, codex-checkpoint, report). The skills live under `.apm/skills/garrison*/SKILL.md` (confirmed on disk: `garrison`, `garrison-implement`, `garrison-project-foundation`, `garrison-walkthrough`, `garrison-parallel-work`, `garrison-report`, `garrison-validate`, etc.). The **goal-loop hooks** (`garrison-goal-stop` / `-sessionstart` / install / probe) ship inside the `garrison` skill dir and are wired into settings.json by the installer (`apm.yml:18-21`). Post-import the doorway reads the compiled policy at `~/.garrison/orchestrator/policy.json` — verb skills carry no `model:` frontmatter (policy is the single routing authority).

**Separate fittings that own their own skill (NOT in garrison-skills):**

- **`fittings/seed/testing/apm.yml`** (name `garrison-testing`, faculty `skills`→aliases to `sessions`, `component_shape: script`, `cardinality_hint: multi`). This is a **runtime test-runner tool, not the build-gate `garrison-test` skill** — provides `agent-skill: testing`, invoked via the `run_tests` MCP tool on `mcp-gateway`, auto-detects npm/pytest/cargo/go (`apm.yml:14-28`). Distinct concern from the pipeline gate.
- **`fittings/seed/discuss-automation/apm.yml`** (faculty `building`, `component_shape: skill`, multi). The "Discuss an automation" chat-to-build skill: opens a **James** conversation, writes an automation brief to `~/.garrison/automations/briefs/<slug>.md`, drives the Router-routed planner (`apm.yml:13`, `for_consumers` 27-35). `provides: []`; consumes `automation-runner` optional-one.
- **`fittings/seed/coding-subagent/apm.yml`** (faculty `skills`, `component_shape: skill`, multi). Plan-then-execute coding sub-agent against `~/Projects/`; provides `agent-skill: coding-subagent`, consumes `agent-skill: projects-index` + `project-documents` (both cardinality `one`). Config: `subagent_model` (opus), `permission_mode`, plan/execute turn caps (`apm.yml:58-88`). This is the older conversational-session coding path, parallel to (and predating) the garrison build pipeline.

So: **walkthrough machinery is NOT its own seed fitting** — the `garrison-walkthrough` phase skill (inside garrison-skills) delegates to the standalone **`~/.claude/skills/walkthrough/`** skill (not a fitting). Testing is split two ways: pipeline gate (`garrison-test`, in garrison-skills) vs. runtime tool (`testing` fitting). Discuss-automation and coding-subagent are each their own fitting.

### (c) The SOUL prompts — two distinct persona families

The task's "gary/james/joe" personas do **not** live in `soul-*` fittings — they live in the **`modes`** fitting. There are two separate persona sets:

**Set 1 — `fittings/seed/modes/` (the real personal-operative faces, gary/joe/james):**
- `souls/gary.md` — **personal assistant, the base face** ("operative at rest"). Knows Goncalo, family, work; day/tasks/calendar/reminders. Conversational prose. Hands technical work to Joe, product/design to James. Faculties: memory + channels; runtime OFF; routing bias `standard-toward-fast`.
- `souls/joe.md` — **dev face**. Does NOT reason about code in-prompt; dispatches implementation to a native Claude Code session (Dev Env), watches, reports back in shared voice ("never a wall of diff"). Faculties: runtimes + memory (+ knowledge/codegraph/vault); routing bias `expert`.
- `souls/james.md` — **product/architect face**. Thinks through features/tradeoffs in prose, writes at most one brief per turn to disk under `briefs_path` using the brief template, hands it to Joe as a 1-2 sentence summary. Faculties: memory (+ knowledge/authoring); runtime OFF; routing bias `expert-then-standard`.
- `voice/shared-voice.md` — **shared register for all three**: conversational prose tuned for text-to-speech; no bullets/headers/tables in conversation; never open with flattery; match length to question; **no em dashes**; warm/direct/willing-to-disagree. Souls add stance on top, never restate/contradict it (`shared-voice.md:11`).
- `modes.json` — the routing/switching config: `defaultMode: gary`; per-mode `faculties`/`runtime`/`routingBias`; `channelDefaults` (dev-env→joe, slack→gary, web→gary); `switching: byNameAtStart + sticky + autoInfer:"shy"`; `routingBias` tiers (`standard-toward-fast`→floor fast, `expert`→floor expert, `expert-then-standard`→floor standard/prefer expert).

**Set 2 — the `soul-*` seed fittings (older per-role persona library, distinct from modes):**
- `soul` (base) — persona **"Verity"** (identity override: "Not Claude… I am Verity"), wears 3 hats PM/Architect/PA (`soul/.apm/prompts/soul.prompt.md:5-46`). Tone: direct, honest-under-pressure, no over-apology, ask-before-guessing, refuse-the-wrong-frame.
- `soul-engineer` — coding specialist; surgical edits, run tests/typecheck/lint, terse senior-engineer register.
- `soul-architect` — design-doc author (no code); document-driven workflow, "Locked:" decisions in `docs/garrison-architect/`.
- `soul-assistant` — personal/family logistics; reads `context.md` each session; warm-but-efficient, no web/code.
- `soul-companion` — quick conversational Q&A; friendly/brief, web search, ephemeral by default.
- `soul-researcher` — multi-source research notes; primary sources, calibrated uncertainty, produces `<topic>.md`.

Register bias config (mode-bias) is machine-readable in `modes.json.routingBias` + per-mode `routingBias` keys; the `soul-*` fittings carry no routing config (they predate the modes model). **Runtime composition of modes into the orchestrator prompt** is in `src/lib/souls.ts` — `assembleSouls()` reads `modes.json` + souls + shared voice, composes one prompt per mode into `<composition>/.garrison/souls/<mode>.md`, derives per-mode compute tier from routing bias, and emits `MODE_DELEGATION_INSTRUCTION` (`souls.ts:97-121`) telling the orchestrator to `talk_to(soul=<name>)`.

### (d) IMAGE vs VIDEO production today

**VIDEO — exists, screen-recording (non-generative):**
- `~/.claude/skills/walkthrough/` — the recorder: `scripts/record.mjs` consumes a declarative `storyboard.json`, records browser + evidence segments, normalizes/stitches ONE streamable MP4 via ffmpeg, emits a measured caption-timestamp manifest (`record.mjs:1-30`). Plus `extract_frames.mjs` (self-verify via vision), `review_video.mjs`, `gallery.html`, `serve.mjs` (Tailscale publish), `preflight.sh`. Wrapped by the `garrison-walkthrough` phase skill.
- `fittings/seed/screen-share-default/` — own-port live screen surface (port 7079).
- Router vocabulary: `model-router.ts:13` has a `"video"` taskType; heuristic maps "video/walkthrough/recording" to it (`model-router.ts:310`).

**IMAGE — no generation path in the Garrison product.** Evidence:
- The only `image`/`higgsfield` references in `src/`/`fittings/`/`packages/` are (1) the `design-taste-frontend` SKILL under `fittings/seed/taste/` and `fittings/local/taste-copy/` (a frontend-design skill that *references* Higgsfield, not a Garrison capability), and (2) `model-router.ts:12,309` which only *classifies* an `"image"` taskType (regex "image/photo/picture/render/illustration") — there is **no image-generation backend, fitting, or capability kind wired to it**. Image generation exists only as external MCP tooling available to a composition (the `Higgsfield` MCP `generate_image`/`generate_video`, and the personal `~`/`scroll-world` skills), never as a Garrison-owned Faculty/capability. So converting an "image production" duty into a Fitting would be greenfield; "video production" already has real machinery (the walkthrough recorder) to mine.

---

## FINDING-E13 — Quarters per-runtime descriptors + ownership tags

### (a) Claude-Code-specific descriptors NOT labeled as such (runtime-scoped honesty gap)

The canonical Quarters category list is **`src/components/quarters/quartersTypes.ts`**. Its own header comment admits the gap: *"Each mirrors a Claude Code artifact type by name"* (`quartersTypes.ts:5`). The 11 `QUARTERS_CATEGORIES` (`quartersTypes.ts:27-121`) are all Claude-Code artifacts but presented as generic "Quarters" categories with **no runtime label**:
- `skills` ("compiled into `~/.claude/skills` by APM"), `hooks` ("settings.json hook groups"), `mcps` ("`~/.claude.json`"), `plugins` ("Claude Code's plugin manager `installed_plugins.json`"), `scripts` (commands+rules "into `~/.claude`"), `plans` ("`~/.claude/plans`"), `sessions`, `logs`, `agentsdk` ("Agent SDK runtime… THE HARNESS state"), plus `settings`/`context`. Several blurbs *do* name Claude Code inline, but the category set itself is not framed as "this is the Claude Code runtime's surface."

The honesty gap is architected explicitly in **`src/lib/quarters-runtimes.ts`**: `claude-code` is the only **`tier: "deep"`** descriptor, hard-registered as `DEEP_QUARTERS_REGISTRY = { "claude-code": { routeBase: "/quarters" } }` (`quarters-runtimes.ts:28-30`) — i.e. the entire classic top-level `/quarters/<category>` surface *is* the claude-code deep implementation, rendered as-is and never from a descriptor. Every OTHER runtime gets the **`tier: "generic"`** descriptor-driven surface with a reduced category set — the route `src/app/quarters/[type]/[sub]/page.tsx:26` defaults generic runtimes to only `["settings", "context", "mcps", "logs"]`. So Skills/Hooks/Plugins/Scripts/Plans/Sessions/AgentSDK are Claude-Code-only categories sitting at the *unlabeled* default route, while the multi-runtime scoping only appears when >1 runtime is composed. `QuartersIndex.tsx:97-101` confirms the UI treats "exactly one configurable runtime (the common case: claude-code)" as the expanded default with "the current look preserved."

The `agentsdk` category (`quartersTypes.ts:113-120`, panel `AgentSDKPanel.tsx`) is the most Claude/Anthropic-specific ("provider/capability records, auth modes… routable to Anthropic + third-party endpoints") and is unlabeled as runtime-scoped.

### (b) OWNERSHIP-TAG mechanics — how a Fitting owns a skill, per surface

The classifier is **`src/lib/primitive-state.ts` → `computeStateModel()`**. Ownership is surface-dependent because the APM lock only tracks *files* (`primitive-state.ts:22-27`):

- **File surfaces (skill / command / rule)** — owned iff the file's `~/.claude`-relative path is in the global `apm.lock.yaml` `deployed_files` set (`primitive-state.ts:80-104`, `owned = lock.allDeployedFiles.has(f.relPath)`). The owning fitting = the lock dep whose `deployedFiles` includes that path (`ownerDep?.name` → `fittingId`). Drift is detected by comparing on-disk hash vs the lock's `deployedHashes[relPath]` (`driftedFromLock`, lines 89-94). `managedBy: "apm"`. **This is the exact mechanism a per-duty Fitting uses to own its skill: ship the skill under `.apm/skills/<name>/`, add the fitting as an apm dep, `apm install` writes it through and the lock records the deployed path → the skill is now `owned` by that fitting.**
- **Hooks** (live in settings.json, not in the lock) — owned via the **`_garrison` ownership tag** on the hook group: `const marker = group?._garrison; state = marker !== undefined ? "owned" : "loose"` (`primitive-state.ts:127-133`); the tag's string value is the owner fitting id (`hookOwner`, lines 119-120). `managedBy: "presence"`.
- **MCP** — no APM ownership model yet; all MCP records are `loose` (`primitive-state.ts:26-27,161-167`) pending the provenance ledger (SP1). `managedBy: "presence"`, active∪parked union.
- **Plugins** — always `loose`; enabled/disabled read from `enabledPlugins[key] === false` (`primitive-state.ts:170-186`).

**State transitions** (`src/lib/state-transitions.ts`): `promote` (loose→owned) packages the loose primitive into a captured fitting via `emitFitting`, appends it as an apm dep, `apm install` (which claims the on-disk file into the lock), then snapshots the provenance ledger (`state-transitions.ts:44-78`). `park` (owned→parked) drops the dep + reinstalls, computes orphans as this dep's files no *other* dep deploys, copies the captured fitting to `~/.garrison/parked/<id>`, deletes the orphaned disk files itself, and calls `forgetEntry` (`state-transitions.ts:83-120`). `unpark` restores to owned (re-add dep + install) or loose (deploy files to disk without an apm dep) (`state-transitions.ts:123-156`). Collision guard refuses promote if a different owned dep already deploys to that path (`state-transitions.ts:52-55`).

**Provenance history when a skill MOVES between fittings** — the ledger `src/lib/provenance.ts` (`~/.garrison/global-composition/garrison-provenance.json`) carries only the residue the lock can't express: non-file ownership (hooks/MCP) + the per-primitive `lastWrittenHash` powering HASH-COMPARE echo suppression (`provenance.ts:5-17`). It is keyed by surface-qualified primitive id, **not by fitting** — `recordWritten(id, hash, { fittingId })` overwrites the entry's `fittingId` on each write (`provenance.ts:46-54`), and `park` calls `forgetEntry(id)` deleting it entirely (`state-transitions.ts:116`). So there is **no preserved provenance chain across a fitting-to-fitting move**: the ledger records only the *current* owner and last-written hash; the previous owner is dropped. The durable "who owned this before" history is effectively the git history of the lock/manifests, not a runtime ledger. This is a real gap if a per-duty refactor needs to preserve which fitting a skill migrated from.

---

## The `modes` fitting — full report

**`fittings/seed/modes/`** — faculty `modes`, `component_shape: system-prompt`, `cardinality_hint: single`, `type: prompts`. Provides `kind: modes` (a singleton capability kind); consumes `mcp-gateway` optional-one. Config schema: `briefs_path` (default `./briefs/`) and `default_mode` select gary/joe/james (`apm.yml:14-33`).

**Bias / pin / sticky-switching / CRUD surface:**
- **Bias** — per-mode `routingBias` in `modes.json:41-45` (three named tiers). Compiled to a nominal compute tier at composition time via routing-core's `biasRole`/`modeBiasFor` (dynamic-imported in `souls.ts:191-208` → `tierByMode`), surfaced to the orchestrator so each soul spawns at its tier (`composeOrchestratorPrompt`, `souls.ts:111-121`).
- **Pin / channel default** — `modes.json.channelDefaults` (dev-env→joe, slack→gary, web→gary, default→gary) applied only at session start when no name and no sticky mode (`mode-resolver.mjs:56-60`).
- **Sticky switching** — `switching.byNameAtStart:true, sticky:true, autoInfer:"shy"`. `parseLeadingMode` matches a mode name at the very start of a message (after an optional greeting, terminated by punctuation/whitespace so "Gary's"/"Garyfication" don't match) → explicit sticky switch; no name keeps the current mode; auto-inference is deliberately NOT performed mid-session (`http-gateway/scripts/lib/mode-resolver.mjs:16-61`). Switch events append to `.garrison/switch-log.jsonl` (`buildSwitchEntry`/`appendSwitchLog`, lines 66-82).
- **CRUD surface** — modes are **file-authored, not a live CRUD UI**: souls are markdown under `souls/`, config is `modes.json`, shared voice is `voice/shared-voice.md`. `scripts/setup.mjs`/`verify.mjs` install/validate; there is no Quarters/API editor for modes (they compose into the prompt at `up`).

**Every place mode state is read:**
1. `src/lib/souls.ts` — `assembleSouls()` reads `modes.json` + souls + shared voice, composes per-mode prompts, emits `GARRISON_SOULS_CONFIG` (`souls.ts:136-240`); `findModesEntry` detects the `modes`-providing fitting (`souls.ts:56-60`).
2. `src/lib/runner.ts` — invokes souls assembly during `up`, gates on `mcpGatewayPresent` (referenced via the modes.json/soulRef grep hit).
3. `src/lib/orchestrator-placement.ts` — reads mode routing for orchestrator placement/spawn tier.
4. `fittings/seed/http-gateway/scripts/gateway.mjs` + `scripts/lib/mode-resolver.mjs` — the runtime turn-by-turn mode resolution (name/sticky/channel-default) and switch-log append.
5. `fittings/seed/orchestrator/lib/policy-core.mjs`, `routing-core.mjs`, `routing-core.d.mts` — `modeBiasFor`/`biasRole` map a mode's routing bias to a compute tier.
6. `fittings/seed/modes/scripts/verify.mjs` — validates modes.json structure at verify.

Key files (all absolute): `/home/ggomes/dev/garrison/src/lib/souls.ts`, `/home/ggomes/dev/garrison/src/lib/primitive-state.ts`, `/home/ggomes/dev/garrison/src/lib/state-transitions.ts`, `/home/ggomes/dev/garrison/src/lib/provenance.ts`, `/home/ggomes/dev/garrison/src/lib/quarters-runtimes.ts`, `/home/ggomes/dev/garrison/src/components/quarters/quartersTypes.ts`, `/home/ggomes/dev/garrison/fittings/seed/modes/{apm.yml,modes.json,souls/*.md,voice/shared-voice.md}`, `/home/ggomes/dev/garrison/fittings/seed/{garrison-skills,testing,discuss-automation,coding-subagent}/apm.yml`, `/home/ggomes/dev/garrison/fittings/seed/soul*/`, `/home/ggomes/.claude/skills/walkthrough/scripts/record.mjs`.

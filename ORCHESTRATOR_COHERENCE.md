# Orchestrator Coherence, Flow Library, and Improver v2

Running decision log for the 2026-08-09 run. Every non-obvious decision, every
discovered surprise, every deferral lands here with a reason.

Run id: `20260809-orchcoherence-44eb07bd` · branch `main` · host dev-madrid.

---

## Run meta

| | |
|---|---|
| Execution | Plain autonomous run following the brief's own Phase 0-6 structure. **Not** an autothing slice run. |
| Why | The brief states "Do not use autothing to build this." The operator invoked `/autothing` because `/goal` rejected the 24k-char brief (4000-char limit). Confirmed with the operator before starting: borrow autothing's Phase 0 loop-arming only (run sentinel + `Stop` hook), skip the slice pipeline, per-slice walkthrough videos, codex checkpoint and adversarial-review gates. Verification is the brief's own Phase 6 ledger + vision judge. |
| Loop | `~/.autothing/sentinels/44eb07bd-*.json`, turn cap 600. Releases on the terminal `GLOBAL GATE:` line naming this run id. |
| Resume state | `docs/orchestrator-coherence/status.json` + this file. |
| Coordination | coord-mcp planning lock GRANTED 10:58Z (recovered a stale lock); intent declared over the routing/kanban/channel/composition surface. One unrelated stale intent from 2026-08-06 on `cortex-automations` files - no overlap. |

---

## Phase 0 - audit and grounding

**Status: in progress.**

### 0.0 Prior art that constrains this run

- **Commit `e34b1246` "feat(kanban+chat): duty and work kind become one 'kind of work' question"** (2026-08-07) already merged the two *pickers*. The coord read-bundle records its intent as: *"work kinds = phased plans, duties = single-turn lanes"*. That is the live mental model and this run must build on it, not re-litigate it.
- `EXPLORATION_REPORT_router_improver.md` (repo root, 847 lines) is a prior audit of exactly this surface, but it is **stale** - it was committed at `1fdd49f4` and still describes 12 capability kinds where `src/lib/types.ts` now has 16. Treated as orientation only; every fact below was re-derived from live code.

### 0.1 Inventory - duties

**Duties are `taskTypes` in the routing policy.** The name `duty` is already the
internal vocabulary everywhere that matters - each matrix cell's `rule` field
literally reads `duty:<id>/L<n>` - but the persisted key is still `taskTypes`.
That is the first naming incoherence: the concept is called one thing and stored
as another.

Defined in: `compositions/<id>/.garrison/policy.json` -> `taskTypes` (a flat
string array). **19 today:**

```
code  other  research  plan  implement  review  test  image  video  writing
ops   adversarial-review  adversarial-test  ux-qa  walkthrough  validate
codex-checkpoint  report  probe-question
```

They are not one set. They split cleanly in two, and nothing in the schema says so:

| group | members | used as |
|---|---|---|
| **Phase duties** (steps inside a flow) | `plan implement review adversarial-review test adversarial-test ux-qa walkthrough validate codex-checkpoint report` | listed in `phasePlans[].phases` |
| **Lane duties** (single-turn routing targets) | `code other research image video writing ops probe-question` | chosen per turn by the router |

**Levels** are `tiers`: `T0-trivial`, `T1-standard`, `T2-deep` (the brief's L1/L2/L3),
each with prose in `tierDefinitions`.

**The binding** is `matrix[duty][tier] -> { runtime, model, effort, provider, targetId, type, rule }`.
Example cell:

```json
"adversarial-review": {
  "T1-standard": { "effort":"xhigh", "model":"gpt-5.6-sol", "provider":"anthropic",
                   "rule":"duty:adversarial-review/L2", "runtime":"codex",
                   "targetId":"sol", "type":"secondary" }
}
```

So a duty level does already bind runtime + model + effort, exactly as the brief
describes. That part of the model is sound.

#### Duplicates found

- **`code` vs `implement`** - the pair the brief calls out. `implement` is the
  phase duty (appears in every `phasePlan`); `code` is the lane duty (a single-turn
  coding request). They are the same work at different ceremony levels, and the
  brief's test applies: the same prompt in the same situation could select either.
  **Resolution deferred to Phase 1** pending the reference count.
- `review` vs `adversarial-review` and `test` vs `adversarial-test` are **not**
  duplicates - the adversarial variants are decorrelated second passes with their
  own matrix cells, and both can legitimately run in one flow.
- `security-review` appears in the `phases` enum but **has no `taskTypes` entry and
  no matrix row**. It is a phase that can be named in a plan but cannot be routed.
  Live defect, not a naming problem.

### 0.2 Inventory - work kinds (the flows)

Defined in the same `policy.json` -> `workKinds`, keyed by id, each with a
`description` and exactly one `phasePlan` (plus an optional `evidence: false`).

**9 today, and the set is visibly rotted:**

| workKind | phasePlan | note |
|---|---|---|
| `full-feature` | `full` | |
| `full-feature-copy` | `full-copy` | **byte-identical clone of `full`** |
| `full-feature-copy-2` | `full-copy-2` | **byte-identical clone of `full`** |
| `ui-change` | `ui-change` | |
| `api-change` | `implement-test` | |
| `docs-change` | `implement-only-text` | |
| `video-edit` | `implement-only-logs` | |
| `personal` | `manual-only` | no agent phases |
| `channel` | `manual-only` | split from `personal` so reporting can diverge |

`defaultWorkKind: "full-feature"`. The three `full*` plans are identical arrays -
`["plan","implement","review","adversarial-review","test","adversarial-test","ux-qa","walkthrough","validate","codex-checkpoint","report"]` -
so two of the nine flows are pure duplication created by a UI duplicate action and
never cleaned up.

#### The finding that reshapes Phase 1

**Flows have no levels today.** A `workKind` maps to exactly ONE `phasePlan`. There
is no `workKind.levels`, no per-level duty list, and no place to pin a duty to a
different level at a given flow level.

The brief's section 2.3 - "flows keep their levels too", flow level as the single
dial, pinned per-duty overrides, escalation on top - is therefore **new
construction, not a refactor**. The only level dial that exists today is the duty
tier, which is chosen per turn by the classifier. This materially changes Phase 1's
shape and is the single biggest scope discovery of the audit.

### 0.3 Inventory - the router

Lives in the http-gateway fitting: `fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs`
(3174 lines), driven from `gateway-pty.mjs`. `preRoute: "on"` in policy.

- `preRoute(message, opts)` is the entry point. It dispatches to **`preRouteV4`**
  (schema v4, the live lane, which speaks `duty` / `level`) or falls through to the
  **legacy `taskType` x `tier` matrix** path for older callers.
- The classifier returns `{ taskType, tier }` - i.e. duty + level - and the matrix
  turns that into a concrete target.
- Deterministic bypasses exist and are honoured before any model call:
  `classifyByKeywords` + the 12 `exceptions` entries (`when` prose -> `targetId`),
  explicit caller pins, already-routed cards, schedules/internal jobs.
- Ambiguous human requests fall to the composition's `dispatch` duty target
  (default: a bounded tool-free one-turn Agent SDK call to Haiku 4.5), with a
  deterministic fallback that records degraded reason, latency and fallback count.
- **Schema-v4 traffic may never fall back to the retired task-type/tier classifier**
  (explicit guard at line ~3095).

Comment at the head of the file confirms the intended split: the classifier is pure
and unit-testable, and *"the gateway logs the decision to decisions.jsonl AT
RESOLUTION TIME"*.

### 0.4 Inventory - decisions log

`<composition>/.garrison/decisions.jsonl`, one JSON object per line.

- Constant + reader: `src/lib/decisions-feed.ts` (`DECISIONS_REL`).
- Normalised for the UI by `src/app/api/orchestrator/decisions/route.ts` to
  `{at, kind, duty, ...}`.
- Surfaced by `src/components/muster/DecisionsPanel.tsx`.
- Written at resolution time by the gateway (`gateway-pty.mjs:627` passes
  `decisionsFile`), and independently appended by every secondary runtime bridge
  (`codex`, `cursor`, `gemini`, `opencode`, `openrouter`, `openai-agents`) plus
  `orchestrator/provider-skills/provider-common.mjs` (honouring
  `GARRISON_DECISIONS_LOG`).
- Verdicts: `src/lib/decision-verdicts.ts` + `decision-verdicts-store.ts`.

**Override path: to be confirmed** (brief item 7).

### 0.5 Inventory - the improver

**Not dead code.** `fittings/seed/improver/` is live and heavily tested - roughly
20 test files reference it (`improver.test.ts`, `improver-apply.test.ts`,
`improver-policy-rule.test.ts`, `improver-probe.test.ts`,
`improver-reject-reapply-failed.test.ts`, `improver-reapply-sweep-conflict.test.ts`,
`improver-skill-telemetry.test.ts`, `improver-ecosystem-*.test.ts`, ...).

Modules that already understand the taxonomy: `lib/feedback-rule.mjs`,
`lib/probe-core.mjs`, `lib/orchestrator-policy-rule.mjs`.

The brief's charge is that it "shows no evidence of working" - the audit so far
suggests the machinery exists and the **surfacing** is what is missing, which
matches the brief's own Phase 4 framing ("its feedback lives in a view nobody
visits"). To be confirmed against where its questions actually render.

### 0.6 Inventory - configuration surfaces

| surface | file | configures |
|---|---|---|
| Muster -> Orchestrator tab | `src/components/muster/PolicyPanel.tsx` (21 `workKind` refs) | duties, tiers, matrix, workKinds |
| Muster -> Decisions | `src/components/muster/DecisionsPanel.tsx` | decision feed |
| policy core (shell) | `src/lib/orchestrator-policy.ts` | policy read/write |
| policy core (fitting) | `fittings/seed/orchestrator/lib/policy-core.mjs` | same model, second implementation |
| board + run engine | `fittings/seed/kanban-loop/{lib/engine.mjs,lib/board.mjs,lib/policy.mjs,scripts/server.mjs,ui/main.tsx}` | per-card flow/duty selection |
| gateway | `fittings/seed/http-gateway/scripts/{gateway-pty.mjs,lib/gateway-routing.mjs}` | runtime routing |
| web channel | `fittings/seed/web-channel-default/{scripts/server.mjs,scripts/threads.mjs,ui/main.tsx}` | per-turn pins |
| simulate | `src/app/api/orchestrator/simulate/route.ts` | dry-run routing |

`workKind` appears in **432 places repo-wide** (including tests and historical
`docs/autothing/runs/**` artifacts, which must NOT be renamed - they are immutable
run records).

### 0.7 Inventory - Kanban lists

Live board (`~/.garrison/kanban-loop/board.json`, schema v5), 22 lists. The
list -> duty mapping is **explicit config**: every list carries `kind` and, for
agent lists, `phase` (which today always equals the list id). Read by
`fittings/seed/kanban-loop/lib/board.mjs`. A v2->v3 migration already stripped
dead per-list `skill`/`taskType`/`tier`/`mode` pins, so the list is a *duty*
pointer and nothing more - which is exactly what the brief's `duty:` prefix wants
to make visible.

| non-duty lists (6) | duty-backed lists (16) |
|---|---|
| `scheduled` (system), `backlog`, `todo`, `done`, `needs-attention`, `archived` | `discuss`*, `code`, `other`, `research`, `plan`, `implement`, `review`, `drill`, `test`, `image`, `video`, `writing`, `ops`, `adversarial-review`, `ux-qa`, `probe-question` |

\* `discuss` is `kind: agent-interactive`; the rest are `kind: agent`.

#### Three-way drift (measured)

19 duties, 12 phases, 16 agent lists - and the three sets do not agree:

| | members |
|---|---|
| on the board but **not a duty** | `discuss`, `drill` |
| a duty but **no board list** | `adversarial-test`, `codex-checkpoint`, `report`, `validate`, `walkthrough` |
| a phase but **not a duty** | `security-review` |

`discuss` and `drill` additionally have **no `matrix` row**, so neither has a
declared runtime/model/effort at any level. The Discuss duty runs constantly in
practice (5 cards in the corpus) on an undeclared route.

Cosmetic: `ux-qa` renders as **"Ux Qa"** - naive title-casing of the id. Should be
"UX QA".

### 0.8 Channel parity inventory

Channels: `web-channel-default`, `omi-channel`, `slack-channel`, `deepgram-voice`.

Confirmed channel-specific decision logic living outside the shared pipeline:

1. **`fittings/seed/http-gateway/scripts/lib/discuss-intercept.mjs`** - the whole
   module is web-thread-only by construction. Its header says it exists for "the
   gateway HTTP seam" and it is called "at the `/chat` + `/chat/stream` entry
   points". It decides whether an inbound message is a discuss **answer** to a
   pending `AskUserQuestion`, an explicit **GO** on a held card, or an ordinary
   turn. On Omi, voice or Slack the same sentence is just an ordinary turn - so
   answering a question or saying "go" **does not work off the web channel.** This
   is the single largest parity break found and it sits directly on the brief's
   Phase 5 path (discuss must work where Gonçalo actually is).
2. `fittings/seed/web-channel-default/scripts/server.mjs` + `ui/main.tsx` carry
   their own `workKind` handling for per-turn pins; the Omi and Slack adapters have
   no equivalent.
3. `fittings/seed/web-channel-default/scripts/threads.mjs` owns thread->card
   resolution that the other channels reach only indirectly.

### 0.9 Discuss today

- Governed by the `discuss` board list (`kind: agent-interactive`) plus
  `fittings/seed/kanban-loop/scripts/discuss.mjs` and the gateway's
  `discuss-intercept.mjs`.
- **No matrix row**, so no declared model/runtime/effort - the brief's Phase 5
  ("wire discuss to Fable across levels with effort varying by level, and give it
  web search") has no cell to write into yet. It must be created.
- A `clarity` verdict (`clear` | `needs-discuss`) already exists in
  `gateway-routing.mjs` and short-circuits deterministically on phrasing ("just do
  it" -> clear, "let's discuss first" -> needs-discuss) before any model call. This
  is the brief's §7.2 card-routing rule, already half-built. Only **1 of 90** cards
  carries a `clarity` value, so it is barely exercised.
- Defect: all 5 discuss cards in the corpus share the identical templated title
  *"Let's talk this work item through before it goes to planning. Match your
  effort…"*. The discuss card title is not derived from the topic, so the board
  cannot tell you what any discussion was about.

### 0.10 Inventory - the improver, and why it is invisible

`fittings/seed/improver/` is a substantial, live, well-tested fitting (22 lib
modules, ~20 test files). Rules: memory consolidation, the DREAM vault pass, the
SKILLS self-improvement loop, plus `feedback-rule.mjs`,
`orchestrator-policy-rule.mjs` and `coordination-rule.mjs`. It has per-rule
autonomy (`manual|auto`) with **streak-gated promotion and instant demotion** -
i.e. the brief's §7.1 graduated-autonomy machinery already exists in some form at
the *rule* level.

It is invisible for two concrete, fixable reasons:

1. **The review queue is an own-port view** (`own_port: true`, default port 7093
   dev / 8093 prod) reachable only at `/fitting/improver`. **It has zero presence
   on the Garrison home page** - a grep across `src/components/garrison/`,
   `src/app/page.tsx` and the shell components returns nothing. This is literally
   the brief's "its feedback lives in a view nobody visits".
2. **The Probe asks its questions by blocking a Claude Code `Stop` hook**
   (`scripts/probe-stop-hook.sh` -> `probe-generate.mjs`, registered into
   `~/.claude/settings.json`). So a probe question is only ever seen by someone
   sitting in a raw Claude Code terminal session. It never reaches the Kanban
   board, the web channel, Omi, Slack or voice.

The bitter irony worth recording: **the improver can only ask its questions in
exactly the raw Claude Code session the brief is trying to stop Gonçalo needing.**

The probe resolves its model from `policy.matrix["probe-question"][tier]` and fails
closed with a loud warning if that cell is missing - so `probe-question` is one of
the few duties whose matrix row is load-bearing.

### 0.11 Inventory - decisions log override path

An override path **exists** and is better-developed than the brief assumes:

- `src/lib/decision-verdicts.ts` defines a **closed** verdict vocabulary
  `right | wrong | unsure` plus a **per-dimension correction**:

  ```ts
  export const CORRECTION_FIELDS = [
    "target", "model", "effort", "duty", "tier",
    "account", "project", "workKind", "phasesOff"
  ] as const;
  ```

  The source comment says these are "exactly the run spec, so the correction UI is
  the same set of menus the run was decided with".
- `POST /api/orchestrator/decisions` records a verdict + correction, and
  **explicitly refuses** a malformed one rather than dropping it silently ("a
  verdict silently dropped would leave the user believing they had corrected
  something they had not").
- `DecisionsPanel.tsx` distinguishes `via: "turn-override"` and
  `classifierSkipped` from an orchestrator-chosen decision, so a manual override is
  already a distinguishable signal in the feed.

**So the brief's §8.2 dimension-level feedback card is a rendering job, not a data
-model job.** The fields, the storage, the refusal semantics and the "auto vs
override" distinction are built.

### 0.12 Headline: how much of the brief already exists

This audit's most important output for scoping. Roughly:

| brief section | status |
|---|---|
| §2.1 duties with levels binding runtime/model/effort | **exists** (`taskTypes` x `tiers` -> `matrix`) |
| §2.2 flows as a first-class entity | exists in name (`workKinds`), **unused in fact** (2/90 cards) |
| §2.3 flow levels + pinned overrides + escalation | **does not exist** - new construction |
| §2.4 `duty:` list prefix | trivial - lists already carry an explicit `phase` |
| §5.2 channel parity | **broken** - discuss interception is web-only |
| §7.1 graduated autonomy | exists per-improver-rule (streak promotion, instant demotion); **not** per routing decision |
| §7.2 card routing rules | half-exists - `clarity: clear\|needs-discuss` with a deterministic phrasing short-circuit |
| §7.4 signal registry | partial - `turn-override` / `classifierSkipped` / verdicts recorded, not weighted |
| §8.2 per-dimension feedback card | **data model exists**, surface missing |
| §8.3 improver visibility | own-port view exists, unreachable from home |
| §8.4 reversibility taxonomy | **does not exist** |

The run is therefore much more **extend-and-surface** than **build**, with two
genuine greenfield pieces: flow levels (§2.3) and the reversibility taxonomy (§8.4).

---

## Phase 0.2 - grounding the flow library in real work

### The measurement that reframes the run

| metric | value |
|---|---|
| Live cards on the board | **90** (2026-07-14 -> 2026-08-09) |
| Cards carrying a `workKind` (a flow) | **2** (`personal`, `full-feature`) |
| Cards carrying `phases` (a flow actually executing) | **0** |
| Cards carrying a `duty` | 34 |
| Cards carrying a `level` | 34 (27 at level 2) |
| Cards carrying legacy `tier` | 22 |
| Commits, 2 active repos, same 4 weeks | **873** (garrison 441, ekoa-code 432) |

**The flow layer is not underspecified. It is unused.** No card has ever run a
phased plan. The system in practice routes a single-turn duty - overwhelmingly
`code` at level 2 - and 873 commits of real work happened alongside 34 duty-bearing
cards. That is the measured form of "he still opens raw Claude Code sessions to get
real work done", and it means Phase 2's job is not to tidy a taxonomy but to make a
flow worth selecting.

Second finding: **cards carry both `tier` and `level`** (22 and 34 respectively).
Two spellings of the same axis persisted on the same object - a dedup target Phase 1
must fold in alongside `code`/`implement`.

### Clusters (the flow library, mined not invented)

| # | cluster | real examples from the corpus | volume | covered today? |
|---|---|---|---|---|
| C1 | **Small fix / defect on a live app** | "Drill fix: chat - 1 finding", "fix this", "the drill run results keeps flacking with scroll", "dont show the same message with the card twice" | 280 `fix` commits; ~10 cards, `duty:code` L2 | badly - no flow, routes as a bare `code` duty |
| C2 | **Feature work on own project** | "Kanban Loop: scheduling support for dated human and agent tasks", "Dashboard Board panel", "move the Pedidos into a tab in the settings area" | 218 `feat` commits | `full-feature` exists but is never selected |
| C3 | **Large brief-driven build** | "Execute BRIEF-DRILL-V1.md end to end", "OS Mode Run 1 - Task 2 implementation" | 2 cards, both L3 | `full-feature` in principle; unused in practice |
| C4 | **Discussion / scoping** | 5 discuss cards, all garrison, all L2 | 5 cards | list exists, no duty, no matrix row |
| C5 | **Research / investigation** | "Uncaught TypeError: Cannot read properties of undefined", "ssh-copy-id ... " | 2 cards `duty:research` | duty exists, **no flow** |
| C6 | **Ops / deploy** | "deploy to production" | 1 card `duty:ops` | duty exists, no flow |
| C7 | **QA sweep -> batch fix** | "Correr um drill completo (Garrison) sobre o ekoa-code", "Drill batch fix (report 01KXQK…)", "Correr a bateria de testes automatizados completa" | ~8 cards | **no coverage** - `drill` has a list but no duty and no matrix row |
| C8 | **Media production** | "Criar o primeiro vídeo de demonstração do Akoa" | 1 card `duty:image` | `video-edit` flow exists (`implement-only-logs`) |
| C9 | **Docs / prose change** | "Fazer alteração de texto no site do ekoa" | 134 `docs` commits | `docs-change` flow exists |
| C10 | **Personal / life admin** | "Comprar peixe", "Beber café", "Levar brinquedos para a piscina", "Cancelar tudo na vodafone excepto serviço casa", "Start playing Queen on Spotify" | ~12 cards | `personal` flow = `manual-only`, i.e. no agent at all |
| C11 | **Comms / follow-up with a person** | "Ekoa: responder Luciana sobre sharepoint", "Ask Rui which mobile provider to choose", "Follow up with Brazilian clinic on AI WhatsApp assistant requirements", "CSG: chamada com Denis" | ~6 cards | **no coverage** |
| C12 | **Recurring scheduled report** | "Morning briefing" x3 | 3 cards `duty:other` L1 | scheduler exists; no flow |
| C13 | **Maintenance / chore** | "web-channel: retire legacy-voice.tsx (dead code)", 50 `chore` commits | 50 commits | **no coverage** |
| C14 | **Test authoring / running** | 44 `test` commits, "Correr a bateria de testes automatizados" | 44 commits | `test` duty exists, no flow |

**Board-hygiene finding (not a flow):** several cards are catch-all buckets, not
tasks - "Garrison: bits", "Ekoa: bits", "Garrison: misc", "Ekoa-code: bits". A card
that is a bucket can never be routed, run, or completed. Worth surfacing in Phase 4
rather than modelling as a flow.

#### Coverage against the brief's required minimum

The brief's §6 list maps onto the clusters cleanly, with three additions the mining
found and the brief did not name:

- **C7 QA sweep -> batch fix** is a first-class Garrison shape (Drill produces a
  report, the report becomes a batch of fixes) with real volume and *zero* config
  support. Proposing it as a flow.
- **C11 comms / follow-up** is ~6 real cards and is not "simple task" - it has a
  recipient and an outbound side effect, which puts it squarely in the brief's §8.4
  reversibility taxonomy (delay-buffer send).
- **C10 personal** is high-volume and currently routed to `manual-only` - the agent
  is contractually absent. The brief's "simple task" flow wants exactly this shape
  to become one duty with minimal ceremony.

Every flow authored in Phase 2 will name its cluster; any flow that cannot name one
gets dropped per the brief.

---

## Phase 1 - structural refactor (complete)

| item | state |
|---|---|
| `workKind` -> `flow` codemod + compat read path + freeze gate | done (419 identifier occurrences / 67 files, plus ~45 files of prose the identifier pass could not see) |
| duty dedup (`code` -> `implement`) | done, with `DUTY_ALIASES` for the 21 existing cards |
| `discuss` / `drill` / `security-review` promoted to real duties | done |
| `duty:` prefix on Kanban lists (board v7) | done, ids untouched |
| level resolution chain (inherit -> pin -> logged raise-only escalation) | done, new construction |
| duty config relocated beside flows | done - the standalone Duties tab is gone; Orchestrator opens on "Duties & flows" |
| channel parity lift | done - discuss interception is channel-agnostic |

**Freeze gate:** `node scripts/check-flow-rename.mjs` reports clean; typecheck clean;
prod build clean; 5021 tests passing.

### Known non-mine failures (stable across the phase)

| test | cause |
|---|---|
| `spawn-tracked`, `web-channel-brief`, `dev-env-claude-sessions`, `automations-discuss` | assert against the REAL `~/.garrison`; they fail only because this run sandboxes `GARRISON_HOME` to protect live prod. All four pass against the real home. |
| `cortex-client-fitting` | caused by the **uncommitted** `compositions/default/apm.yml` change already in the working tree when this run started. Left untouched. |
| `browser-persistent-profile`, `drill-curation-e2e` | pre-existing parallel-load flakes; both pass in isolation, neither touches changed code. |

---

## Phase 2 - the flow library (complete)

**13 flows**, each naming the Phase 0 cluster it covers and real example tasks
from the mining. A flow with no examples fails validation - the brief's rule that
a flow must map to observed work is enforced, not merely intended.

| flow | cluster | default level | L1 |
|---|---|---|---|
| `fix` | C1 small fix / defect (280 fix commits) | 1 | implement, test |
| `feature` | C2/C3 feature + brief-driven builds (218 feat commits) | 2 | implement, test |
| `discussion` | C4 discussion / scoping | 1 | discuss |
| `research` | C5 research / investigation | 2 | research |
| `qa-sweep` | **C7 QA sweep -> batch fix (had ZERO coverage)** | 2 | drill |
| `task` | C10/C11 personal admin + comms follow-up | 1 | other |
| `automation` | C12 recurring scheduled work | 2 | ops |
| `chore` | C13/C14 maintenance + test upkeep | 1 | implement, test |
| `docs` | C9 prose (134 docs commits) | 1 | writing |
| `ops` | C6 deploy / infrastructure | 2 | ops |
| `image` / `video` | C8 media production | 1 / 2 | image / video |
| `personal` | C10 the manual half | 1 | other (carried forward; runs no agent duties by design) |

`defaultFlow` moves from `full-feature` to **`fix`** at level 1: the mining says the
modal request is a small defect, level 1 is the minimum viable path, and escalation
is fail-safe while over-spending by default is not.

The old library's `full-feature-copy` / `full-feature-copy-2` (byte-identical
clones of a third, made by a UI duplicate action) are gone; `FLOW_ALIASES` keeps
every retired name resolving for cards and decisions already on disk.

### Default composition - the duty ladder

Every duty now has a real model and effort at each level, following the routing
policy the brief states: Fable for implementation, vision and UI work with deeper
levels for interface work; Opus at low/medium/high for the lower levels; Codex
GPT-5.6 for much of the implementation load; Agent SDK for most of the rest;
Sonnet only at the very lowest tier.

### Board

Six columns added (`adversarial-test`, `security-review`, `walkthrough`,
`validate`, `codex-checkpoint`, `report`) because `feature` level 3 runs duties
that had no list at all - a card entering that level would have stalled with
nowhere to go. Inserted with fractional `order` values so no existing column
moves; renumbering would silently reshuffle a board reordered by hand.

---

## Decisions

| # | decision | reason |
|---|---|---|
| D1 | Run the brief plainly; borrow only autothing's goal-loop arming. | The brief forbids autothing; the operator needed the loop because `/goal` caps at 4000 chars. Confirmed with the operator before any work started. |
| D2 | Do not rename `workKind` inside `docs/autothing/runs/**`. | Those are immutable historical run records. Renaming them would falsify evidence. |
| D3 | Treat `EXPLORATION_REPORT_router_improver.md` as orientation, not ground truth. | Provably stale (12 vs 16 capability kinds). |
| D4 | Adopt the live mental model from commit `e34b1246`: **flows are phased plans, duties are the steps/lanes**. | It shipped 2 days before this run and matches the brief's §2.2 framing exactly. Re-litigating it would churn a decision the operator already made. |
| D5 | Add **C7 QA-sweep -> batch fix** and **C11 comms/follow-up** to the Phase 2 flow library even though the brief's §6 minimum does not name them. | Both have real measured volume in the corpus (~8 and ~6 cards). The brief mandates that every cluster found in mining is covered, and mandates justification only for flows that do *not* map to observed work - this is the opposite case. |
| D6 | Fold the `tier`/`level` dual spelling into Phase 1's dedup alongside `code`/`implement`. | Cards persist both (22 `tier`, 34 `level`) for one axis. Renaming flows while leaving two names for levels would trade one incoherence for another. |
| D7 | Do not model the "bucket card" problem (`Garrison: bits`, `Ekoa: misc`) as a flow. | A bucket is a board-hygiene failure, not a shape of work. Surfacing it belongs in Phase 4. |
| D8 | **Reverses part of D6.** Do NOT rename `tier` -> `level` or `taskType` -> `duty` repo-wide. Instead make `level` (1\|2\|3) the canonical dial at the routing API and UI boundary - where it already lives, on cards and in `DecisionView` - and confine `tier` / `T*-` strings to the policy matrix's storage keys behind one documented converter. | Measured before deciding: ~7,400 `tier` + ~6,100 `taskType` + ~6,700 `T*-` literals across 311 files, against 419 for the whole flow rename. An order of magnitude more churn for **zero behavioural gain**. Worse, the Drill fitting owns an entirely independent `tier` concept (its check tiers, 9 files, zero overlap with the `T0-trivial/T1-standard/T2-deep` vocabulary), so a global rename would silently corrupt an unrelated subsystem. And the brief never asks for this rename: §2.3 asks that the router choose exactly ONE level and that duty levels resolve from it, which is a behaviour requirement met by the resolution chain, not by a spelling. Renaming 20k occurrences to satisfy a requirement that is not there would be the exact "tidier taxonomy that does not move the needle" the brief warns against. |
| D9 | Keep **`implement`**, retire **`code`**. | Both name the same work; the brief's own test (same prompt, same situation, either could be selected) is satisfied. `implement` wins because every `phasePlan` already names it, it is a verb describing the step rather than an ambiguous noun, and the post-merge model makes a lane duty and a phase duty the same thing routed differently - alone at L1, or as a step inside a flow. |
| D10 | Promote `discuss`, `drill` and `security-review` to real duties. | Each is currently unroutable: `discuss` and `drill` have live board lists and run in practice but have no duty and no matrix row (S6); `security-review` is a legal phase name with no duty (S3). A duty that cannot declare a runtime, model and effort at each level is exactly the incoherence this phase exists to remove. |

## Surprises

| # | surprise | consequence |
|---|---|---|
| S1 | **Flows have no levels at all today** - one workKind maps to one phasePlan. | The brief's level-resolution chain is new construction, not a refactor. Phase 1 grows; Phase 2 must author level sets from nothing. |
| S2 | `full-feature-copy` and `full-feature-copy-2` are byte-identical clones of `full-feature`. | Two of nine shipped flows are accidental UI duplicates. Confirms the brief's "loses track of what he is configuring". |
| S3 | `security-review` is a legal phase name with no duty and no matrix row. | A plan naming it cannot route it. Live defect. |
| S4 | Duties are stored as `taskTypes` but every matrix cell's `rule` already says `duty:`. | The rename is half-done in the data already. |
| S5 | **The flow layer is unused, not underspecified**: 2/90 cards carry a `workKind`, 0/90 carry `phases`. Meanwhile 873 commits landed in 4 weeks across the two active repos. | Reframes the whole run. Phase 2's job is to make a flow worth selecting, not to tidy a taxonomy. |
| S6 | `discuss` and `drill` have board lists and run in practice but are **not duties and have no matrix row**. | Neither has a declared runtime/model/effort at any level. Discuss is on the Phase 5 critical path. |
| S7 | Discuss interception (`discuss-intercept.mjs`) is **web-channel-only by construction**. | Answering a question or saying "go" does not work from Omi, voice or Slack. Largest parity break found. |
| S8 | **The improver's Probe asks its questions through a Claude Code `Stop` hook** - visible only inside a raw terminal session. | The one surface the brief is trying to make unnecessary is the only place the improver can talk. |
| S9 | The per-dimension correction model (§8.2) already exists in `decision-verdicts.ts` over exactly the run-spec fields. | §8.2 is a rendering job, not a data-model job. Much of Phase 4 is extend-and-surface. |
| S10 | All 5 discuss cards share one templated title; the board cannot say what any discussion was about. | Small, high-visibility defect on a surface the brief cares about. |
| S11 | `ux-qa` renders as "Ux Qa" (naive title-case of the id). | Cosmetic, but it is on the board Gonçalo looks at daily. Fixed in the `duty:` prefix pass. |
| S12 | **`probe-question` pointed at a target that does not exist.** Every profile routed it to `agent-sdk-haiku-fast`, which is in no `targets[]` list; the compiler silently degraded it to `cc-sonnet` at low effort. | A direct, concrete contributor to "the improver shows no evidence of working": the duty that *asks Gonçalo questions* was mis-routed. Fixed to `cc-haiku-low`. |
| S13 | The routing validator **does** check matrix-row targets - but it only runs on **write**. An on-disk config never re-validates, so a target removed after a row was authored decays silently and the compiler falls back without complaint. | This is how S12 survived. The config is fixed; making read-time validation surface drift is logged as an open item rather than done here, because it needs a decision about what to do with configs that are already invalid. |
| S15 | **The `image` and `video` duties could not run.** Both routed to `sec-gemini`, which declares no provider, and the vault holds only Google *OAuth* client credentials (for connectors) - no Gemini API key. | Two shipped duties were dead. Both now route to Fable, which is vision-capable and runs on the Max account, so they need no key. |
| S16 | A live kanban process reading `board.mjs` mid-edit is a recurring hazard, not a one-off - it bit twice in this run. | Any change to a module a running fitting imports must land as ONE write. |
| S14 | Editing `board.mjs` in a **running** system is hazardous: a live kanban process re-read the module inside the window between two edits - after `BOARD_VERSION` became 6 but before the v6 migration body existed - and stamped both live boards v6 with nothing applied, permanently skipping the migration. | Caught because the dry run reported unchanged titles at v6. Fixed by numbering the migration v7 so the stranded boards heal. The general lesson: bump the version and add the body in ONE write, never two. |

## Ambiguities steered past

| # | ambiguity | resolution |
|---|---|---|
| A1 | The brief contradicts itself on Discuss: §2.1 lists `discuss` as a duty; §2.4 lists `discuss` among "lists that are not duties" which keep plain names. | Follow **§2.4 for display** (the Discuss list keeps its plain name) and **§2.1 for the model** (`discuss` becomes a real duty with a matrix row, which it lacks today). The two are compatible: Discuss is a *destination* list where a card sits across many turns, not a step a card passes through, so a `duty:` prefix would misdescribe it. Flagged for confirmation in the final report. |
| A2 | The brief names both a "discussion flow" and a "discuss duty" and forbids shipping competing versions. | The duty is the step; the flow is what surrounds it. One `discuss` duty, one `discussion` flow whose L1 is just that duty and whose L2 adds research + a written brief. |


---

## Phases 3-6 - final state

| phase | state |
|---|---|
| 3 routing + graduated autonomy | **partial.** Bands, signal registry, reversibility taxonomy and derived track records are built, tested and visible on the dashboard. The gateway does NOT yet consult them at decision time, so the "asks on novel shapes, stops asking as the record improves" criterion is unmet. |
| 4 improver surfaces | **partial.** The Router panel puts a one-tap verdict and the live bands on the home page - the improver's first surface outside a view nobody visits. The per-dimension correction card, the deletable-inference view and the delay-buffer send are not built (the data model for the first already exists). |
| 5 discuss parity | **partial.** `discuss` is a real duty with a matrix row for the first time, on Fable with effort rising by level, and interception works on every channel. The behaviour spec is written into the kickoff. Web search and the five before/after conversations are not done. |
| 6 end-to-end validation | **partial.** Routing proven live end to end, channel parity proven across web/omi/slack, board and both headline surfaces verified at desktop and phone widths. Running cards to completion was blocked by an Anthropic plan limit on Fable (resets 6am Lisbon); the failure path behaved correctly, parking the card with the true reason. |

The full report, including the ranked list of what still pulls Gonçalo back to a
raw Claude Code session, is [`ORCHESTRATOR_COHERENCE_REPORT.md`](./ORCHESTRATOR_COHERENCE_REPORT.md).

---

# Completion run - 2026-08-13

The brief was re-submitted four days after the original run. The 2026-08-09 run
left Phases 3-6 partial (see the final-state table above); this run finishes
them. Before building, a nine-area verification pass re-audited every gap with
file:line evidence against HEAD (`b3a82ec3`, post Gary->Zeca rename). What it
found materially reshapes the work, so it is recorded first.

## Re-audit: what the first run's report undersold

| # | finding | consequence |
|---|---|---|
| R1 | **The 13-flow library was never committed.** `compositions/*/.garrison/routing.json` is gitignored; the library data exists only as machine-local state on dev-madrid. `routing.seed.json` still ships the OLD unlevelled flow set, and `tests/flow-library.test.ts` + `tests/flow-derivation.test.ts` read the gitignored file - they fail on every machine except dev-madrid. | Acceptance §11 "default composition ships the library" was unmet in fact. Fixed this run: the seed carries the levelled library; the tests read committed data. |
| R2 | **The tracked `compositions/default/.garrison/policy.json` is a pre-dedup fossil** (carries both `code` and `implement`, plus the `full-feature-copy` clones). Runtime reads only `$GARRISON_HOME/orchestrator/policy.json`, so it is behaviourally inert - but the repo contradicted the run's own dedup story. | Refreshed via a real policy compile at deploy time; never hand-fabricated. |
| R3 | **The entire level-resolution chain had zero production callers.** `resolveDutyLevel`, `escalateDuty`, `summariseEscalations` - all pure, tested, and unwired. Pins were compile-validated and UI-rendered but never applied at runtime. `railForCard` did not read `kind.levels`: a levelled flow with no `phasePlan` fell into the all-phases-on branch. And card sequences come from `model.sequences[duty][level]` (the apm.yml duty ladder, all leaf cells, so single-duty sequences) - **the flow's per-level duty list has never driven execution**. Even the first run's own E2E card ran `implement` alone while the `fix` flow said implement, test. | The core of this run's Phase 1 residue: flow definitions become the source of card sequences, per-duty levels are stamped at creation with pins applied, the engine consumes them, and the escalation seam exists on the gateway. |
| R4 | **A field-shape bug made every verdict tap feed zero autonomy evidence.** `buildVerdictRecord` writes `{answer, original, applied, timestamp}`; `evidenceFromVerdict` read `{verdict, resolved, at}` - a shape no producer writes. The test suite fed the fictional shape, so it passed. The Router panel's own taps could never improve the bands it displays. | Fixed this run, with fixtures built from the real producer. |
| R5 | **The freeze gate was failing at HEAD**: `d803a7fe` (post-run docs commit) reintroduced `workKind` in `docs/COMPANION_IOS_SPEC.md:292`. The gate is not in CI, so it broke three days after the run without anyone noticing. | One-word fix (the doc line was also factually stale - `sanitizeRouting` accepts `flow`). CI wiring noted as an open question. |
| R6 | **The cold-start seed math violates its own invariant.** Seeded weight lands in `positive`, uncapped by `SILENCE_CAP`, so feeding C1's 280 fix commits raw yields confidence ~0.957 - the top band bought from inferred history alone, which the module's comment and test say must never happen (the test only guards 50 entries). Also `seedFromHistory` silently ignores the `correct` field its docstring documents, and no machine-readable mined task list was ever persisted - the Phase 0 corpus exists only as markdown tables. | Seed entries are capped at 50 per (category, shape); the mined list is transcribed into a committed seed file. |
| R7 | **`summariseEscalations` groups on `r.flow`, but `escalateDuty`'s record has no `flow` field.** A naive writer would collapse every escalation into one ''-keyed group. | The gateway escalation seam stamps `flow` on the record before writing. |
| R8 | **The improver's apply path can only append markdown.** `targetFileFor`/`buildNewContent` append '+' diff lines under a marker to a knowledge file; the `applyVia: 'PUT /routing'` string on policy proposals is decorative. An accepted proposal that claims to edit a flow definition edits nothing. | The escalation-recurrence rule's accept path goes through a real `PUT /api/orchestrator/policy` with baselineSha. |
| R9 | **Slack is write-deaf.** `slack-channel` serves only `/health` + `/slack/events`; no `/notify`, no thread-append. Proactive messages and mirrored questions cannot reach Slack at all, which blocks true channel parity for the improver surfaces. | Slack gains `/notify` + thread-append this run (outbound `chat.postMessage` already exists in the adapter). |
| R10 | **The probe's answer window is 90 seconds** (`sweepStalePending` maxAgeMs) - built for a blocking Stop-hook question, guaranteed to self-dismiss for any out-of-band delivery. Also: the probe never calls the model it resolves from `policy.matrix["probe-question"]` (resolution is print-only, "Acceptance #17"); questions are deterministic templates relayed by the operative session. | The rewire delivers via the notify fan-out with a much longer window, keeping the record schema `feedback-rule.mjs` consumes. |
| R11 | **`settleProjectInference` already existed before the first run** (landed 2026-07-29) - the §7.1 "gate the advance" failures happened WITH the gate present, because its 6s bound loses to the inference turn's 90s budget (`KANBAN_INFER_TIMEOUT_MS`). | The fix is sizing the existing gate against the real budget when `inferState` is `running`, not building a new one. |
| R12 | Post-run commits `0f3a3c2b` + `2b6b88ee` gave project-less turns a real workspace cwd (`$GARRISON_HOME/personal`) with a `projectDefaulted` marker protecting the improver's signal registry - but the card still runs un-fenced (`fences.mjs` needs a resolvable repo), so §7.1 is narrowed, not closed. | Fence-less runs remain; the advance-gate sizing plus the workspace cover the practical cases. Noted honestly. |
| R13 | `card.events` is capped at `MAX_EVENTS=60`, so board transitions truncate on long cards. The durable ledger lives in `duty-summary.<phase>.json` + `gate-status*.json` under `runDir`, route stamps on `routed` events, `card.fences[]` for commits, `card.dispatch.machine` for placement. | Phase 6's ledger extraction reads those, never `card.events` alone. |
| R14 | **Discuss was closer to done than the report said.** The kickoff (`buildDiscussKickoff`, 2180c2bc) already carries prose-for-TTS, no bullets, no em dash, no flattery, devil's advocate, CTO/CPO. Genuinely missing: document/artifact triggers, an explicit web-search instruction (the agent-sdk coding-preset lane already permits WebSearch - the gap is instruction + proof, not plumbing), sync with the engine's clarity-gated block (which carries none of the doctrine), and the L1 hardwire on Discuss-UI threads. S10 (templated titles) was fixed by prevention pre-run; the five corpus cards were never re-titled. | Phase 5 scope tightened accordingly. |

## Decisions (completion run)

| # | decision | reason |
|---|---|---|
| D11 | Flow definitions become the source of a card's sequence; the duty-ladder lookup (`sequences[duty][level]`) stays as the fallback for flow-less or unlevelled cards. Per-duty levels (pins applied) are stamped on the card at creation as `dutyLevels`; the engine reads them and never imports level-resolution logic. | One implementation of the chain (the orchestrator fitting's module), consumed via data. Mirroring resolveDutyLevel into the board would be a fourth copy of routing truth. |
| D12 | The escalation seam lives on the GATEWAY, not the board. | The gateway owns `decisions.jsonl` and already dynamically imports orchestrator-fitting modules (the dispatch-core pattern), so raise-only validation, flow-stamped records, and card PATCH all happen in one place. |
| D13 | The stale tracked `policy.json` is refreshed by a real compile (policy PUT) during the Phase 6 deploy, not hand-edited now. | A hand-fabricated "compiled" artifact is exactly the kind of lie the Honesty Test exists to catch. |
| D14 | Cold-start seed entries are capped at min(count, 50) per (category, shape). | 50 entries at silence weight lands exactly on the lower threshold: above ask, below act-inform - the intended cold-start posture. Uncapped, history buys the top band (R6). |

## Found along the way (completion run)

| # | finding | state |
|---|---|---|
| F1 | The Slack adapter never told the gateway where an inbound message came from (POSTed `{message}` only) and never wrote its ui-fittings status file, so even with outbound endpoints it would have been undiscoverable. Both fixed with the outbound work; Slack turns now carry `channel`/`sessionId` and become properly attributed cards. | fixed |
| F2 | `SLACK_SIGNING_SECRET` was required by the adapter but absent from the fitting's `secret_scope` - the Vault never listed it, so readiness and export requirements lied. | fixed |
| F3 | `boardCardUrl` hands notification consumers `http://127.0.0.1:<port>/...` card links - unreachable from a phone in Slack or Omi, and a live violation of the client-URL hard rule. Needs the loopback/tailnet pair treatment. | open |
| F4 | The improver's main pass has not run since 2026-07-16 on prod. ROOT CAUSE FOUND: the nightly cron fires every night, but the dream phase's claude-pty pass hits `AuthTrapError` (the TUI comes up on the onboarding screen under the scheduler's environment) and `computeDream` was the ONLY unguarded phase in `runSkills` - one crash froze memory, policy, coordination, feedback and skills rules while the job kept exiting 1 nightly. The guard is landed (a failed dream is a recorded skip; the rest of the pass runs). The AuthTrap itself - why the scheduler-env TUI reads as un-onboarded - remains open (likely HOME/.claude.json under the scheduler env). | guard fixed, auth open |
| F4b | The feedback queue has a FOURTH writer nobody catalogued: `fittings/seed/mcp-gateway/scripts/lib/tools.mjs:447` hand-rolls its record and does not use `buildFeedbackRecord`, so it gets no minted id (still deletable via the derived line-hash key). Wants the same 6-line Web-Crypto minter the other three producers carry. | open, small |
| F4c | `applyVia` on the pre-existing feedback and orchestrator-policy proposals is still decorative - their diffs are prose directions, not machine-readable edits, so only `orchestrator/flow` (the escalation pin) got a real apply dispatcher this run. Real apply paths for the other rules are separate work. | open, scoped |
| F5 | **gmail.send stays unbuffered** - the google fitting has no long-lived process to hold a cancel window, and the brief's own constraint (no new daemons) rules out inventing one. Declared immediate + irreversible in the fitting's manifest so the router must treat it ask-first, never act-and-inform. The natural future home is the automations engine (long-lived, already stamps provenance). | open, documented |
| F6 | The outbox's provenance discriminator (GARRISON_AUTOMATION_ENGINE / GARRISON_SEND_CONTEXT env) is honest-caller-only: the Operative could stamp its own call human and bypass the buffer. Same trust level as the pre-existing automation refusal it extends; airtight enforcement needs the buffer at the gateway with unforgeable caller identity. Accepted for a single-user machine, recorded so nobody mistakes it for a guarantee. | accepted risk |

## What the completion run built (pre-deploy summary)

Phases 3-5 closed in one working session, eleven work waves on disjoint file
sets. Each row is one reviewable unit; validation state at time of writing:
the improver wave self-validated on dev-madrid (198 tests green), everything
else pends the consolidated remote check.

| wave | what it is now |
|---|---|
| Flow library committed | The 13 levelled flows ship in `routing.seed.json`; flow tests read committed data; `Flow` type describes the levelled shape; the mined cold-start seed is committed data with a capped expander. |
| Level chain wired | Flow definitions drive card sequences (`resolvedFlowPlan`); `dutyLevels` stamped at creation with pins applied; each phase dispatches as the duty cell actually executing (its own resolved level); `railForCard` resolves levelled flows, aliases retired names, and returns an all-off no-evidence rail for `manual: true` flows; `POST /escalate` on the gateway - raise-only, reason mandatory, flow-stamped records into decisions.jsonl, refusals logged too; `channel` aliases to `personal` (manual successor), never to an agentful flow. |
| Verdict evidence fixed | `evidenceFromVerdict` reads the producer's real shape behind a provenance gate (three - now four known - writers share the queue); fixtures built by calling the producer so reader and writer cannot drift again. |
| Inference gate sized | `settleProjectInference` spends the inference turn's real 90s budget while an attempt is in flight, dates stranded attempts so a crashed server costs 0 not 95s per tick, keeps fail-open exactly. |
| Band consult live | `autonomy-consult.mjs` (one fitting-side fold, parity-tested against the shell's) is consulted at the decision seam for unpinned human turns: ask-band work cards itself HELD (`autonomyHeld`, mirroring `discussHeld`) with the question posed through the origin channel and a bare "go" (any channel) releasing it - the go is written twice, as audit record and as explicit-confirmation signal; act-revert/act-inform proceed with the decision record enriched and an `autonomy-acted` origin notice on first dispatch; ask budget persisted per composition and counted only when a question is actually posed; explicit pins, card-originated and internal work exempt; consult failure fails OPEN. |
| Escalation loop closed | The improver's `escalation-rule` reads decisions.jsonl via a parity-tested `summariseEscalations` replica, proposes promote-to-pin (appliable) and split-level (manual-only) at a configurable threshold, skips groups whose pin already converged, and its accept path executes a real GET+PUT `/api/orchestrator/policy` with baselineSha (409 refetch-and-reapply once, 422 hard reject without polluting the rule's autonomy record). |
| Improver visible | Signals tab lists every queue record (all producers), pending probe questions and the skip log, each row saying what it currently feeds; delete = append-only tombstone filtered by every reader (bands correct immediately); ids minted by all known producers (Web-Crypto minter, lexicographically sortable). |
| Probe out of band | The Stop-hook generator survives, but delivery fans out through every running channel's `/notify` with tappable answer actions (GET-navigable, idempotent) published as tailnet URLs - `reachable:false` recorded when no serve mapping exists rather than claiming success; relay pendings keep the 90s sweep, out-of-band ones live 7 days. |
| Feedback card | The §8.2 dimension card on the home Router panel and the same menus in the Decisions log: one tap confirms, a dimension tap corrects through the gateway's real vocabulary (server-side proxy, degraded mode when down); `resolved` now carries `flow` from both surfaces so verdicts land on flow tracks. Free-text note deliberately omitted - the verdict store strips prose by design, and a field that silently drops is a lie. `level` folds into the duty chip until `CORRECTION_FIELDS` accepts it (runtime-probed). |
| Delay-buffer send | Agent-triggered Slack/WhatsApp sends park in a 60s cancel window (exactly-once drain, crash-safe, batched same-destination flushes on Slack); cancel surface on the home page (`OutboxStrip` + server-side aggregation - the browser never sees a fitting URL); gmail declared immediate-and-irreversible in its manifest (F5). |
| Discuss finished | Kickoff carries the full doctrine (document triggers, search-before-asserting, anti-persuasion-modifiers, language matching, level-aware depth); the engine's clarity-gated block carries the SAME doctrine (it could not push back before); ladder restored to Fable low/medium/high; Discuss-UI pin level-aware; 7-day inactivity auto-archive; the unequipped duty-discuss skill text reconciled. |
| Slack two-way | `/notify` + thread-append + status-file discovery + inbound channel/session attribution; the origin id round-trips into discuss-intercept, so answering a question and "go" work on Slack. |

## Phase 6 - live evidence (in progress, 2026-08-13 morning)

Deployed: prod pulled `adb9ec01`+`98ede5a2`, redeployed, policy PUT recompiled
(compiled file fresh, 13 flows, defaultFlow fix, discuss on fable/low, drill
routable, `code` gone), composition bounced so the gateway holds the new
policy. The tracked policy.json is now the real compile, committed from the
prod host (D13 satisfied).

| exercise | evidence |
|---|---|
| Act band, seeded shape, real work | The F3 defect (loopback card links in phone notifications) sent through the web channel routed `duty implement · level 2 · flow fix`, card `01KZWR2XBB…`: sequence `[implement, test, review]` FROM THE FLOW (first card in history whose sequence came from a flow definition), `dutyLevels {implement:2, test:2, review:2}`, `project: agent-garrison` with `inferState: done` BEFORE the run started (the resized gate closing the old #1 complaint), decision record carrying `autonomy: {band: act-revert, shape: fix, confidence 0.8, observations 50, seeded: true}` - the mined seed landing exactly where the arithmetic said it would. Proceeded unheld, as the band intends. The ack's own card link is the loopback defect the card fixes. |
| Ask band, rare shape | A real research request (internet prices, no-contract) routed `research / L2 / research flow` and instead of acting the reply WAS the question ("…not confident enough on this shape yet. Reply go to proceed, or correct me"), card held in Backlog with `autonomyHeld: true` + the ask recorded against the daily budget (asked: 2 that day). |
| Go release, any channel | A bare "go" on the same web thread answered "Going ahead - research.", moved the card to its list, cleared the hold inside the move's CAS, dispatched (`[research, writing]` - the flow's own gather-then-write sequence), and wrote the audit record `{kind: autonomy-ask, resolution: go, flow: research}`. |
| Escalation, both directions | `POST /escalate` raised review 2->3 on the running fix card with a reason: applied, `dutyLevels {…review: 3}`, record flow-stamped into decisions.jsonl - the first escalation record the system has ever produced. The lowering attempt answered `applied: false` with `why: escalation may only raise a level, never lower it` and the REFUSAL recorded too. |
| Cross-channel parity | The same rare-shape message through web and omi produced byte-identical routing (`research / 2 / research`), one held card each, zero execution; both duplicates archived. Slack inbound could not be exercised - the hand-started adapter is not running on the box (no tunnel session) - recorded as a coverage gap, not a pass. |

### Phase 6 - completion (2026-08-13 morning)

| exercise | evidence |
|---|---|
| Cards to completion | `research` card: Done in 2 iterations on its flow sequence (research -> writing), brief produced. `fix` card (F3): implement 9 min -> batched test 3.5 min (passed) -> review dispatched at the ESCALATED L3 - the `sol` cell, Codex GPT-5.6 high - proving a runtime escalation changes what actually dispatches - then hit the known stale Codex login (401) and parked in needs-attention carrying the true reason. That parking IS the pass for the failure path; the card completes when `codex login` is redone. |
| The fix itself | The operative committed the F3 fix WITH a test (`446321b5 fix(kanban-loop): deliver tailnet-reachable card links to channels` + tests/kanban-tailnet-notify.test.ts) - the fix flow's definition of done honoured unprompted. The completion run's first flow-driven card fixed one of the completion run's own findings. |
| Manual rails + aliases, live | Against the live compiled policy: `personal` -> all-off rail, evidenceRequired false; legacy `channel` -> aliases to personal, still manual; legacy `full-feature` -> feature L3 full rail. No unknown-flow throw anywhere. |
| Discuss before/after | AFTER (live, Fable L1, 13.6s): topic-derived turn, plain prose, position with a stated reservation, the failure mode of the user's own proposal argued back, commitment at the end, Portuguese matched. BEFORE (corpus thread, Aug 7): the templated kickoff re-sent as the user message on every turn, markdown-bold headers, near-duplicate assistant restatements. One full pair captured with artifacts; the remaining comparisons accrue in daily use (recorded as partial coverage, not claimed). |
| Vision judge | Board at 1440x900: duty-prefixed columns after the plain human lists, Discuss deliberately unprefixed, cards carrying project chips, honest inference banners, the Scheduled card showing its full route chips. Home page: healthy post-redeploy (running / 42-42 verified / 17-17 live / attention queue naming real cards). The judge DISAGREED with reality once - a stuck loading skeleton - and the disagreement was a finding: another session's builds were racing the running server (see F8). |

### Phase 6 - honest coverage gaps

- One card per flow: 2 of 13 flows ran end to end tonight (fix, research). The rest route correctly (proven at dispatch) but were not run to completion - real cards run real work, and thirteen simultaneous real builds is not validation, it is chaos. They accrue in daily use, which is the brief's actual success test anyway.
- act-inform band: unreachable by design in one day (needs a track above 0.95 from real evidence; the seed deliberately cannot buy it).
- Recurrence-to-pin: one escalation record exists; the improver rule fires at 3. Wired and tested, awaiting organic recurrence.
- Revert proof: blocked by F7 (fences skip on prod for agent-garrison), so no trailer-attributed commits existed to revert. Machinery unit-tested and previously live-proven (4d1866f3 carries a Garrison-Card trailer).
- Slack inbound + outposts: adapter not running on the box (needs its tunnel session); outposts not exercised. Both recorded, neither claimed.

### New findings from the live run

| # | finding | state |
|---|---|---|
| F7 | Fences skip on prod for agent-garrison ("could not resolve a repo path") - cards run real work whose commits carry no card attribution, and per-card revert has nothing to target. Project inference now settles in time (proven); fence repo-path resolution is the remaining half of the old §7.1. | open |
| F8 | The kanban-test-beat cron is `0 */5 * * *` - a fix-flow card can finish implement in 9 minutes and then wait five HOURS for its test batch. That cadence defeats the fix flow's entire reason to exist (cheap and FAST for the modal shape). Needs a tighter beat or an immediate-trigger exception for single-card batches. | open, decision needed |
| F9 | A session building `.next-prod` in the live tree without restarting leaves prod serving a stale in-memory build over new disk chunks - blank-skeleton pages and 404 chunks until someone completes the cycle. The S14 lesson's production variant: build + restart + up is ONE motion (`prod:redeploy`), never a bare build. | recorded |

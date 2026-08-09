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
| S14 | Editing `board.mjs` in a **running** system is hazardous: a live kanban process re-read the module inside the window between two edits - after `BOARD_VERSION` became 6 but before the v6 migration body existed - and stamped both live boards v6 with nothing applied, permanently skipping the migration. | Caught because the dry run reported unchanged titles at v6. Fixed by numbering the migration v7 so the stranded boards heal. The general lesson: bump the version and add the body in ONE write, never two. |

## Ambiguities steered past

| # | ambiguity | resolution |
|---|---|---|
| A1 | The brief contradicts itself on Discuss: §2.1 lists `discuss` as a duty; §2.4 lists `discuss` among "lists that are not duties" which keep plain names. | Follow **§2.4 for display** (the Discuss list keeps its plain name) and **§2.1 for the model** (`discuss` becomes a real duty with a matrix row, which it lacks today). The two are compatible: Discuss is a *destination* list where a card sits across many turns, not a step a card passes through, so a `duty:` prefix would misdescribe it. Flagged for confirmation in the final report. |
| A2 | The brief names both a "discussion flow" and a "discuss duty" and forbids shipping competing versions. | The duty is the step; the flow is what surrounds it. One `discuss` duty, one `discussion` flow whose L1 is just that duty and whose L2 adds research + a written brief. |

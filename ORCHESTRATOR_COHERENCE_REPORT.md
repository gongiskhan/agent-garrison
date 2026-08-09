# Final report - Orchestrator Coherence, Flow Library, Improver v2

Run `20260809-orchcoherence-44eb07bd` · 2026-08-09 · branch `main` · dev-madrid.
Working log and evidence: [`ORCHESTRATOR_COHERENCE.md`](./ORCHESTRATOR_COHERENCE.md).

---

## 1. The one-paragraph version

The audit found that the flow layer was **not underspecified - it was unused**. Two
of 90 live cards carried a flow, none had ever run a phased plan, and 873 commits
of real work happened in the same four weeks alongside 34 duty-bearing cards. The
mechanical reason turned out to be a single line: the gateway set
`flow: hints?.flow ?? null`, so a flow arrived only if a client pinned one, and
nothing else ever did. That is now derived from the routed duty, and a live turn
through prod produces `duty implement · level 1 · flow fix` on the level-1 cell of
the ladder, where before it produced opus at xhigh effort whatever the work was. The taxonomy work, the level chain and
the library all matter, but that one line is why any of it now shows up on a card.

**What I could not finish is stated plainly in §5.** The honest summary: the
structure is done and proven live, the learning loop is built and visible but not
yet consulted by the router at decision time, and Phase 5 (discuss parity) is
one-third done.

---

## 2. What was built

| # | commit | what |
|---|---|---|
| 1 | `cdd206bf` | Phase 0 audit + the mining that reframed the run |
| 2 | `6baa0394` | `workKind` -> `flow` rename, compat read path, freeze gate |
| 3 | `ef5d43ed` | duty dedup (`code` -> `implement`), 3 duties promoted, board v7 `duty:` prefix |
| 4 | `c793d224` | the level resolution chain; duties beside flows on one screen |
| 5 | `a565c752` | channel parity: discuss works on every channel |
| 6 | `319600d6` | the 13-flow library, grounded in the mined clusters |
| 7 | `ae373052` | autonomy bands, signal registry, reversibility taxonomy |
| 8 | `35d64ed1` | derived track records + the Router panel on the home page |
| 9 | `0267f652` | the duty ladder in `apm.yml`, where it is actually read |
| 10 | `76fe6876` | levelled flows broke the Composition page; mobile overflow |
| 11 | `73afc91b` | **a card now arrives knowing which flow it is on** |

### Defects found and fixed along the way

Each of these was live, and none was the thing I set out to do.

1. **`probe-question` pointed at a target that does not exist.** Every profile
   routed it to `agent-sdk-haiku-fast`, which is in no `targets` list; the compiler
   silently degraded it to `cc-sonnet`. That is the duty the improver uses to *ask
   questions* - a concrete part of why it has shown no evidence of working.
2. **`image` and `video` could not run, in two different files.** The routing
   matrix pointed them at an unauthenticated Gemini (the vault holds only Google
   *OAuth* client credentials, no API key); `apm.yml` pointed them at `sol`, which
   is Codex GPT-5.6 and cannot see an image at all. Both now run on a
   vision-capable Anthropic model (Fable originally, Opus after `85310fea`).
3. **`implement` had exactly one level**, pinned to opus/xhigh - so a typo fix and
   a subsystem migration routed identically, to the most expensive setting
   available. The `code` duty it duplicated carried the real ladder.
4. **`security-review` was a legal phase name with no duty**, so a plan could name
   it and nothing could route it.
5. **The Composition page crashed** to its error boundary once flows carried
   levels - six `phasePlan` dereferences, two of them write paths.
6. **The home page scrolled sideways on a phone** (585px in a 390px viewport): a
   bare `1fr` grid track keeps `min-width: auto`, and the mobile override had
   dropped the `minmax(0, …)` the wide rules use.
7. **A stale test had been failing at HEAD** since `e34b1246` merged duty and work
   kind; its expectations still described the pre-merge menu.
8. **`ORIGIN_TRANSPORTS` was missing `slack`, `voice` and `schedule`** even though
   live cards carry `schedule:` origin ids - so every scheduled card looked, to
   every consumer, like something made by hand on the board.

### Two things worth remembering about the architecture

- **The compiled policy is only rewritten on a policy WRITE, never by `up()`.**
  `~/.garrison/orchestrator/policy.json` - which the Kanban engine, the gateway and
  the improver probe all read - was four days stale during this run. A change to
  `routing.json` is inert until someone saves the policy. `up()` contains code that
  looks like it recompiles; it did not run.
- **There are three duty/flow configuration stores, and the least obvious one
  wins.** `routing.json` holds the matrix, but `composition.duties` in `apm.yml` is
  projected into a resolved model and `applyDutyCells` **repoints the matrix rows
  from it**. My Phase 2 ladder was correct and had no effect until I moved it into
  `apm.yml`. Anyone editing duty levels in `routing.json` is editing a value that
  is about to be overwritten.

---

## 3. The naming decision - flagged for confirmation (brief §2.2)

Implemented as recommended: the entity is **`flow`** (`flows`, `defaultFlow`; UI
label "Flows"). One deliberate deviation from a literal reading:

> "…with `workKind` retained only as the classifier field on a decision record."

I renamed it **there too**, and did not retain `workKind` anywhere outside the
compatibility layer. Retaining it on decision records would have left the
improver's `CORRECTION_FIELDS` saying `workKind` while every other surface said
`flow` - and the brief's own Phase 1 warning is that a signal captured against a
stale label is poisoned training data. The compat layer reads the old key from the
2.1 MB of existing records and writes only the new one, so nothing was lost.

**Confirm or reverse.** Reversing is a one-line change to the retired-key map.

---

## 4. The flow library, and its grounding

Mined from 90 live cards and 873 commits over four weeks; 14 clusters found. Every
flow names its cluster and real example tasks, and **a flow with no examples fails
validation** - the grounding rule is enforced, not merely intended.

| flow | cluster (real volume) | default | L1 |
|---|---|---|---|
| `fix` | small fix / defect - **280 fix commits** | 1 | implement, test |
| `feature` | feature + brief-driven builds - 218 feat commits | 2 | implement, test |
| `discussion` | discussion / scoping - 5 cards | 1 | discuss |
| `research` | research / investigation | 2 | research |
| `qa-sweep` | **QA sweep -> batch fix - ~8 cards, previously zero coverage** | 2 | drill |
| `task` | personal admin + comms follow-up - ~18 cards | 1 | other |
| `automation` | recurring scheduled work | 2 | ops |
| `chore` | maintenance + test upkeep - 94 commits | 1 | implement, test |
| `docs` | prose - 134 docs commits | 1 | writing |
| `ops` | deploy / infrastructure | 2 | ops |
| `image` / `video` | media production | 1 / 2 | image / video |
| `personal` | the manual half - never derived onto a card | 1 | (no agent duties) |

Two clusters the brief did not name are in because the mining found them with real
volume: **qa-sweep** and **comms follow-up** (folded into `task`, since it is one
action with an outbound side effect - which puts it squarely in the reversibility
taxonomy).

`defaultFlow` moved from `full-feature` to **`fix` at level 1**: the modal request
is a small defect, level 1 is the minimum viable path, and escalation is fail-safe
where over-spending by default is not.

---

## 5. What was NOT done, and why

This is the part to read.

### 5.1 Phase 5 (discuss parity) - roughly one third done

- **Done:** `discuss` is a real duty with a matrix row for the first time (it had
  none), with effort rising by level (low / medium / high), and discuss
  interception now works on every channel rather than only the web one. The
  behaviour spec is written into the kickoff the discuss duty receives: prose for
  reading aloud, no bullets, no em dashes, no flattery, argue the other side
  before converging, hold a CTO and a CPO in your head at once.
- **Not done:** the behaviour spec extracted from the published Claude.ai prompts
  (tone, pushback, document triggers, prose-for-TTS, no bullets, no em dashes, no
  flattery, devil's advocate, CTO/CPO stance). Not done: web search wired into a
  discuss turn. Not done: the five before/after conversations compared on quality,
  cost and latency.
- **Why:** it is the phase least coupled to the rest, so it was the honest thing to
  leave short when the structural work grew. The routing half is in place, which is
  the half the other phases depended on.

### 5.2 The autonomy bands are built and visible, but the router does not consult them

`routing-autonomy.mjs` (bands, signal registry, reversibility) and
`routing-tracks.ts` (records derived from the real logs) are complete and tested,
and the Router panel shows the live bands. **What does not yet happen is the
router asking or acting differently because of them at decision time.** So the
acceptance criterion "flow and level selection visibly start by asking on novel
shapes, stop asking as the track record improves" is **not met**. The pieces are
there; the call site in the gateway is not.

Cold-start seeding exists as a function and is tested, but is not yet fed the
Phase 0 mined task list.

### 5.3 The feedback card is v1, not the dimension card

The brief's target is per-dimension correction with one-tap-per-dimension. What
shipped is the documented fallback: one tap to confirm the whole decision, and a
link to the decisions log to correct it. The **data model for the full version
already exists** (`CORRECTION_FIELDS` covers target, model, effort, duty, tier,
account, project, flow, phasesOff) - it is a rendering job, not a modelling one.

Not built: the improver view listing every captured signal with deletable
inferences; the delay-buffer send for outbound messages (the taxonomy defines it
and `bandFor` returns the `delaySeconds`, but nothing consumes it yet).

### 5.4 Phase 6 coverage is partial

**Exercised live, and passing:**
- A real turn routes end to end: `"fix the broken link in the footer of the
  settings page"` -> `duty implement · level 1 · flow fix · list implement`,
  `fable/claude-fable-5/medium`.
- **Channel parity:** the same shape of message through **web, omi and slack**
  produced identical routing (`implement / 1 / fix`) on all three.
- The board renders 20 `duty:`-prefixed columns with Discuss deliberately plain.
- Both headline surfaces render at 1440x900 and 390x844 with no horizontal
  overflow.

**Not exercised:** one card per flow; the outposts; the autonomy bands (they are
not consulted, so there is nothing to exercise); the vision judge over a completed
run; per-card revert tracking.

**A real card ran end to end and its fix is independently verified.** After the
ladder moved to Opus (`85310fea`), a request through the web channel:

> "/quarters overflows horizontally by about 3px at a 390px viewport width. Find
> the offending element and fix the CSS."

| ledger field | value |
|---|---|
| flow / duty / level | `fix` / `implement` / 2 |
| runtime · model · effort | agent-sdk · claude-opus-4-8 · T1-standard/high |
| board transitions | Backlog -> Implement -> Done, 4m |
| commit produced | `5f3e26bf` |
| root cause found | global `code { white-space: nowrap }` forcing a flex child to its min-content width |
| independently verified | yes - all five checked pages now clean at 390px |
| final state | done/ok |

That is the deterministic gate satisfied for one real card, with the fix confirmed
by re-running the measurement rather than trusting the report.

**Two external blockers were hit and are worth recording.** Fable returned HTTP
500 (`You've hit your limit · resets 6am Europe/Lisbon`), and `codex exec`
returns `401 Your session has ended. Please log in again.` The failure path
behaved correctly both times: the card parked into needs-attention carrying the
true reason rather than failing silently.

**`codex login` still needs redoing.** The decorrelation gates
(adversarial-review, adversarial-test, security-review, codex-checkpoint) are
deliberately left on Codex - repointing them at Opus would turn a cross-model
check into the same model reviewing itself - so they will keep failing until that
login is refreshed.

**One trap worth knowing:** the gateway holds the compiled policy in memory, so a
routing change needs a down/up, not just a policy PUT. Switching Fable to Opus
also does not on its own escape an Anthropic PLAN limit, since both are Anthropic
models on the same Max plan.

### 5.5 Deliberately not done

- **The `tier` -> `level` and `taskType` -> `duty` renames.** Measured first:
  ~7,400 + ~6,100 + ~6,700 occurrences across 311 files, against 419 for the whole
  flow rename. An order of magnitude more churn for zero behavioural gain, and the
  Drill fitting owns an entirely separate `tier` concept that a global rename would
  have silently corrupted. The brief asks that the router choose **one level** -
  that is a behaviour requirement, met by the resolution chain, not by a spelling.

---

## 6. How to exercise it

**From the UI**
- **Composition -> Orchestrator -> "Duties & flows"** - duties with their levels on
  the left, flow rails on the right. Each rail has an L1/L2/L3 selector showing that
  level's duty sequence, its definition of done, and any pins.
- **Garrison home -> Router panel** - how many shapes run unattended, the current
  band per shape with its observation count, and a one-tap verdict on the latest
  routing decision.
- **Composition -> Decisions** - the full feed with per-dimension correction.

**From any channel** (web, Omi, Slack, voice - behaviour is identical, only
rendering differs):
- A direct actionable request creates a card carrying its derived flow, duty and
  level.
- Answering a pending discuss question, or saying "go" on a held card, is
  intercepted out-of-band **on every channel** (this previously worked only on web).

**From the API**
- `GET /api/orchestrator/autonomy?composition=default` - live bands per shape.
- `GET|PUT /api/orchestrator/policy` - **the PUT is what recompiles the policy**;
  `up()` does not (see §2).
- `POST /api/orchestrator/decisions` - record a verdict + correction.

**Gates**
- `node scripts/check-flow-rename.mjs` - fails on any retired spelling outside the
  compat layer.
- `npm test` - 5157 passing. Four failures are home-dependent tests that pass
  against the real `GARRISON_HOME` and fail only because this run sandboxed it to
  protect live prod; one more appears only with the operator's uncommitted
  `apm.yml` change in the tree.

---

## 7. What still pulls Gonçalo back to a raw Claude Code session

Ranked by how often the Phase 0 corpus says it will bite.

1. **A card routes but runs without a project.** Every card created from a channel
   in this run carried `project: null`. Project inference starts, but the card
   advances and dispatches before it settles, so the result is discarded with
   `Project inference result discarded - the first run had already started`. The
   card that fixed /quarters still ran un-fenced (`Fence skipped: could not
   resolve a repo path`) and only worked because the operative's cwd happened to
   be the right repo. The race is by design (inference is fire-and-forget and
   yields to a started run); the fix is to gate the ADVANCE, not the inference.
   Diagnosed but not shipped in this run: it changes the dispatch path and could
   not be validated while the models were unavailable. **Highest-value next fix.**
2. **Nothing asks before acting yet.** The bands exist and are visible but are not
   consulted, so the router still has exactly one behaviour: decide and go. Trust
   has to be earned somewhere, and right now there is no mechanism through which it
   is granted.
3. **The improver still cannot ask a question anywhere he is.** Its Probe blocks a
   Claude Code `Stop` hook - the one surface this run exists to make unnecessary.
   The Router panel now carries a question, but the Probe itself was never rewired.
4. **Discuss is not yet a good conversation.** It routes to Fable at a sensible
   effort, but with no behaviour spec, no web search and no pushback doctrine, a
   thinking session is still better in the Claude app. This is Phase 5's unfinished
   two thirds.
5. **A multi-step build still has no proven path.** `feature` L3 is authored and
   its rail resolves, but no card has run it end to end. Until one does, a big
   piece of work is safer in a session you can watch.
6. **Bucket cards.** "Garrison: bits", "Ekoa: misc" - a card that is a bucket can
   never be routed, run or completed, and the board has several. Not a flow problem;
   a board-hygiene surface nobody has built.
7. **The three-store configuration problem.** Duty levels live in `apm.yml`, the
   matrix in `routing.json`, and the thing everything reads is a compiled file that
   only a UI save refreshes. Legible now that it is written down, but still three
   places.

---

## 8. Open questions

1. **The naming deviation in §3** - confirm or reverse.
2. **Should `up()` recompile the policy?** It looks like it does and does not. A
   change to `routing.json` being inert until a UI save is a trap, but making
   `up()` write it changes startup behaviour.
3. **`other` is a poor duty name on a board that now announces its duties.**
   "duty: Other" is the second column a person reads. It is the correct fallback
   lane; it is a bad label.
4. **Is `chore` distinct enough from `fix`?** They share a duty list at L1 and
   differ only in definition of done and automation candidacy. Kept because the
   brief names maintenance explicitly, but it is the one flow whose independence I
   am least sure of.
5. **The 942 turn-overrides on disk are mostly machine-generated.** Burst
   collapsing reduces 784 `image` pins to 62 occasions, but the records carry no
   channel attribution, so human and machine overrides cannot be told apart
   retrospectively. New records should carry it.

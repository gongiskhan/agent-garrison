# RUN-SPEC-V1 — explicit per-run decisions, auto by default

**Status:** SHIPPED 2026-07-29 (d643ed7, 687e4f0 + follow-ups), verified live on prod.

## What shipped

- **One pin vocabulary, ten dimensions**: `target` (runtime+provider+model),
  `model`, `effort`, `duty`, `level`, `project`, `account`, plus the new `tier`,
  `flow` and `phasesOff`. Every one defaults to Automatic on both surfaces.
- **Web Channel**: the Turn Rail gained tier / flow / phases. An auto-chosen
  value is marked `auto` on its badge (and in the badge title, so it is not
  colour-only).
- **Kanban New Card**: a collapsed *Run spec* block with the whole set, populated
  from the board's new same-origin proxy of the gateway's `/route/options` — the
  same vocabulary the gateway validates a pin against. The card stores ONE
  `routing` object, editable via `PATCH` before the run.
- **Classifier skip**: a pinned duty+tier IS a classification, so `preRoute` no
  longer classifies and then overrides the answer. A pin that cannot skip it still
  overrules the classifier on the axis it names. Reported as `classifierSkipped`.
- **Decisions**: stable id per record (derived by the same formula on both sides for
  the ~3800 that carry none), the run dimensions surfaced as fields, and a verdict
  (right / wrong / not sure) plus a counterfactual, appended to the Improver's
  EXISTING `feedback-queue.jsonl`. `feedback-rule.mjs` learned `retarget` /
  `replan` so a counterfactual is no longer silently dropped.

**Proven live**: gateway `/route/options` serves the vocabulary; both proxies
return it identically; a card round-trips a full spec through create → projection →
PATCH; a posted verdict lands in the queue; two agreeing verdicts produce the
proposal `feedback-retarget-… "the operator would have chosen cc-opus-high"`.

## Known limit (pre-existing, NOT introduced here)

The Improver's `applyVia` is a DISPLAY STRING — nothing dispatches on it. Approving
an `orchestrator/policy` proposal appends a marked block to a memory markdown file;
it does NOT write `routing.json`. So the loop currently ends at *"a reviewable
proposal that quotes your correction"*, not at an applied policy change. Closing
that is a separate piece of work in the improver.

## The ask

Stop letting the Orchestrator decide everything implicitly. On the **Web Channel**
and on a **new Kanban card**, be able to decide every dimension of a run. Every
control defaults to **auto** (= the Orchestrator decides); auto is the default, so
there is no "promote to auto". When auto resolved a dimension, badge what it chose.
In the Decisions area, confirm a decision was right or wrong and say what you would
have chosen instead — feeding the Improver so auto decides better next time. An
explicit choice should skip the classifier. And: **do not add an Nth place to
configure the same thing.**

## What already exists (audit, 2026-07-29)

This is an **EXTEND**, not a build. Ground truth from a 12-reader sweep:

- `TurnRouting` (`packages/claude-chat/src/transport.ts:120`) already ships
  **target / model / effort / duty / level / project / account** end-to-end:
  client → `mergeTurnRouting` → `body.routing` → `sanitizeRouting`
  (`gateway-pty.mjs:839`) → `routeHintsFromBody` → `applyTurnOverride`
  (`gateway-routing.mjs:217`), with per-dimension rejection reasons.
- `AttributionRail` (`packages/claude-chat/src/AttributionRail.tsx`) already renders
  a per-dimension menu whose first row is literally *"Automatic - the classifier
  decides"* (`AUTO_LABEL:62`), plus badges for what actually ran
  (`ranValue:88`) and `pinned` / `pending` / `placeholder` flags.
- `RouteAttribution.via` (`"duty-cell" | "turn-override" | "classifier"`) already
  records **who chose** — but is rendered only inside two tooltips.
- The Kanban new-card sheet already has **flow + per-phase toggles**
  (`kanban-loop/ui/main.tsx:757-780` → `railForCard`, `policy.mjs:88`).
- The gateway already **accepts** `body.flow` / `body.phases`
  (`routeHintsFromBody`, `gateway-pty.mjs:1905-1907`); the web channel's
  `buildGatewayChatBody` (`web-channel-default/scripts/server.mjs:712`) simply
  never forwards them.
- `POST /cards` already accepts `duty` / `level` / `sequence` / `tier`
  (`kanban-loop/scripts/server.mjs:1160-1188`); the New Card form never sends them.
- The classifier is **already skippable**: explicit `duty+level+phase`
  (`gateway-routing.mjs:1807`), a `routing.duty`+`routing.level` pin (`:1825`),
  and an in-vocabulary `{taskType,tier}` (`:1871`).
- The Improver feedback substrate exists: `~/.garrison/improver/feedback-queue.jsonl`
  ← `appendFeedback` (`feedback-queue.mjs:79`) → `feedback-rule.mjs` → reviewable
  proposals, never auto-applied.

## Decisions taken

1. **Identity is not a run pin.** Zeca is authored once in Orchestrator; `duty`
   carries per-run behaviour, is pinnable, and can bypass model inference. No
   persona dropdown or selectable persona Fitting exists.
2. **Expose both phase mechanisms, do not merge them.** The duty/level resolved
   sequence decides list ORDER; the flow phase plan decides ON/OFF. One control
   surface, two underlying knobs, no engine refactor.
3. **Verdicts live in the Muster Decisions panel** and write into the EXISTING
   `feedback-queue.jsonl`. No new store.

## Slices

- **S1** — widen the shared pin vocabulary with `flow`, `phases`, `tier`.
  Four whitelists must move in lockstep: `transport.ts TurnRouting`,
  `threads.mjs ROUTING_FIELDS:141`, `gateway-pty.mjs sanitizeRouting:843`,
  `ClaudeChat.tsx compactRouting:606`. Plus `GET /route/options` gains
  `flows` + `tiers` from the compiled policy.
- **S2** — web channel forwards them: `buildGatewayChatBody` stops being a straw.
  Back-compat is test-pinned (an unpinned send must stay exactly
  `{message, channel:"web"}`).
- **S3** — classifier skip when the pin already determines the classification.
- **S4** — Kanban New Card gets the full run spec from the same `/route/options`
  vocabulary; the card stores `routing`; `gateway-client.mjs` (and the batched
  `kanban.mjs` runner) forward it.
- **S5** — badge what auto chose: promote `via` from tooltip to a visible marker;
  widen `DecisionView` with runtime/model/effort/via.
- **S6** — decision verdicts: stable id, verdict UI, write path into the improver
  queue, and extend `categorize`/`kindOf` so a counterfactual is not silently dropped.
- **S7** — de-duplication cleanups found by the audit.

## Traps the audit surfaced (do not re-learn these)

- `sanitizeRouting` is **strict and closed**: an unknown key is hard-dropped with NO
  rejection recorded. Adding a field client-side without adding it at the edge
  produces a silently ignored pin — the exact lie the design exists to prevent.
- Three independent `sanitizeRouting` implementations and three client-side body
  builders (`gateway-client.mjs:267`, `kanban.mjs:444 batchGatewayRunFn`,
  `web-channel server.mjs:712`) must each learn any new field.
- An unresolvable pin is a **REJECTION**, never a fallback — otherwise the badge lies.
- `routing.project` must be a bare NAME (`projectNameForRouting` strips paths);
  `resolveProjectName` rejects anything with a slash, and `resolveProjectPath` is
  explicitly unsafe for wire input.
- Effort is honestly refused where it cannot apply (`effortControllable`); the
  `effortApplied` wire value is tri-state, not boolean.
- In the live composition **every duty level is a flat leaf cell**, so a duty-carrying
  card runs ONE phase then goes to done. Multi-phase runs come from duty:null cards
  (CANONICAL_SPINE) or the flow rail.
- Policy phases and board lists are **two loosely-coupled vocabularies**:
  `adversarial-test` / `walkthrough` / `validate` are in the `full` phase plan but are
  NOT board lists on this box.
- Editing a fitting's `ui/main.tsx` does nothing until its bundle is rebuilt.

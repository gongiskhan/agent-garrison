# RUN_SPEC — GARRISON-MARATHON-V1 (run 20260712-173530-81e1c448)

## What / why

One continuous run on `main` making Garrison runtime-agnostic (proven by a
Fitting×primary test matrix over claude-code/codex/opencode), self-explaining
(assistant + demo/guided tours), and self-improving (probe revival + four
shadcn/improve patterns in the Improver), plus a usage governor pacing the run,
a taste Fitting, Fitting clone/edit, composition switching, and a final
taste-driven UI/UX pass. Ten workstreams WS0–WS9, worked in order, each ending
in a commit + printed sentinel appended to `~/.garrison/marathon/ledger.md`.

## Acceptance criteria (run level)

The brief's 11 final-gate checks, each printing a `FINDING n:` line:
branch unchanged (= main) · no worktrees · governor evidence (periodic checks +
one pause/resume pair) · matrix complete (all composition Fittings × 3
primaries, zero unexplained failures, degradations doc) · clone round trip ·
switch round trip (evidence under two composition ids) · assistant evidence
(3 grounded answers + 2 interview proposals, provenance `assistant`) · one Demo
+ one Guided tour on two different Fittings · IMPROVER-PROBE OK + its FINDINGs ·
WS8 upgrades demonstrated (evidence fields, vet pass, rejection ledger,
reconcile) · redesign audit committed with word-count reduction and
storyboards/tours green. Terminal line `GARRISON-MARATHON OK` (or `PARTIAL` +
blocked list), then the autothing global gate.

## Non-goals

Security/prompt-injection validators; vault/crypto changes; shadcn/improve's
security-audit category and execute-in-worktree loop; multi-host/multi-user;
Garrison website; CMUX-FIT-V1; new branches/worktrees/autonomy toggles.

## Hard constraints carried into every slice

Same-branch commits with card-id trailers; Agent SDK freely routable, only
`claude -p` excluded; PTY remains default session transport; probe question
generation NEVER hits an Anthropic endpoint; Honesty Test; UI speaks Fittings
(coined terms stay; primitive-type words never primary labels); pure-MIT
vendoring only; Monaco/owned-loose-parked/provenance/drift/review-queue
semantics preserved (parameterize, don't rewrite); Improver only ever
propose-then-approve.

## Assumptions ledger (decided autonomously; alternative noted)

- **A1 WS2a rescope.** RUNTIMES-V1 (07-11) already shipped composer primary
  selection, Quarters per-runtime descriptors, single/multi collapse, and
  per-primary prompt projection. WS2a therefore = abstract the E4 trio
  (classifier pinned to a claude-code haiku PTY; Stage-B slash-inject PTY-only;
  `--continue` resume) behind the RuntimeAdapter so a non-Claude primary boots
  and serves sessions cleanly. Alternative (re-do the shipped phases) rejected.
- **A2 Probe spec.** No improver-probe brief file exists anywhere on disk; the
  probe shipped as GARRISON-FLOW-V2 S8 and is live-dead (no `probe-question`
  policy row). Spec for WS7 = the shipped S8 code + this brief's two amendments.
  "Six acceptance checks" = the five S8 probe checks + the `IMPROVER-PROBE OK`
  sentinel line. Alternative (reconstruct a brief from scratch) rejected.
- **A3 Local model path.** The default-deny base-URL fence was superseded by the
  providers-policy mechanism (S9 RUNTIME_FREEDOM_OK). Constraint intent honored
  as: probe question generation routes to the agent-sdk `ollama-local` provider
  (ANTHROPIC_BASE_URL=localhost:11434, dummy token) — never an Anthropic
  endpoint. Ollama is not installed; WS2b installs it (also needed for the
  opencode matrix) and pulls a small model (qwen2.5:3b class).
- **A4 WS1 ownership.** The global-composition writer is dormant on this box
  (`~/.garrison/global-composition/` absent), so "skills appear in Quarters as
  owned" is impossible without it. The WS1 slice ACTIVATES the global
  composition (its shipped mechanism: manifest + `.claude` symlink +
  `apm install`) with the taste Fitting as a dependency. Alternative (ship only
  into the default composition) rejected — skills would classify loose.
- **A5 opencode auth.** Zero opencode credentials exist and Claude-Max OAuth
  needs a browser. The opencode-runtime bridge defaults to a local-model
  provider (`@ai-sdk/openai-compatible` → local ollama) so delegate() and the
  matrix run autonomously and bill-free; anthropic OAuth is a documented manual
  upgrade path. Alternative (block on interactive /connect) rejected.
- **A6 Storyboard debt.** WS9 must leave every storyboard/tour green; where the
  redesign changes copy/selectors, updating those storyboards is in-scope for
  the WS9 slices (schema unchanged).
- **A7 Assistant grounding store.** Answer-mode index targets the composition's
  `memory-store` provider when present, else a local index file inside the
  assistant Fitting (capability declared `consumes: memory-store,
  optional-one`). Resolved concretely at slice time; recorded here because the
  brief said "the memory store" without naming one.
- **A8 Sentinel printing.** "Printed to stdout" = printed in this session's
  transcript AND appended to `~/.garrison/marathon/ledger.md` (+ RUN_LOG GATE
  entries). The transcript is the goal-loop's only readable surface.
- **A9 Kanban cards.** Assistant Build files cards via the existing
  taskline/kanban surface if present in the composition; else the proposal in
  the review queue doubles as the card and the delta is documented. Resolved at
  S5b time.
- **A10 Governor is single-run tooling** under `~/.garrison/marathon/` (D2),
  never committed; its evidence lives in the ledger + RUN_LOG + transcript.
- **A11 Matrix "representative action".** Health check = fitting verify hook;
  representative action = one capability-level action per fitting (delegate
  round-trip for runtimes, message round-trip for channels, view fetch for
  own-port surfaces), reusing storyboard steps where UI is required. Local-model
  quality caveats are recorded as environment notes, not failures.
- **A12 Planning shape.** Phase-1 exploration was performed pre-plan by five
  Explore agents (phase0-*.md committed); design was pre-decided by the brief's
  D1–D12; the lead sliced directly without a separate Plan subagent. Recorded
  as a deviation from the garrison-plan default flow.

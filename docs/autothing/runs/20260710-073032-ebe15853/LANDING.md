# GARRISON-UNIFY-V1 - landing

*One fitting to rule the run.* This is where the repo lands after the run:
what changed, how to drive it, and what is honestly degraded. (Draft
finalized at run close; per-item proof lives in [ACCEPTANCE.md](./ACCEPTANCE.md),
per-slice gates in `slices/*/gate-status.json`.)

## The one brain

- **`fittings/seed/orchestrator/`** is the single orchestration fitting -
  the old model-router renamed and absorbing the routing authority, the
  autothing doctrine (now in ONE prompt body:
  `.apm/prompts/orchestrator.prompt.md`), and the control panel.
- **Policy v2** (`lib/policy-core.mjs`): the matrix resolves
  `taskType x tier -> target` directly; work kinds pick phase plans (an
  ordered subset of the pipeline phases); the phase-skill registry binds each
  phase to the skill that executes it (`PHASE_SKILL_CONTRACT.md` is the
  bindable contract - swap skills in the composer with zero code changes).
- **The composer view** (own-port, S3) is the ONE place work-running is
  configured: targets tray (drag cards, effort dials), matrix board
  (drop on cell/row/column/board default), work-kind rails (phase chips,
  skill inspector), try-it dry-run strip, and the Improver's ghost-edit
  proposals (review-only, never auto-applied). Every autosave PUT recompiles
  `~/.garrison/orchestrator/policy.json` atomically - that compiled file is
  what the gateway, engine, and every phase skill read.

## How work runs now

- **Kanban Loop is the window** (S4): lists map to phases and nothing else;
  a run is a card; phase advance REQUIRES the phase's gate evidence in the
  runDir (missing evidence parks the card needs-attention); autonomous lists
  are engine-owned - manual moves/edits are rejected in UI and API until the
  card parks.
- **autothing is a thin doorway** (S5): it reads the compiled policy (exact
  D5 error when Garrison is not running), registers a card, and drives the
  same engine everyone else uses. The verb skills carry no `model:`
  frontmatter - model/effort/runtime come from the policy per phase.
- **Three doorways, one shape** (S7): web channel's Autonomous toggle, the
  autothing skill in a dev-env session, and a card created on the board all
  produce the same card-driven run. Dev-env sessions default to the
  orchestrated path (joe); "plain claude, for debugging Garrison itself" is
  the one labeled, logged escape hatch.
- **Evidence home**: `~/.garrison/runs/<project>/<runId>/` (S6), served over
  the tailnet, pruned by age/count with JSON kept indefinitely. (This run
  predates the pivot and keeps its evidence in-repo under
  `docs/autothing/runs/` by design.)
- **Cross-model work** goes through the codex-runtime delegate bridge
  (stdin task spec, machine-wide serialization lock). No skill shells out to
  `codex exec`/gemini directly.

## Remote ops (folded REMOTE-OPS-V1)

- **Outposts** (S9): per-outpost cards (heartbeat/latency/verbs/logs),
  invocation log, pairing-token installer + SSH provisioning, and card
  outpost-affinity (D27: offline affinity parks the card with the reason).
- **Monitor vitals** (S10): CPU/mem/per-mount disk (85/95 thresholds)/
  network/garrison-* systemd units in the existing snapshot loop -
  strictly display-only.
- **Ports** (S11): live `ss` scan labeled from the worktree registry +
  ui-fittings status files; loopback badges; open-in-Browser-pane; guarded
  kill.

## Power + snapshots (folded POWER-FIT-V1)

- **Snapshots** (S12): restic backups of `~/.garrison`, `~/.claude`,
  projects root; systemd user timers (daily 03:00 backup, weekly prune);
  view lists/verifies; restores are printed commands by design. Secrets:
  Vault `RESTIC_PASSWORD` + 0600 `~/.garrison/snapshots/env` fallback for
  the timer context.
- **Power** (S13/S14): busy signals (working sessions, in-flight cards,
  presence heartbeats, active SSH, load, Keep Awake) each independently
  block suspension; evaluation failure fails safe (busy); presence
  heartbeats flow from the Garrison shell (60s, visibility + input gated).

## The Improver closes the loop (S15)

Friction-log entries + run outcomes feed the orchestrator-policy rule ->
reviewable proposals (effort up/down, phase off, binding review) -> ghost
edits in the composer. Nothing auto-applies.

## Honest degradations (FOLLOWUP)

- **Codex checkpoint**: OpenAI auth is 401 on this box (no API key in env,
  `~/.codex`, or Vault) - the run-level cross-model gate ran DEGRADED
  (codex-unavailable). FOLLOWUP: set the API key, re-run the checkpoint.
- **GCS snapshots**: the box service account has `devstorage.read_only` -
  GCS writes fail; snapshots proven against the local repo. FOLLOWUP: grant
  a writable bucket/credentials, set `SNAPSHOTS_BUCKET`.
- **Self-suspend (D37)**: no compute scope on the metadata SA - real
  `instances.suspend` 403s. Suspension logic proven in isolation
  (slices/S13/evidence.cast). FOLLOWUP: grant the named scope or a
  dedicated SA.
- **Mac outpost clauses (item 12)**: no Mac reachable from this unattended
  session - pairing/unplug/provisioning-to-task-capable proven only up to
  the local host daemon; device clauses blocked honestly.
- **Device evidence (A10)**: "Mac browser over the tailnet + iPhone" proven
  from this box with viewport emulation - evidence-degraded-in-form.
- **tmux pbcopy** (E11 class c): copy bindings assume pbcopy; OSC 52 is the
  design call - FOLLOWUP.
- **Deployed `~/.claude` skill copies**: the thin-doorway family deploys as
  the run's LAST action (deploying mid-run would hot-swap this run's own
  pipeline - forbidden by the brief's meta-rule).

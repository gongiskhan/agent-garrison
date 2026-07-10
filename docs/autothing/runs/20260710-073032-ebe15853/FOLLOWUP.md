# GARRISON-UNIFY-V1 - FOLLOWUP

Items the run could not complete itself, each with the exact unblock. None are
in-scope defects (those were fixed); these are external grants, hardware, or
deliberately-deferred actions.

## External blockers (grants / credentials)
1. **Codex checkpoint + per-slice codex passes** - OpenAI auth 401 (no
   `OPENAI_API_KEY` in env, `~/.codex`, or the Vault). Set an OpenAI API key
   (not ChatGPT sign-in - unattended runs must not drain the interactive pool)
   and re-run `autothing-codex-checkpoint`. The codex-runtime serialization
   path was independently hardened this run (35ce2ee), so it is ready.
2. **GCS off-site snapshots** - the box service account has
   `devstorage.read_only`; writes to `gs:<bucket>:/garrison` fail. Grant a
   writable bucket + `devstorage.read_write` (or supply
   `GOOGLE_APPLICATION_CREDENTIALS`), then set `SNAPSHOTS_BUCKET`. Local restic
   backups are proven working (initial 24GB backup, verify, restore).
3. **Self-suspend (D37)** - the metadata SA lacks a compute scope, so
   `instances.suspend` 403s. Grant the compute scope (or a dedicated SA) so
   power-default can actually suspend the instance. The busy-signal gating +
   suspend sequence are proven in isolation (slices/S13/evidence.cast).

## Hardware
4. **Mac outpost (item 12)** - no Mac was reachable from this unattended
   session. Pair a physical Mac over the tailnet to exercise the device
   clauses: unplug -> offline within 30s, inline command relay, one-line
   installer pairing, SSH provisioning bare -> task-capable. The UI, host
   daemon, installer, and affinity parking are all built + shipped (S9).

## Design calls
5. **tmux pbcopy -> OSC 52 (E11 class c)** - the dev-env tmux copy bindings
   assume `pbcopy` (macOS). Port to OSC 52 escape sequences so clipboard copy
   works over headless/remote terminals. Recorded as a design call, not
   auto-applied.

## Config
6. **End-of-run report notification** - no `AUTOTHING_SLACK_WEBHOOK_URL` (env
   or `~/.config/autothing/.env`), so `autothing-report` runs degraded (prints
   the composed payload, exits 0 - never fails the run). Set the webhook to get
   Slack completion + mid-run degradation alerts.

## Deferred by design (the run's meta-rule)
7. **Thin-doorway skill-family deploy** - the rewritten autothing SKILL.md
   family (D5 policy-read preamble, no `model:` frontmatter) is fitting-clean
   but the deployed `~/.claude/skills` copies are still the old versions BY
   DESIGN: deploying mid-run would hot-swap this run's own pipeline (the brief's
   explicit meta-rule). Deploy via the S8 Armory path as the operator's next
   action, then the deployed copies satisfy item-3/item-7's "family clean" over
   `~/.claude` too.

## Process note
8. **Deep reviewer + design-audit panel stalled** - the fresh-context deep
   reviewers (rev-s3/912/1314, rev2-s567/1011) and one design auditor went
   silent past ~100 min. The run owner substituted an independent adversarial
   review pass that found + fixed 5 real defects (2 blockers: codex lock steal,
   outpost provisioning RCE; 3 hardenings: ports kill TOCTOU, orchestrator
   atomic write, monitor hang guard) - each with committed regression tests.
   Re-run the deep panel on a future pass for a second independent perspective.

## Residual review minors (non-blocking, deferred)
The delivered deep-review verdicts left a handful of minors below the fix bar this run:
- **power singleton guard (rev-s1314 S13#3, MAJOR but precondition-gated)** - no PID-file singleton; a Garrison restart leaving an orphaned detached watcher could suspend during active use. Add a pidfile guard like scripts/outpost-host.mjs has. Precondition-dependent (double-spawn) + touches lifecycle - deferred for careful verification.
- rev-s3 minor 4: PUT /routing with an absent ?baseline= skips the conflict guard (composer always sends one; only bites other writers).
- rev-s3 minors 6-7 (UI): pendingRef leaks one redundant PUT across a 409/422; toggling an out-of-plan phase ON appends it out of pipeline order.
- rev-s912 minor: static-dir prefix check without a trailing separator (no exploitable sibling today).
- snapshots minor: POST /api/snapshots/run has no concurrency guard (restic's own lock serializes; a double-click can fail-on-lock).
- Assorted UI nits: em-dashes across ~68/70 UI files (pre-existing house pattern), S12 restore-command copy button + overflow-wrap, monitor phone units-table clipping, ports loopback action-column ragged edge, S4 empty-column lock cue.

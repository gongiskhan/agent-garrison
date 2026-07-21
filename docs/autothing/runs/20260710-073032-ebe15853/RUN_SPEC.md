# RUN_SPEC — GARRISON-UNIFY-V1 (run 20260710-073032-ebe15853)

## What / why

Collapse Garrison's three orchestration brains (parked garrison-orchestrator
prompt, model-router prompt, autothing SKILL.md orchestration body), two
routing authorities (Model Router matrix, autothing `model:` frontmatter),
two runtime paths (runtime-fitting delegate bridges vs skills shelling
`codex exec`), and two loop drivers (autothing Stop-hook goal loop, Kanban
Loop list transitions) into ONE Orchestrator fitting that is both brain and
control panel. The Kanban Loop becomes the window on every autonomous run;
autothing becomes a thin doorway; runtime fittings are the only path to
Codex/Gemini; agent-garrison is the only config home (claude-share is
decommissioned); `~/.garrison/runs/` is the only evidence home. Folds in
REMOTE-OPS-V1 (Outposts UI, Monitor vitals, Ports) and POWER-FIT-V1
(Snapshots, Power) so everything ships in one gated run.

Authority: the brief's D1–D39 are pre-made decisions — not reopened here.
The 18 acceptance items in the brief are the acceptance criteria, verbatim.
Meta rule: this run rebuilds autothing while running under the current
autothing; the rewired pipeline governs SUBSEQUENT runs. No mid-run
hot-swap; this run's evidence stays under `docs/autothing/runs/<runId>/`
per the current contract (D19's `~/.garrison/runs/` applies to runs the new
engine drives).

## Slices (from the brief, D39 order)

S1 policy core → S8 config import → S2 brain merge → S4 run engine →
S3 composer view → S5 thin doorway → S6 evidence home → S7 surfaces →
S9 outposts → S10 monitor vitals → S11 ports → S12 snapshots →
S13 power core → S14 power guards → S15 improver proposals →
S16 headless gaps. (S9–S14 parallel-eligible: disjoint fittings.)

## Non-goals (verbatim from the brief)

Ekoa integration / shared automation-engine extraction; multi-outpost
scheduling; outpost-side vitals; Windows/Linux outposts;
restore-from-snapshot UI; vitals alerting; automatic stop tier; waking the
box; IAM setup / out-of-band power page (MACHINE-POWER-V1); auto-applying
Improver proposals; CMUX-FIT-V1; anything classified (c) in the
headless-gap audit.

## Assumptions ledger (decisions made on the operator's behalf)

| # | Decision | Chosen answer | Alternative rejected |
|---|---|---|---|
| A1 | E13 scope check failed: metadata token lacks compute scope entirely (`ACCESS_TOKEN_SCOPE_INSUFFICIENT` on instances.get AND testIamPermissions; instance scopes: devstorage.read_only, logging, monitoring, pubsub, service.mgmt.ro, servicecontrol, trace). | D37 applies: S13/S14 are BUILT (code, watcher, signals, UI, log — all buildable and testable locally) but END `blocked` on the named external cause: instance access scopes exclude compute; fixing requires stopping the VM and re-scoping (or granting via MACHINE-POWER-V1 territory). Exact failed check recorded. | Not building S13/S14 at all (violates self-unblock/fix-forward: most of both slices is provable without GCP). |
| A2 | New-fitting default ports 7088 (Ports), 7089 (Outposts), 7090 (Power) all collide with live registrations (improver 7088, kanban-loop 7089, automations 7090). | Keep the brief's decided defaults; findFreePort fallback governs (brief pre-decision); status file authoritative. | Renumbering defaults (contradicts pre-made D26/D29/D32). |
| A3 | claude-share deploy mechanism: `~/.claude` IS the claude-share git checkout. | D23 import = copy from `~/.claude` (HEAD-tracked content) into the seed; D24 archive still leaves `~/.claude/.git` pointing at the archived repo (acceptance 11 needs the push-fails proof). Breadcrumb README replaces the repo README role locally. | Deleting ~/.claude/.git (would break acceptance 11's push-fail proof and lose history locally). |
| A4 | Vault state on this box: fresh vault.json + vault-master.key (Jul 9) — usable. | S12 reads restic password + GCS key path from the Vault; if entries are absent, create vault entries where possible; the 0600 env-file fallback + FOLLOWUP per D31 only if the Vault cannot serve them. | Assuming the parked undecryptable vault (stale memory; disk shows a re-keyed vault). |
| A5 | GCS bucket for snapshots: brief names `gs:<bucket>:/garrison` without a bucket name, and the box's service account has only devstorage.read_only scope — writes to GCS via the metadata SA will fail. | Per build-loop "a brief naming an external resource is a claim": verify operator identity access; if no writable bucket/credentials exist, S12 builds everything and blocks the initial-backup acceptance on the named cause (exact failed command), with local repo verification where possible. | Provisioning a bucket with found credentials (forbidden). |
| A6 | Pre-existing test failures (4) in tests/autothing-validate.test.ts (skill drift), tests/z1-end-to-end.test.ts, tests/browser-observe.test.ts (env hook timeout). | In scope: the run's global gate needs a green suite; fix/reclassify each (validate fixtures land with S5; z1/browser-observe re-diagnosed and fixed or classified infra with evidence). | Ignoring them (violates the floor). |
| A7 | 8-day-old uncommitted automations scratch in the working tree. | Leave untouched; never commit it with run work (explicit-path commits only). | Discarding someone's WIP. |
| A8 | Coordination stack not connected in this session. | Disjoint-files discipline only; no coord ledger lines. | — |
| A9 | FILES-FIT-V2 coordination rule (pairing flow + Mac installer). | Feature-detect at S9 time; if absent on disk, build once here (E7 exploration decides). | — |
| A10 | Acceptance "proven from a Mac browser over the tailnet + iPhone checks" — no Mac/iPhone reachable from an unattended session. | Prove over the tailnet from this box (playwright against the tailnet URL, mobile viewport emulation for iPhone checks); record as evidence-degraded-in-form (viewport-emulated) where a physical device was named; honest note in LANDING. | Faking device evidence (forbidden) or blocking every UI slice on hardware (disproportionate). |

## Evidence & gates

Profile: `build` (16 slices). All gates enabled (gatesConfig all-true).
deliberate-red + mutation ON. Per-slice: deterministic wall (typecheck,
lint, securityWall: gitleaks+semgrep+dep-audit) → committed tests →
fresh-context adversarial review (+ per-slice Codex pass, build profile =
every slice) → adversarial test (ui/mixed; api batched) → design audit
(ui/mixed) → walkthrough evidence (ui/mixed video; api/cli asciinema).
Run-level: mutation → built-in security-review → codex checkpoint →
LANDING.md → report → GLOBAL GATE.

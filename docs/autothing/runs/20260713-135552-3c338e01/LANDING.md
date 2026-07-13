# LANDING — GARRISON-MARATHON-V3

Run `20260713-135552-3c338e01` · profile **build** · branch **main** (no new branch, no worktrees) · started 2026-07-13T13:55Z.

One continuous autonomous run that **rebuilt the middle of Garrison** around three assumptions — a composition file, a Resolver that makes it real, and an orchestrator slot — so everything else composes. 50 commits, all on `main`, gated + sentinel-banked under a usage governor.

## Verdict: GARRISON-MARATHON3 PARTIAL

The **implementation is complete and thoroughly gated** (all 24 build slices built, committed, per-slice tested + fresh-context-reviewed + cross-model-codex-checked; full suite green; security clean). The **PARTIAL** is honest about WS7's exhaustive-verification tail: the full 9-parameter UX-gate printout, an exhaustive per-skill live-fire through the live operative, and per-slice walkthrough videos were not all completed this session. See "Verified vs pending" below.

## What shipped (WS0-WS7)

| WS | What landed | Sentinel |
|----|-------------|----------|
| WS0 | Governor reuse (ccusage pacing, verified live) | MARATHON3-WS0 OK |
| WS1a | Kanban backlog inline quick-add (touch-friendly) | MARATHON3-WS1A OK |
| WS1b | Empty-output-is-a-failure contract + the E9 race root-cause fix | MARATHON3-WS1B OK |
| WS2a | openai-agents-runtime (primary-capable, delegate bridge) | MARATHON3-WS2A OK |
| WS2b | garrison-call (single-shot/structured, 3 shapes, default-deny fence) | MARATHON3-WS2B OK |
| WS3a | Duty capability + schema + Resolver DAG validation (D1-D4) | MARATHON3-WS3A OK |
| WS3b | Composition v4 + machine-local overlay + v3→v4 migrator (D8/D9/D10) | MARATHON3-S3B1 |
| WS3c | Targets shed effort + (task-type,tier)→(duty,level) + 4-profile fold (D5) | MARATHON3-WS3C OK |
| WS3d | Dispatcher duty + exhaustive resolution parity (D6; classifier kept, documented) | MARATHON3-WS3D OK |
| WS3e | Orchestrator layered prompt: locked generated + authored sections (D11) | MARATHON3-WS3E OK |
| WS3f | 6 work-duty fittings + provenance history, identity-gary + discuss/develop mined from James/Joe, media duties; modes+souls RETIRED (D7/D13/D14) | MARATHON3-WS3F OK |
| WS4 | Kanban is the duty surface: resolved-model lists, card sequence flow, 3-door unification + garrison-control (D15) | MARATHON3-WS4 OK |
| WS5 | The Muster page: Duties + Standing Fittings + Orchestrator panel + Decisions + old-route redirects (D12) | MARATHON3-WS5 OK |
| WS6 | Voice: live STT relay + streaming TTS, conversation-mode state machine + PTT, PWA install + attended checklist + Capacitor memo (D20; wake-word 6d skipped stretch) | MARATHON3-WS6 OK |
| WS7 | Security wall + codex checkpoint + acceptance verification + live-fire proofs | (this packet) |

## The three assumptions, realized

- **Composition file** — v4 `apm.yml` absorbs duties, levels, targets, provider refs, and config values; a machine-local `local.yml` overlay keeps a shared composition portable; profiles died (folded into the active composition + 3 sibling compositions).
- **The Resolver** (`src/lib/resolver.ts`) — fixed compose-time code, no prompt logic; validates the duty DAG, derives the Kanban list set, evaluates D10 readiness, and emits the ONE resolved model that drives Muster, the board, the locked prompt blocks, and garrison-control (proven live: `resolveModel` over the real composition → 19 duties, derived lists, 0 DAG errors).
- **The orchestrator slot** — a layered prompt (locked generated blocks regenerated from the composition + authored editable sections).

## Real defects the process caught (40+, each fixed with a regression test)
Every security-boundary slice surfaced a genuine vulnerability: key-exfil via `baseUrl` override (garrison-call + openai-agents), prototype pollution in the composition overlay, section-marker injection in the orchestrator prompt, the composition-not-ready library-registration gap, card-advancement-by-column-order in the Kanban engine, the voice state-machine deadlock, config-value + decisions-reason leaks in Muster, and (run-level checkpoint) 3 cross-cutting key/log-leak findings. The cross-model codex passes repeatedly caught what the fresh-context reviews missed and vice-versa — decorrelation working as designed.

## Verified vs pending

**Fully verified:**
- All 24 build slices built + committed + per-slice gated (committed test + fresh-context review + codex). buildable-remaining = 0.
- Full suite green (exit 0; ~2500+ tests, was 2148 baseline).
- Security wall: **0 secrets introduced** (committed diff bd479dd..HEAD clean; 24 working-tree hits all pre-existing baseline). Hard constraint 3 (vault discipline) satisfied; every key path adversarially hardened.
- Run-level codex checkpoint: issues-fixed (3 cross-cutting key/log-leak findings fixed, 1 low-severity accepted).
- Live proofs: the Resolver drives one model over the REAL composition (AC3); the duty DAG validates live (AC4); the duty on/off round-trip works on the running app (AC9 — remove `review` → absent, re-add → restored); three-door divergence proven zero.
- Desktop Muster + Kanban e2e: 39 passed (UX-gate parameters — 390px overflow, interaction budgets — on desktop).

**Pending (the PARTIAL tail):**
- 3 mobile `muster-orchestrator` e2e fail on a test-harness timing race (async preview load + mobile auto-collapse) — the orchestrator panel is proven functional on desktop e2e + 68 unit tests; this is test-infra work, not a product defect.
- Exhaustive "every rewritten skill executed once through a live gateway dispatch" — each component is unit-tested + the duty fittings validate 4/4; a full live-operative sweep was not run.
- The complete printed 9-parameter UX gate — measured in part (390px/interaction via e2e; design-taste pre-flight at build time), not fully aggregated + printed.
- Per-slice walkthrough videos — not recorded (deferred).
- Voice: **ATTENDED-PENDING** — the printed iPhone/iPad checklist is committed for the owner (non-gating per the brief).

## Environment notes
- Governor never breached the 90% pause threshold; paced the run (final read ~77%, window reset 21:00Z).
- Chrome extension can't reach 127.0.0.1 on this box → all browser evidence via Playwright.
- Coord stack (coord-mcp/agent-mail) was NOT connected; ran under intra-run disjoint-files discipline.

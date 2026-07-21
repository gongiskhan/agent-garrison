# garrison — design decisions

A log of non-obvious design decisions for the garrison skill family. Referenced by `build-loop.md`. Newest last.

---

## 2026-06-21 — ultracode is ULTRACODE-SAFE (the lead-print invariant)

**Decision.** ultracode (`/effort ultracode` = `xhigh` effort + automatic per-task workflow orchestration) may stay ON during a garrison run. It is **additive**: it operates per *task*, not per *skill*, so it does not wrap garrison's flow — it only lets the lead fan an individual substantive task out into a background workflow. The workflow contract returns control to the lead between phases, so a workflow spawned inside one gate step cannot reach across into the next gate. **This holds only because every gate line is printed in the lead context** — promoted to an explicit invariant in `build-loop.md` ("Gate lines must print in the lead context (ultracode-safe)").

**Evidence (two arms).**
- **Corroborating (behavioral).** A live 2-slice test under `/effort ultracode` (Claude Code 2.1.183, Opus 4.8 1M) had build-1 and verify-1 genuinely fan out to task-scoped workflows while build-2 and verify-2 ran inline; all four `GATE` lines reached the main transcript in order; no workflow spanned more than one named task.
- **Actual evidence (mechanical hazard probe).** A gate line whose only print-site is *inside* a workflow agent reaches the lead ONLY as the workflow script's return value and is otherwise lost — a silent gate disappearance. This is the mechanism the invariant guards against, and it is the real proof: the behavioral arm corroborates, the hazard probe is the controlled demonstration.

**Honest confound (recorded).** The only environment genuinely in `/effort ultracode` was the test session itself; headless subprocesses cannot reproduce the mode, so the behavioral arm could not be reproduced under controlled subprocess conditions — it is corroborated by the mechanical arm, which depends on a harness property (a workflow's only channel back to the lead is its return value) not under the author's control.

**Known limitation (open).** The test exercised only single-phase fan-outs. A multi-phase workflow that internally chains understand→change→verify within ONE named task was NOT exercised. The lead-print invariant protects that case in principle, but a `GATE` line meant to print *between* a workflow's internal phases is untested.

**Consequence in code.** `build-loop.md` now mandates that every `GATE <name>:`, `PROGRESS:`, `GATE codex-review:`/`GATE codex-pwtest:`, and the terminal `GLOBAL GATE:` line print in the lead context, never from inside a workflow agent. The terminal verdict must keep its `videos:<verified>/<total>` token — the goal-loop `Stop` hook (`hooks/goal-stop.sh`) keys on `GLOBAL GATE: … videos:<n>/<n>` to distinguish the real verdict from the quoted `/goal` target.

---

## 2026-06-21 — goal loop reproduced by a deterministic command Stop hook (not /goal, not a prompt hook)

**Decision.** The manual `/goal` step is replaced by a `type: "command"` Stop hook (`hooks/goal-stop.sh`) armed by a run sentinel (`~/.garrison/goal-sentinel.json`) that garrison writes in Phase 0. The hook is **deterministic** — it does a transcript read, never a model call and never `claude -p` (the PTY/billing fence forbids `type: "prompt"` Stop hooks and Agent-SDK calls against Anthropic endpoints). This is feasible because garrison's completion condition is already transcript-provable: the terminal `GLOBAL GATE: … videos:<n>/<n>` line.

**Why not the literal "exit 0 when stop_hook_active" + default cap.** Confirmed against the official hooks guide (Claude Code 2.1.185): `stop_hook_active` is true for the *entire* forced-continuation chain, so an early-exit on it would release the loop after a single turn; and Claude Code overrides a Stop hook after it blocks **8 times in a row** by default. A 50–250-turn build needs many more iterations. The documented remedy is used: *"If your hook legitimately needs more than eight iterations to converge, raise the cap with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`."* So `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` is raised to the turn cap in `settings.json`, and the hook self-terminates on: the terminal `GLOBAL GATE` verdict, an absent/foreign-session sentinel, or its own iteration counter reaching the turn cap. `stop_hook_active` is logged for visibility but is NOT the terminator. The hook fails SAFE (any error → allow the stop).

**Stale-sentinel safety.** (Superseded by the 2026-06-22 concurrency entry below — the sentinel is now per-session, not a single global file.)

---

## 2026-06-22 — concurrency-safe by construction (per-session sentinel + per-run state)

**Problem.** The first cut used a SINGLE global sentinel (`~/.garrison/goal-sentinel.json`) and a shared plan (`docs/FLOW_PLAN.md`). Two garrison runs in different sessions at the same time would clobber both — session B's Phase 0 overwrote A's sentinel, releasing A's loop early, and both wrote the same plan/evidence files.

**Fix — two changes, no shared mutable path anywhere:**
1. **Per-session sentinel.** The sentinel is now `~/.garrison/sentinels/<session_id>.json`. Phase 0 keys it by `$CLAUDE_CODE_SESSION_ID` (always set in the Claude Code shell); the Stop hook keys it by the Stop event's `session_id` (the same id). Each session reads only its own file, so concurrent runs cannot interfere. This also removed the old `current-session` file, the sessionId-mismatch check, and the bind-on-first-fire logic — the hook is simpler and has no arm-time race. `hooks/goal-sessionstart.sh` now only sweeps orphaned sentinels untouched for >2 days (an active run rewrites its sentinel every turn, so it is never swept).
2. **Per-run state directory.** All durable run state lives under `docs/autothing/runs/<runId>/` (`runId = <timestamp>-<sid8>`): `FLOW_PLAN.md`, `slices/<slice>/gate-status.json`, `evidence-index.json`. garrison-plan writes the plan there (never the shared `docs/FLOW_PLAN.md`); standalone garrison-plan uses a unique `~/.claude/plans/<slug>-<timestamp>.md`. Resume in the same session reads `runDir` from the per-session sentinel; a fresh session resuming an interrupted run picks the newest `runs/<runId>/` whose `evidence-index.json` globalGate is not `passed`.

**Assumption (verified once).** `$CLAUDE_CODE_SESSION_ID` (shell) equals the Stop hook's JSON `session_id` (both are the session uuid; the transcript dir is named by it). If a future version diverged, the loop would simply not fire (fails safe to "no loop", never to "wrong loop"), and the printed `/goal` fallback would cover the run. Verified by 10/10 branch tests incl. a concurrency case (session A's stop leaves session B's sentinel untouched).

## 2026-06-22 — full standalone decomposition + drop automation-testing

The per-slice loop is now seven standalone skills garrison orchestrates (`garrison-implement` / `-test` / `-review` / `-adversarial-review` / `-adversarial-test` / `-design-audit` / `-walkthrough`), each usable on its own; a failing gate loops back to `garrison-implement`. **`automation-testing` was removed** (the operator's projects have UI and prefer e2e through the UI); `garrison-test` defaults to e2e-through-the-UI + unit tests, with a committed-driver+asciinema path for CLI/TUI. Design audit was decomposed into `garrison-design-audit`. FLOW_PLAN `kind` is now `ui | mixed` (no `automation`).

## 2026-06-22 — goal-loop done-detection bound to runId; + liveness probe

**Confirmed LIVE.** The goal-loop Stop hook is honored under `claude --continue` — a live probe blocked the stop and Claude Code auto-continued the turn with no `/goal`. So `--continue` is fine; the hook drives the loop whenever it was active at session start (`install.sh --check` → `ok=true`).

**Bug found while probing (and fixed).** `goal-stop.sh`'s done-check matched ANY `GLOBAL GATE … videos:[0-9]+/[0-9]+` in the transcript. In a dev/meta session that merely *discusses* the verdict format (this one had 9 example `videos:3/3` strings), or a real run where a verdict line is quoted / echoed / left over from a prior run, that would **falsely release the loop early** — a silent, build-ending false positive. Fix: the terminal verdict now carries the run's unique id — `GLOBAL GATE: <status> (run <runId>) — … videos:<n>/<n>` — and the hook matches `GLOBAL GATE: … <runId> … videos:[0-9]+/[0-9]+`. The runId (timestamp + session suffix) appears on the real verdict ONLY, so examples/quotes/other-run verdicts can't trigger it. Updated in `goal-stop.sh`, `build-loop.md` (verdict format + the two signature notes), and `SKILL.md` (Phase 0 sentinel/Step D, Phase 5, durable markers, Files). Tests: 6/6 (own-run releases; different-run blocks; quoted target blocks; bare example `videos:N/N` blocks; probe skips; non-probe reason unchanged).

**Liveness probe (`hooks/probe.sh`).** `arm` → end turn → `check`. Confirms Claude Code actually honors the hook's `decision:block` in a session, using the real `goal-stop.sh`. A `probe:true` sentinel **skips** the verdict done-check (a probe has no real verdict; it releases only via its cap-2 backstop), so it works even in a transcript full of `GLOBAL GATE` examples — which is exactly what tripped the first probe attempt.

## 2026-06-23 — Codex gates: pin model + reasoning effort (cost-aware, escalate on risk)

**Problem.** The 3A/3B `codex (direct CLI, retired)` calls pinned NO model and NO `model_reasoning_effort` (only the preflight auth ping used `low`). They therefore inherited the operator's Codex account/CLI default, which had been GPT-5.5 at high effort. A scoped *diff-only* review still burned ~765k tokens/turn (≈76M tokens over ~100 turns on a Business workspace) — the unpinned effort, not unfocused context, was the dominant multiplier (our prompts were already diff-scoped per the FOCUSED hard rule). 3B's Playwright drive (DOM snapshots re-read each step) compounds it.

**Decision — pin per gate, escalate only on risk:**
- **3A review:** default `-m gpt-5.4 -c model_reasoning_effort=low`. Escalate effort to `medium` (model stays gpt-5.4 — cross-model value is *diversity*, not horsepower) only when the low pass surfaces a plausible material finding, the slice touches **auth/tenant/data/security/payments/migrations**, or the first output is low-confidence/unparseable.
- **3B test:** default `-m gpt-5.4 -c model_reasoning_effort=medium`. Escalate to `-m gpt-5.5 -c model_reasoning_effort=xhigh` ONLY on repeated unclear fails (env/flaky excluded, ≥2 on the same slice) or a high-risk slice. Browser drives never run at xhigh by default.

**Observability.** A `CODEX CALL: gate=… model=… effort=… round=… diff=[<shortstat>]` line prints in the lead context BEFORE every codex call (added to the lead-print invariant alongside the `GATE …` verdicts), so per-call cost is visible live. The actual model + effort are recorded per slice in `gate-status.codexReview.by/.effort` and `codexPwTest.by/.effort` for auditing. The diff-only FOCUSED restriction is unchanged. Updated: `references/codex-verification.md`, `garrison-adversarial-review/SKILL.md`, `garrison-adversarial-test/SKILL.md`, `references/build-loop.md`, `assets/gate-status.example.json`.

**Note.** The operator switching the Codex CLI default to gpt-5.4/medium already flowed into these calls (we don't override an explicit default unfavorably); pinning makes the choice *deterministic and per-gate* rather than dependent on whatever the account default happens to be at run time.

---

## 2026-06-23 — 3A: size-scaled round budget + Claude as the deciding authority

**Problem.** The same cost-saving move that pinned 3A to `gpt-5.4` / `low` effort (decision above) makes 3A a **weaker, cheaper** reviewer that surfaces more low-value findings (nitpicks, style, speculative). Two failure modes followed from the old loop: (1) a flat **3-round ceiling** let a small change ping-pong with Codex three times over trivia; (2) the old triage read "real & material → fix; *demonstrably* a false positive → rebut," which put the burden on Claude to *disprove* each finding and biased toward applying weak-model suggestions just to make Codex go quiet — churn and, worse, changes Claude didn't actually agree with.

**Decision — two changes, both in `references/codex-verification.md` §3A:**
- **Scale the iteration to the change size.** Round budget set BEFORE the first call from the `<BASE>...HEAD` shortstat: **very small** (`<10` lines AND `≤1` file) → **0, skip 3A** (`verdict: skipped`, `reason: size`, counts as approved for `crossModel.reviewAllApproved`); **small** (`<60` lines AND `≤3` files) → **1 round**; **substantial** → **2 rounds** (down from a flat 3). **High-risk slices** (the effort policy's list — auth / tenant / data / security / payments / migrations) are **always substantial — never skipped, never collapsed to 1** — so the cost trim never weakens scrutiny where it matters. When unsure, round UP. An effort-escalation re-run over the *unchanged* diff is part of the same round and does not consume the budget. The caps bound 3A review *iteration* only — 3B still runs, and a real material bug is still fixed even when the budget is spent (the cap limits rounds, not the duty to fix).
- **Claude is the deciding authority; Codex findings are advisory, not directives.** Apply ONLY findings Claude *independently* agrees are real, material defects that should block the slice. Everything else — nitpick, style/preference, speculative, out-of-scope, or correct-but-immaterial → do NOT apply; record a one-line rebuttal. Burden flipped: the finding must convince Claude, not Claude disprove the finding. Never apply a change just because Codex recommended it.

**Verdict at a spent budget** (priority order): an agreed-real finding still unfixed → failing gate (not done); else open findings all Claude-rebutted → `approve-with-override` (appeal valve, unchanged); else (Codex `approve`, or all agreed findings fixed with none rebutted, or size-skipped) → clean `approve`. On a 1-round small slice the clean `approve` is Claude-declared after the single round rather than a fresh Codex re-confirmation — the deliberate trade for not looping a weak model on a small change.

**Scope.** 3A (review) only — 3B (functional test) is binary pass/fail, not a negotiation, and is unchanged. Updated: `references/codex-verification.md`, `garrison-adversarial-review/SKILL.md`, `references/build-loop.md`, `assets/gate-status.example.json`.

---

## 2026-07-06 — decorrelation rewired: per-slice Codex retired, cross-model repositioned to a final-phase checkpoint

**Problem.** Even after the 2026-06-23 cost/round-budget fixes, the per-slice Codex gates (3A review, 3B Playwright test) ran a cheap model (`gpt-5.4`, low/medium effort) scoped to a single diff. At that cost tier the "second opinion" mostly re-derived findings Claude already had — real cross-vendor value needs either a much more expensive per-slice call (too costly at N slices) or a different axis of decorrelation entirely.

**Decision — two changes:**
1. **Per-slice decorrelation is now by CONTEXT, not vendor.** `garrison-adversarial-review` and `garrison-adversarial-test` are now fresh-context ANTHROPIC gates — a session with zero access to the implementer's notes/rationale, which gathers its own evidence (runs build/typecheck/lint/tests itself, or writes and executes its own Playwright probes) rather than trusting the implementer's self-reported results. No Codex call happens per slice anymore. This trades vendor diversity for a decorrelation mechanism that's cheap enough to run at full (`xhigh`/`high`) effort on every slice instead of a cheap, low-effort external pass.
2. **Codex is repositioned to `garrison-codex-checkpoint`** — a NEW skill, invoked ONCE by garrison's final phase (default ON, `--no-codex` to disable), running 3-5 SERIAL, high-effort (`gpt-5.5`/`model_reasoning_effort=high`, confirmed against `codex-cli 0.142.0`) passes over the security-critical surfaces of the whole build (whole-repo security review, the `shared/` contract, the anonymisation/egress pipeline, auth middleware + session handling — overridable by the run brief). Each invocation gets a narrow invariant rubric, never an open-ended review. This is where the genuinely-different-vendor value now lives: fewer, much more expensive, much more targeted checks, instead of a cheap rubber stamp on every slice.

**Token rename (schema + hooks kept in sync in the same pass).** Since the per-slice gates are no longer Codex calls, keeping fields named `codexReview`/`codexPwTest` would misdescribe the mechanism. Renamed: `gate-status.json` gates `codexReview` → `adversarialReview`, `codexPwTest` → `adversarialTest`; `evidence-index.json` globalGate `crossModel` → `decorrelatedVerification` (same `reviewAllApproved`/`pwTestAllPassed` shape); added a NEW run-level `globalGate.codexCheckpoint` for the checkpoint's own record. Updated every real consumer in the same pass: `assets/gate-status.example.json`, `assets/evidence-index.example.json`, `references/build-loop.md`, `SKILL.md` (pipeline description, gate-toggle table, sentinel `gates` JSON, the "Independent verification" non-negotiable, Files + delegated-skills lists), and `garrison-validate/scripts/validate.mjs` (a real script that reads these fields by literal name — not itself part of the rewire's stated scope, but a direct consumer that would silently always-FAIL its DoD check on the old field names otherwise). `hooks/goal-stop.sh` needed NO change — it only pattern-matches `GLOBAL GATE:.*<runId>.*videos:[0-9]+/[0-9]+`, which does not reference any renamed token, and the terminal verdict line still carries both required pieces.

**Gate toggle semantics changed.** `--no-adversarial-review`/`--no-adversarial-test` now disable only the per-slice Anthropic gates; `--no-codex` now disables ONLY the checkpoint (previously `--no-codex` was a convenience alias for turning off both per-slice Codex gates). `--no-adversarial` remains the convenience alias for both per-slice Anthropic gates (unchanged in spirit, just no Codex involved anymore). Defaults are unchanged in shape: a plain run gets the full per-slice gates AND the checkpoint, no flags required.

**Retired, not deleted.** `references/codex-verification.md` is marked superseded (header added) and kept for history — it still accurately describes the OLD per-slice mechanics as a record of what changed and why. `assets/codex-review.schema.json` + `assets/codex-pwtest.schema.json` (the old per-slice Codex output schemas) are now orphaned — left in place, unreferenced, pending a decision to remove them. The checkpoint has its own schema: `garrison-codex-checkpoint/assets/codex-checkpoint.schema.json`.

**Scope.** New skill: `garrison-codex-checkpoint` (SKILL.md + references/codex-checkpoint.md + assets/codex-checkpoint.schema.json). Rewritten: `garrison-adversarial-review/SKILL.md`, `garrison-adversarial-test/SKILL.md`. Updated: `SKILL.md`, `references/build-loop.md`, `assets/gate-status.example.json`, `assets/evidence-index.example.json`, `references/codex-verification.md` (superseded header), `garrison-validate/SKILL.md` + `garrison-validate/scripts/validate.mjs`.

---

## 2026-07-07 — Improvement Brief applied (durable record, resume, profiles, pipeline consolidation, determinism ratchet, spec-first, security wall)

Applied the full garrison Improvement Brief (Parts 1-13) across the skill family. The non-obvious decisions worth recording:

**The `GLOBAL GATE:` signature stayed byte-identical; new tokens are appended only.** The frozen invariant is what `hooks/goal-stop.sh` matches (`GLOBAL GATE:.*<runId>.*videos:[0-9]+/[0-9]+`). Part 11.2's `profile:<name>` and Part 3.1's conditional `model-fallbacks:<n>` were APPENDED after `gates-disabled:<list|none>` exactly the way `gates-disabled` itself was added earlier — the runId tag + `videos:<n>/<n>` token are untouched, in order. `security:`/`security-review:`/`mutation:` are NOT terminal-verdict tokens (they print as their own `GATE …` lines + record in evidence-index) precisely to avoid inserting into the frozen sequence. This is how "the verdict gains a token" and "the format is byte-identical" both hold.

**`goal-stop.sh` changed by MESSAGE TEXT ONLY (Part 2.4).** The block `reason` now carries the `[goal-loop] holding session open ...` prefix so a stop-block never reads as a failure. The matching logic, done-check, cap backstop, and fail-safe are untouched. The Part 5.7 "cooldown on repeated no-growth blocks" was **considered and deliberately NOT implemented in the hook** — it would add state/logic to a frozen safety-critical script for an optional ("MAY") backstop; the model-side active-waiting rule (never end an empty turn) addresses the busy-loop at its source, which is enough.

**Merged per-slice review (Part 8.1) = drop the same-model gate, keep the fresh-context one.** `garrison-review` (same-model) is retired FROM THE PER-SLICE PIPELINE (its unique catches were ~zero once the deterministic wall + fresh-context/Codex passes existed); `garrison-adversarial-review` (fresh-context, Fable-pinned, evidence-mandatory) is now THE per-slice review. Chose to keep the existing `adversarialReview` gate key + `adversarialTest` (symmetric, both fresh-context, minimal churn) rather than rename to `review` — and because the terminal verdict never carried a `review:` token, the frozen signature needed no change. The `review` gatesConfig key is removed; `--no-review` is accepted as a spelling of `--no-adversarial-review`. `garrison-review` stays usable standalone. The dual-review ceremony is preserved only at the run level (built-in security review + codex checkpoint).

**`kind` gains `api` (Part 8.2).** `ui | api | mixed`. Design-audit + walkthrough run for ui/mixed only; per-slice adversarial-test for ui/mixed, one batched run-level pass for api. Fixed the stale `automation` kind in the example fixtures.

**Run profiles patch/feature/build (Part 11).** Assigned at planning by the same sizing that derives the turn cap; the refusal list is now AUTO-invocation-scoped only (an explicit invocation NEVER refuses — a tiny fix is a `patch` run, regression-test-first). The floor never lowers (typecheck/lint/greps/securityWall/committed tests always run; a boundary diff always gets the fresh-context review). Escalate mid-run, never squeeze.

**Durable record + resume (Parts 1, 2).** `RUN_LOG.md` at the repo root (append-only, entry types RUN-START/GATE/DECISION/AMBIGUITY/DEVIATION/ABORT/RESUME/PAUSED, `date -u` timestamps only). `owner.lock.json` + `status.json` per run (gitignored, heartbeat every turn) — `status.json` is THE operator liveness check, to stop the second-session collisions. Git hygiene marker block keeps the small resume-critical files versioned and the evidence binaries out; evidence-index carries `videoSha256`+`videoBytes` so unversioned evidence stays auditable. Resume mode is now first-class and the SINGLE SOURCE in SKILL.md; build-loop's "Resume FIRST" points to it. Mid-run compatibility: an old-shape `gatesConfig` maps onto the new structure and an in-flight run continues under its FLOW_PLAN's gate template (profiles apply to NEW runs only).

**Model honesty (Part 3).** Fallbacks log `actualModel`+`fallbackCause` + a DECISION + a `model-fallbacks:<n>` verdict token; classifier-redirect retries once immediately, capacity retries once after backoff — one retry maximum, then record degraded.

**Determinism ratchet + spec-first + accounting.** Accepted findings ship with a deterministic guard (9.1); mutation (9.2) + property-based tests for boundary code (9.3); RUN_SPEC + assumptions ledger + `--ask-questions` one-pause (10); per-gate duration+model accounting + `LANDING.md` audit packet (12.1/12.2); dependency verification (12.3); preflight doctor at start + resume (12.4); universal gitleaks/semgrep/dep-audit wall (12.5); built-in security review before the codex checkpoint (12.6).

**Scope.** Updated: `SKILL.md`, `references/build-loop.md`, `references/decisions.md`, `hooks/goal-stop.sh` (message text only), `assets/gate-status.example.json`, `assets/evidence-index.example.json`, and the leaf skills `garrison-plan` / `-implement` / `-review` / `-adversarial-review` / `-adversarial-test` / `-design-audit` / `-parallel-work` / `-report` / `-codex-checkpoint` / `-project-foundation`, plus `walkthrough` + `garrison-walkthrough` (evidence mode). Frozen and untouched: the goal-stop matching logic and the `GLOBAL GATE:` hook-matched signature.

---

## 2026-07-07 — per-slice Codex REINTRODUCED, conditionally (evidence amends the 2026-07-06 retirement)

**Decision.** The 2026-07-06 rewire retired the per-slice Codex gates entirely (decorrelation moved to fresh-context Anthropic gates + a run-level checkpoint). Evidence from run `20260706` (RUN_LOG) then showed the per-slice Codex pass catching **real Criticals at G4/G7/G7A/G7B/G8** under diff-scoped rubrics — value the fresh-context Anthropic review did not fully replace. So a **per-slice cross-model Codex adversarial pass (`codexSliceReview`) is reintroduced, ALONGSIDE the merged fresh-context review (not replacing it), and CONDITIONALLY** so its cost lands only where it pays:
- `build` profile → every slice; `feature` → only security-boundary slices (the 11.3 trigger); `patch` → never; `--no-codex-slice` forces off.
- Mechanics: one SERIAL `codex (direct CLI, retired)`, GPT-5.5/high, diff-scoped narrow rubric ("find violations"), verdict `codexSliceReview {verdict, by, actualModel, durationMs}`, `needs-work` loops to implement within the slice's existing 5-attempt ceiling. The run-level `garrison-codex-checkpoint` is UNCHANGED.

**Credit-death is survivable, never faked (the G8 lesson).** A `codex (direct CLI, retired)` quota/auth/availability failure records `degraded (codex-unavailable)`, emits a notification, logs a `DECISION`, and CONTINUES — never blocks a run on a dead meter, never fakes a verdict (the fresh-context review still stands). And garrison's Codex auth MUST be an **API key, not ChatGPT sign-in**, with a budget cap, so an unattended run does not drain the interactive account's shared 5-hour/weekly pool (the exact G8 mechanism).

**Verdict token appended, signature frozen.** The terminal verdict gains `codexSlice:<approved>/<ran|off>`, APPENDED after `gates-disabled:`/`profile:` exactly as those were — the hook-matched `(run <runId>) … videos:<n>/<n>` signature is byte-identical, `goal-stop.sh` untouched.

**Scope.** `SKILL.md` (new "Per-slice Codex adversarial pass" section + gate-toggle table `--no-codex-slice` + gatesConfig/sentinel key + pipeline/passed/handover/non-negotiable), `references/build-loop.md` (step 3b + skipped-gates + verdict + passed + lead-print), `assets/gate-status.example.json` + `assets/evidence-index.example.json` (new gate slot + globalGate roll-up + notes), `garrison-codex-checkpoint/SKILL.md` + `references/codex-checkpoint.md` (API-key auth + budget cap + the two-call-points serialization note).


---

## 2026-07-10 — security scrutiny made OPT-IN; target-project-shaped checkpoint scopes demoted (GARRISON-FLOW-V2 D11/D13)

**Decision.** The generic flow no longer treats security scrutiny as an always-on floor beyond the deterministic wall. This is a *design change layered on top of the history above* (those entries stay as-written):

- The **deterministic `securityWall`** (gitleaks + semgrep + dependency-audit) in `garrison-test` stays universal and ambient - it runs on every slice regardless of profile, unchanged.
- The **security-boundary review rubric** (formerly folded into `garrison-adversarial-review` on a "security-boundary" heuristic) and the **conditional per-slice cross-model `codexSliceReview`** move into a NEW **opt-in `garrison-security-review` phase**. It is enabled only when `projects.<label>.security_sensitive` is set in the compiled policy or the work kind explicitly includes the `security-review` phase; it is in NO default phase plan or work kind, and the classifier never selects security phases otherwise.
- `garrison-codex-checkpoint`'s **default scopes are genericized**: whole-repo security (authz/tenant/injection/secrets) is the always-applicable default, auth/session middleware a default where present; the `shared/` contract and the anonymisation/egress pipeline are **demoted from canonical scopes to illustrative brief-supplied optional examples** (specific architectures, not defaults every repo carries). The run-level checkpoint gate is otherwise unchanged.

**Scope.** `garrison-adversarial-review/SKILL.md` (boundary rubric removed, points to the opt-in phase), `garrison-codex-checkpoint/SKILL.md` (scopes demoted), `garrison-security-review/SKILL.md` (new), the two `assets/*.example.json` schema exemplars (genericized off the former client-specific sample run), the `garrison-project-foundation` templates (domain-neutral examples), and the policy (`routing.seed.json` -> `~/.garrison/orchestrator/policy.json`: new `security-review` phase + binding + matrix cell, new `projects` section).

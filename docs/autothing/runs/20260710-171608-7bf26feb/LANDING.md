# LANDING — GARRISON-FLOW-V2 (run 20260710-171608-7bf26feb)

Profile **build** · 9 slices · **all 9 passed** · terminal verdict **completed-with-blockers** (one external blocker: the cross-model Codex checkpoint could not run — no OpenAI credentials on this box).

## What landed

Multiple autonomous runs now coexist on one project and one branch, with no worktrees anywhere. Cards declare what they will touch, wait only on real overlap, talk to each other over the coordination stack, and failures land on the card that caused them. The autonomy axis is gone: every task is a card, and the only difference between heavy and light work is the phase plan. `autothing` is now `garrison`. The Improver gained the Probe. The PTY-everywhere rule is retired.

## Gates

| Slice | Token | Review | Ind. test | Design | Video | codexSlice |
|---|---|---|---|---|---|---|
| S3 worktree sweep | WORKTREES_GONE_OK | approve | pass (13/13) | clean | verified 4/4 | degraded |
| S1 ordering | COORD_ORDERING_OK | approve (1 loop) | pass (54/54) | clean (1 loop) | verified 3/3 | degraded |
| S2 attribution | COORD_ATTRIBUTION_OK | approve (1 loop) | pass (111/111) | clean (1 loop) | verified 3/3 | degraded |
| S4 generic flow | FLOW_GENERIC_OK | approve | e2e on scratch repo | n/a (api) | verified 3/3 | degraded |
| S5 ux-qa | UX_QA_OK | approve | gate executed for real | n/a (api) | verified 3/3 | degraded |
| S9 runtime freedom | RUNTIME_FREEDOM_OK | approve | live agent-sdk turn | folded into S6 | verified 3/3 | degraded |
| S6 composer | COMPOSER_V2_OK | approve (1 loop) | pass | clean (1 loop) | verified 4/4 | degraded |
| S7 collapse + rename | AUTONOMY_COLLAPSED_OK | approve (1 loop) | pass (5/5) | clean | verified 3/3 | degraded |
| S8 Improver Probe | IMPROVER_PROBE_OK | approve (1 loop) | pass (59/59) | clean | verified 3/3 | degraded |

Run-level: **securityWall** clean on every fence (gitleaks 0, semgrep 0 ERROR). **Built-in security review: clean** — zero findings survive the confidence filter; the git-execution, destructive-endpoint, JSONL-write and key-masking paths were each audited and found genuinely defended. **deliberate-red 4/4** plants caught. **mutation 3/3** killed (one mutant initially survived → a killer test was added; the determinism ratchet worked). **Full suite 1861 passed**, typecheck clean.

## The one blocker

**Codex checkpoint — BLOCKED (external).** `codex exec` returns `401 Unauthorized` (`Missing bearer or basic authentication in header`): not logged in, no `OPENAI_API_KEY`, no `~/.codex/auth.json`. Self-unblock attempted and failed — this needs the operator's credentials. Consequently every per-slice `codexSliceReview` is recorded **degraded (codex-unavailable)**, never faked, and a full-bar `passed` is not claimed. To clear it: set an OpenAI API key (with a budget cap) and re-run the checkpoint over the security-critical scopes.

## Findings the gates caught (and what happened to them)

The reviews were not a formality — they found real defects, all fixed and re-verified:

- **Fence index isolation (HIGH).** `git commit` without a pathspec swept a *concurrently pre-staged foreign file* under the card's trailer. On a shared branch that corrupts attribution at the source. Now `git commit --only -- <touch-set paths>`.
- **Trailer spoofing (MEDIUM).** A newline in a project name forged a `Garrison-Card:` line above the real trailer, so attribution blamed the victim. Fields are whitespace-collapsed and the *last* anchored trailer wins.
- **Stranded waiter (MAJOR).** A card waiting on a blocker's stability point waited forever if the blocker was deleted or ended without ever passing review. Blocker disappearance now supersedes every wait.
- **Silent pipeline bypass (MEDIUM).** A stale session→card mapping made a later significant task run *inline*, skipping the gated pipeline entirely. Attach is now liveness-gated.
- **Cross-session probe race (MEDIUM).** Any background session's Stop could dismiss an attended session's open question and drop the real answer. Pending is now per-session.

## Gaps found by the completeness critic — and closed

The acceptance audit rejected three items I had recorded as proven. All three are now genuinely closed:

1. **The ux-qa gate had never actually run.** It has now: it walked the running board UI and produced **11 measured findings** (1 blocker, 5 major, 4 minor, 1 note) with screenshots in `slices/S5/ux-qa/`, and the loop-back rule is proven mechanically through the real validator (one `major` → `Implement`; notes only → `Done`). One finding lands on this run's own code — the waiting callout's amber text measured 3.39:1 — and is fixed. The rest describe pre-existing board surfaces and are a scoped backlog in the report.
2. **The scratch-project e2e was a paper claim.** The real engine now drove a full-feature card end to end on a non-Garrison repo (`~/dev/flow-scratch`): 9 phases, real fence commits with trailers, real tests, real gate evidence — and it *caught a genuine D12 leak*: `docs/architecture.md` was hardcoded into every Implement dispatch, including on projects that have no `docs/`. Fixed.
3. **The rename's prune half did not exist.** `install.sh` is additive by design, but nothing implemented the prune, so "additive-then-prune" was a gate nothing could open. `prune-legacy.sh` now retires the legacy hooks, gated on no live legacy sentinel (it correctly refuses right now, because *this* run is still looping on one), with five committed tests.

## Needs human eyes

- **Run `prune-legacy.sh` once this session ends.** It is the last step of the rename and cannot run while this run's sentinel is live. `bash ~/.claude/skills/garrison/hooks/prune-legacy.sh` (add `--remove-skill-dir` to also delete the retired `~/.claude/skills/autothing/`).
- **Restart the orchestrator fitting.** The running own-port server predates this run's `server.mjs`, so the composer's try-it gates and widened ghost filter are not live yet. A lifecycle restart also reassembles the souls from the renamed seed.
- **12 pre-existing dependency advisories** (5 high, 1 critical — `next`, `glob`, `esbuild`, `dompurify`, `postcss`). Root deps are byte-identical to before this run, so none were introduced here; they predate it and remain open.
- **The 10 remaining ux-qa findings** on the board surface (tap targets under the 44px comfort target, modal focus management, two contrast tokens, mobile type size). Real, measured, and not this brief's scope.
- **The `claude -p` remote-dispatch exception**: outpost dispatch genuinely needs headless mode over an exec API with no PTY. It is the one sanctioned exception, allowlisted with justification and recorded as a DEVIATION.

## Evidence

`docs/autothing/runs/20260710-171608-7bf26feb/` — per-slice `gate-status.json` + `evidence.json`, design screenshots, `phase0/` exploration, `RUN_SPEC.md`, `FLOW_PLAN.md`. Videos in the gallery (9 evidence recordings, every beat vision-verified). Journal: `RUN_LOG.md`.

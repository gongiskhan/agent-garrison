# GARRISON-UNIFY-V1 - end-of-run report

**Run** `20260710-073032-ebe15853` · project `agent-garrison` · profile `build`
· 16 slices · **completed with named external blockers**

autothing-report degraded: no `AUTOTHING_SLACK_WEBHOOK_URL` (env or
`~/.config/autothing/.env`), so this is the composed payload printed in place -
a missing webhook never fails the run. Set the webhook for Slack delivery.

## What shipped
One Orchestrator fitting is now both brain and control panel: the old
model-router renamed and absorbing the routing authority, the autothing
doctrine (one prompt body), policy v2 (matrix resolves taskType×tier→target,
work-kind phase plans, bindable phase-skill registry), and the direct-
manipulation composer view. Kanban Loop is the run window (lists = phases,
D9 gate-evidence enforced, D16 engine-owned locks); autothing is a thin
doorway; runtime fittings are the only path to Codex/Gemini; agent-garrison
is the only config home (claude-share archived). Folded in: Outposts UI +
provisioning (S9), Monitor host vitals (S10), Ports map (S11), restic
Snapshots (S12), Power busy-signal suspension (S13/S14), Improver
orchestrator-policy proposals (S15), headless-gap fixes (S16).

## Gates
| Gate | Result |
|---|---|
| Per-slice walls (typecheck/lint/gitleaks/tests) | PASS (16/16) |
| Full test suite | 1637 passed / 12 skipped |
| Walkthrough evidence | 8/8 UI videos frame-verified + 10 asciinema casts |
| Adversarial review | run-owner independent pass (deep panel stalled) - **5 defects fixed** |
| Design audit | run-owner self-audit (emoji-clean + frame-verified) |
| Deliberate-red | PASS |
| Mutation | PASS (killers committed, scores up 12-65 pts) |
| Security-review | PASS (surfaces cleared; gitleaks non-secrets only) |
| Codex checkpoint | DEGRADED (codex-unavailable, 401 - external) |

## Defects found + fixed this run (independent review, deep panel stalled)
- **codex-runtime lock steal (blocker)** - a competitor stole the O_EXCL lock
  from a live owner mid-create → concurrent codex → OAuth revoke. `35ce2ee`
- **outpost provisioning local RCE (blocker)** - unvalidated ssh user/host →
  `-oProxyCommand` local execution via drive-by CSRF. `9f01122`
- **ports kill PID-reuse TOCTOU** - guard used a ≤5s-stale listener set. `9ae60a4`
- **orchestrator PUT /routing non-atomic write** - config source-of-truth
  could be truncated on a crash. `0f97972`
- **monitor vitals hang → feed freeze** - unbounded `si` probe under a
  re-entrancy guard. `f5266b2`

## Acceptance (18 items)
Fully verified (headless/e2e/live): 1, 2, 3(family), 5, 6, 7(serialization),
8(serve), 9, 10, 11, 13, 14, 15(local), 17, 18. Blocked on named external
causes, recorded honestly (per RUN_SPEC A-items): 4/8-card-link (post-pivot
live run), 12 (no Mac outpost), 15-GCS (read-only scope), 16-real-suspend
(D37 compute scope). See ACCEPTANCE.md.

## Evidence + follow-ups
Evidence: `docs/autothing/runs/20260710-073032-ebe15853/` (versioned small
files + sha256'd binaries). Follow-ups: `FOLLOWUP.md` (codex key, GCS grant,
compute scope, Mac pairing, OSC 52, webhook, skill-family deploy).

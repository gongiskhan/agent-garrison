# Codex-primary mixed-runtime orchestrator audit

Date: 2026-07-16 (Europe/Lisbon)

## Outcome

PASS. A composition created and configured through the UI ran a medium coding task from Web Channel registration through a real Kanban `Done` transition using three distinct runtime engines. The finished card exposes a fresh test report and four concordant per-phase gates.

- Composition: `codex-mixed-proof-20260716`
- Card: `01KXMWJ11Y5CC38F0NJ0K6SGT1`
- Run: `01KXMWKN4EZPD87XBWW048K268`
- Workspace: `/tmp/garrison-mixed-runtime-proof-20260716`
- Final state: `done` / `ok`
- Live gateway: `primary_runtime=codex`, `pty_status=ready`

## UI configuration and ingress

The Playwright run created a new composition, selected Codex as the primary runtime, configured distinct runtime/model/effort cells, selected the composite `develop` duty, restarted the operative, opened Web Channel, submitted the task, and followed the returned card into Kanban.

Gemini was configured as `gemini-2.5-flash`, but Gemini CLI 0.49.0 exits 41 before a turn because no auth method is configured (`GEMINI_API_KEY`, Vertex AI, or GCA). Per the allowed one-runtime blocker, the completed task used the other three engines.

Key UI captures:

- [Codex primary and mixed runtime cells](vision/04-codex-primary-and-runtimes.png)
- [Restarted active composition](vision/05-restarted-active-composition.png)
- [Web Channel card registration](vision/08-web-card-registered.png)
- [Final Done board](vision/34-final-done-board.png)
- [Final card detail](vision/35-final-done-detail.png)
- [Open evidence report](vision/36-final-evidence-open.png)

## Observed execution routes

| Phase | Target | Runtime | Provider | Model | Effort | Applied |
| --- | --- | --- | --- | --- | --- | --- |
| Plan | `sdk-sonnet-full` | Agent SDK | Anthropic | `claude-sonnet-4-6` | medium | true |
| Implement | `fable` | Claude Code | Anthropic plan | `claude-fable-5` | high | true |
| Review | `codex-sol-review` | Codex | OpenAI | `gpt-5.6-sol` | xhigh | true |
| Test | `cc-haiku` | Claude Code | Anthropic plan | `haiku` | low | true |

The Plan runtime reached its structured max-turn limit only after writing a valid current-phase durable gate, so the engine advanced from that gate and recorded the stop. Implement fixed a real `null`-key LRU sentinel bug and added its regression. Review made two README accuracy fixes and passed cleanly. Test ran all 14 tests and wrote the terminal proof.

## Durable evidence

Per-phase gates now agree exactly with the transition rail:

| Gate | `next_phase` |
| --- | --- |
| `gate-status.plan.json` | `implement` |
| `gate-status.implement.json` | `review` |
| `gate-status.review.json` | `test` |
| `gate-status.test.json` | `done` |

`evidence/evidence.md` is non-empty and user-openable from the Done card. It records `npm test`, 14 total, 14 passed, 0 failed, the named cases, and the final PASS verdict. A separate verification after completion also passed 14/14.

All card logs remain monotonic (`log-1.md` through `log-11.md`). The original `log-1.md` hash remains `6ea20eaba9f80320d5eea7ca409522e3a57b2bac92ec7bab8e461599517f8389`.

## Problems found and fixed during the live run

- New-composition cloning/creation and primary-runtime persistence in the UI.
- Muster standing for runtime cells and composite duties.
- V4 duty/sequence/exact runtime-model-effort projection and live attribution.
- Codex-primary gateway health/session behavior and Codex permission/effort application.
- Web Channel significant-task auto-dispatch into Kanban.
- Agent SDK max-turn normalization and durable-gate recovery.
- Goal-mode prompt compatibility with Claude Code's slash-command length rules.
- External `/tmp` workspace inference and safe coordination touch-set claims.
- Needs-attention recovery without losing the run directory or historical logs.
- Atomic/serialized live log rewrites, eliminating late partial-write races.
- Installed-board migration of engine-owned Test evidence fields and exact historical default prompts while preserving custom prompts.
- Mandatory non-empty `evidence/evidence.md` for every actual terminal `Test -> Done` edge, independent of stale board fields.
- Durable gate/transition concordance across direct, batched, and in-session transition seams.
- Current-attempt gate freshness: retries fingerprint pre-existing relevant gate files and cannot reuse untouched history, including max-turn and empty-output rescue paths.

The first hardened Test retry intentionally demonstrated the invariant: it produced valid evidence and replied `done` but left an older `adversarial-test` gate untouched, so the engine parked it instead of falsely completing. The UI capture is [the caught mismatch](vision/28b-test-mismatch-caught.png). After the freshness and retry-prompt fixes were deployed through normal UI restarts, the final retry overwrote the gate with `done` and completed.

## Verification

- Medium task package: 14/14 tests pass.
- Task-focused repository suite: 213/213 tests pass across composition creation, Codex-primary health, Agent SDK/Codex routing, Web Channel transport, Kanban flow/evidence/retry/freshness/log-race behavior.
- Full Kanban + run-engine regression set: 284/284 tests pass.
- `npm run typecheck`: pass.
- `git diff --check`: pass.
- All Playwright audit scripts: `node --check` pass.
- Repository-wide Vitest context: 2,632 passed, 14 skipped, 8 baseline failures in four unrelated untouched/generated areas (OpenAI Agents optional dependency/baseline code, stale Muster decision-feed expectations, and a model-less target in an ignored generated default-routing fixture). The task-focused surfaces and every changed Kanban/runtime surface are green.

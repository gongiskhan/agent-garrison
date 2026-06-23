# Brief: Collapse the warm Claude Code pool to one generic pool (spike → implement)

**Repo:** agent-garrison
**Runtime target:** Claude Code via the PTY layer, version ≥ 2.1.181
**How to use:** Paste this whole brief into Claude Code **plan mode**. Explore the repo, produce a plan, and make the plan's final section the ready-to-paste `/goal` line given at the end. Then send that `/goal` line as the next message.

---

## Why

Claude Code 2.1.181 added `/config key=value`, which sets settings from the prompt mid-session (no picker). If the settings the Model Router routes on can be changed live, the warm pool no longer needs separate sub-pools per (model × effort × task-type). We run **one** pool of identical warm sessions and concretise each at checkout.

This is an **Execution-layer** change only. Policy (routing matrix → abstract roles) and Concretisation (Profiles → concrete model targets) do not change. Only how Execution realises a target changes: from "pick the right pre-specialised pool" to "take a generic warm session and configure it at checkout."

Two unknowns block the change, so we **spike first**:
1. Which routing settings actually apply mid-session vs silently need a restart.
2. Whether role identity (system prompt) is among them. Expected answer: no.

## Hard constraints (do not violate)

- **PTY-everywhere.** The spike and the runtime path drive Claude Code through the existing node-pty + headless xterm layer. No `claude -p`. No Agent SDK against the Anthropic endpoint. (Max-plan billing rule, post 2026-06-15.)
- **Compose, don't own.** Use Claude Code's native `/config` and `/model`. Do not build a parallel model-swap mechanism.
- **Explore before planning.** Confirm the real code and the real CC behaviour on this machine. Do not assume field names or surfaces.
- Reuse the existing RuntimeAdapter / session-pool code. This is a refactor, not a new subsystem.

## Phase 0 — Explore (before writing the plan)

- Confirm the installed Claude Code version. If it is below 2.1.181, stop and report — the spike cannot proceed.
- Find the current warm-pool code. Note how it is partitioned today (by model? effort? task-type?) and the file paths.
- Find the PTY harness that drives a session, and its dialog-handling logic (how it answers permission and confirmation prompts).
- Find where a session is concretised today (where model / effort / etc. are decided at boot).

## Phase A — Spike: which settings hot-swap

Drive **one** real warm session through the existing PTY harness. For each candidate setting: read the current value, change it mid-session via `/config key=value` (or `/model` for model), read it back, and assign a verdict.

Candidate settings to probe:
- **S1** model
- **S2** effort
- **S3** permission mode
- **S4** allowed / disallowed tools
- **S5** active MCP servers (allowlist)
- **S6** system prompt / role identity (expected verdict: BOOT)

Method notes:
- Prefer read-only surfaces to observe state: `/status`, `/permissions`, `/mcp`. Confirm what each actually prints on this version — do not assume.
- Where no status surface exists (e.g. allowed-tools), use a behavioural probe: attempt a gated action and see whether the gate changed.
- Handle confirmation dialogs deterministically. `/model` warns before switching mid-conversation; effort changes can prompt. The harness must answer these. **This dialog handling is part of the deliverable** — the checkout path needs it too.
- Verdict per setting: **HOT** (took effect mid-session, no restart), **BOOT** (only via restart), or **N/A** (not a setting we route on).
- Keep it cheap: smallest model, fewest turns, read-only probes where possible.

Write a report to `spikes/config-hotswap/REPORT.md` (a table: setting, command used, observed before→after, verdict). Then print one `FINDING` line per setting to the transcript.

## Decision gate

Split the routing settings into:
- **HOT set** — applied at checkout by typing `/config` / `/model` into the warm session before dispatching the first real prompt.
- **BOOT set** — cannot be hot-swapped. Either baked into session boot (and that dimension still forces a separate pool), or handled another way you justify in the plan.

The implementation must follow the spike's verdicts strictly. **Nothing** goes through the checkout `/config` path unless the spike verified it as HOT.

## Phase B — Implement

1. **Collapse the pool.** One generic warm-session definition: identical sessions, no per-(model / effort / type) partitioning for anything in the HOT set.
2. **Add checkout-time concretisation.** Given a target role/profile, the orchestrator resolves it to concrete settings, applies the HOT-set settings via the PTY (`/config` / `/model`), answers any dialogs, then sends the first real prompt. **Reconfigure at checkout only — never mid-task**, because a model switch re-reads history uncached and would blow the prompt cache on an in-flight session.
3. **Handle the BOOT set explicitly.** If any routing dimension is BOOT (likely S6), keep it as a boot parameter and document that it still forms its own pool. If S6 is the only BOOT dimension and our roles do not need distinct system prompts, state plainly that one pool fully suffices.
4. **Tests.**
   - Integration: a generic session is concretised to at least two different profiles (e.g. expert/Opus/high-effort and fast/Haiku/low-effort) and is shown to reflect each.
   - Reuse the existing phase-gate verification style (Playwright, real session, live Gary on the Max plan) if that is how the runtime is verified today.

## Acceptance criteria (transcript-checkable)

Print each as a literal line. The `/goal` evaluator reads only the transcript.

- **FINDING S1..S6:** `FINDING S<n> <setting>: <HOT|BOOT|N/A> — cmd=<...> observed=<before>-><after>`
- **FINDING 7:** exactly one generic warm-pool definition exists — show the grep proving the per-(model/effort/type) partitioning was removed.
- **FINDING 8:** `FINDING 8 checkout-concretisation: PASS`, with the two-profile test output shown above it.
- **FINDING 9:** `FINDING 9 boot-fixed: <list>` naming every BOOT setting and how it is handled.
- **FINDING 10:** `FINDING 10 consistency: empty` — a diff between the implementation's hot-swap setting list and the spike's HOT set, shown to be empty.
- **FINDING 11:** `FINDING 11 tests: <summary>` from the passing test run.
- **Final stdout line, exactly:** `POOL-COLLAPSE OK`

## Final plan output

End your plan with a ready-to-paste `/goal` line as its last section, embedding the criteria above. Suggested:

```
/goal Run the spike then implement the pool collapse in agent-garrison. Complete only when the transcript contains: FINDING S1..S6 each with a HOT/BOOT/N-A verdict, the command used, and before->after for model, effort, permission-mode, allowed-tools, mcp-servers, and system-prompt; FINDING 7 showing exactly one generic warm-pool definition; FINDING 8 checkout-concretisation: PASS; FINDING 9 boot-fixed listing every BOOT setting and its handling; FINDING 10 consistency: empty (implementation hot-swap set equals spike HOT set); FINDING 11 tests with a passing summary; and a final stdout line that is exactly: POOL-COLLAPSE OK. Constraints: PTY-everywhere, no claude -p, no Agent SDK against Anthropic. Reconfigure sessions only at checkout, never mid-task.
```

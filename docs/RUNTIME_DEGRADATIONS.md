# Runtime degradations (non-Claude primaries)

GARRISON-MARATHON-V1 / WS2 slice S2d. What is **advisory or absent** when the
primary runtime is not Claude Code. The rule: the enforcement plane degrades to
advisory on a non-Claude primary, and every degradation is **recorded, never
silent**. Companion to the per-cell [`RUNTIME_MATRIX.md`](./RUNTIME_MATRIX.md)
(which records the health/action results); this file records the *capability*
degradations behind those cells, derived from the gateway's three
Claude-specific mechanisms (FINDING-E4) plus the matrix run.

The three-runtime split is a **control plane vs enforcement plane** distinction:
routing, prompt assembly, and delegation (the control plane) are runtime-agnostic
and work on every primary; the mechanisms that *enforce* mid-session control
(the enforcement plane) are Claude-PTY-specific and degrade to advisory
elsewhere.

## Capability degradations

| Behavior | claude-code | codex / gemini / opencode / agent-sdk | Why it degrades |
|---|---|---|---|
| **Interactive turn path** — mid-session model/effort change | full: slash-inject `/model` + `/effort` into the live PTY | advisory: the change is applied through `adapter.setModel`/`setEffort` at the *turn boundary* (the `adapter-moves` path), not mid-stream; a primary whose adapter lacks those methods logs `route-switch-skipped` and stays launch-fixed | Stage-B slash-inject writes keystrokes into a Claude PTY (`writeKeys`); non-PTY primaries have no keystroke channel, so an in-flight turn can't be redirected. Full non-PTY turn wiring is the P8 follow-up. |
| **Resume** | `--continue` + a context-carryover preamble | adapter-native resume: `codex exec resume`, opencode `-s <sessionId>`, agent-sdk SDK `sessionId` | Claude's PTY resume is `--continue`; each other runtime re-attaches by its own session id — equivalent intent, different mechanism. |
| **Classifier session** | cheapest claude-code haiku warm session | claude-code haiku *when resolvable* (default, byte-identical); only a box with claude-code genuinely absent falls back to the primary adapter, logging `classifier-fallback` | Classification is pinned to the cheapest available model. When claude-code is installed (the norm) the classifier stays there regardless of primary; the fallback only fires when it truly can't. |
| **Enforcement hooks** (PostToolUse, gate hooks that assume Claude Code hook events) | enforced by the runtime | advisory: the same policy is guidance in the assembled prompt, not a hard event-driven gate | Claude Code's hook mechanism (PostToolUse etc.) is Claude-specific; on other primaries the policy is delivered as prompt guidance, not enforced by a hook the runtime fires. |

## Environment degradations (this box; not code defects)

- **`gemini-runtime` — unauthed on this box.** The Gemini CLI is present
  (`bridge --probe` = ok) but no Gemini credentials are configured, so a real
  authenticated delegate turn cannot run on any primary. A credentialed box
  resolves it.
- **Small-local-model quality (`opencode-runtime` delegate over ollama
  `qwen2.5:3b`).** The bill-free local default trades instruction-following
  precision for cost; under concurrent ollama load it can emit only lifecycle
  events with no text, and the adapter **fails loud** (never fabricates). It
  passes isolated and in the un-contended `codex` column — a load/quality
  artifact, not an adapter bug. A larger local model or a keyed provider
  restores precision.

## UI surfacing

Wherever a Fitting whose capability degrades is shown while a **non-Claude
primary** is the active runtime, Garrison renders an inline "advisory on
`<primary>`" notice linking here (see `RuntimeDegradationNotice` in the compose
surface). The notice never blocks — it states what is advisory vs enforced so
the operator knows the difference at a glance.

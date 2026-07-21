// runtime-degradations.ts — the enforcement-plane capability degradations that
// apply when the active primary runtime is NOT Claude Code (WS2 slice S2d).
// The doctrine lives in docs/RUNTIME_DEGRADATIONS.md; this is the machine-readable
// list the UI surfaces so a degraded capability is never silent on a non-Claude
// primary. Pure data + a pure selector — no I/O.

export interface RuntimeDegradation {
  /** The capability that degrades. */
  behavior: string;
  /** What it becomes on a non-Claude primary. */
  advisory: string;
  /** One line on the mechanism behind the degradation. */
  why: string;
}

// Derived from FINDING-E4 (the gateway's three Claude-specific mechanisms) plus
// the S2c matrix run. Claude Code is the reference; these are what a non-Claude
// primary loses or gets in advisory form.
export const ENFORCEMENT_DEGRADATIONS: readonly RuntimeDegradation[] = [
  {
    behavior: "Mid-session model/effort change",
    advisory: "applied at the turn boundary via the adapter, not mid-stream",
    why: "Stage-B slash-inject writes keystrokes into a Claude PTY; a non-PTY primary has no keystroke channel."
  },
  {
    behavior: "Resume",
    advisory: "adapter-native (codex resume / opencode -s / SDK sessionId), not --continue",
    why: "Each runtime re-attaches by its own session id — same intent, different mechanism."
  },
  {
    behavior: "Enforcement hooks (PostToolUse and gate hooks)",
    advisory: "delivered as prompt guidance, not a hard event-driven gate",
    why: "Claude Code's hook mechanism is Claude-specific; elsewhere the policy is advisory, not enforced."
  }
] as const;

export const CLAUDE_CODE_ENGINE = "claude-code";

/** True when the enforcement plane degrades to advisory for this engine. */
export function isEnforcementDegraded(engine: string | null | undefined): boolean {
  return (engine ?? CLAUDE_CODE_ENGINE) !== CLAUDE_CODE_ENGINE;
}

/** The degradations in force for an engine ([] on claude-code). */
export function degradationsForEngine(engine: string | null | undefined): readonly RuntimeDegradation[] {
  return isEnforcementDegraded(engine) ? ENFORCEMENT_DEGRADATIONS : [];
}

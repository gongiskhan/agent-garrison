// One-shot pending slot + live event bus for cross-fitting navigation actions.
// WorktreeView calls dispatchLaunchClaude; WorkbenchPanel switches tabs;
// TrenchesPanel consumes the launch (on mount OR live if already mounted).

export interface LaunchClaudePayload {
  path: string;
  target: string; // "local" | "outpost:<name>" | "ssh:<name>"
  continueSession?: boolean;
}

const GARRISON_LAUNCH_CLAUDE = "garrison:launch-claude";

let pendingLaunch: LaunchClaudePayload | null = null;

export function dispatchLaunchClaude(path: string, target: string, continueSession?: boolean): void {
  pendingLaunch = { path, target, continueSession };
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(GARRISON_LAUNCH_CLAUDE, { detail: { path, target, continueSession } })
    );
  }
}

// Take and clear the pending slot. Called by TrenchesPanel on mount (when
// the tab was switched to it) or by the live listener (when already mounted).
export function consumePendingLaunch(): LaunchClaudePayload | null {
  const p = pendingLaunch;
  pendingLaunch = null;
  return p;
}

// Subscribe to live launch events. Returns an unsubscribe fn.
// Does NOT clear the pending slot — callers are responsible for that.
export function onLaunchClaude(
  handler: (payload: LaunchClaudePayload) => void
): () => void {
  function listener(ev: Event) {
    handler((ev as CustomEvent<LaunchClaudePayload>).detail);
  }
  window.addEventListener(GARRISON_LAUNCH_CLAUDE, listener);
  return () => window.removeEventListener(GARRISON_LAUNCH_CLAUDE, listener);
}

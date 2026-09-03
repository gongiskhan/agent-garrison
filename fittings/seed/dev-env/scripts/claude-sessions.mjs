// Lifted into @garrison/claude-pty (2026-09) so remote-shell-runtime's local
// shells lister can read the same live registry / transcript store without a
// fitting-to-fitting import. Kept here as a re-export so every existing
// import path in this fitting (and its tests) keeps working unchanged.
export {
  readLiveRegistry,
  listHistory,
  isInternalCwd,
  listBackgroundAgents
} from "@garrison/claude-pty/claude-sessions.mjs";

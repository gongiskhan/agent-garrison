// Lifted into @garrison/claude-pty (2026-09); re-exported here for the same
// reason as claude-sessions.mjs.
export type {
  LiveSession,
  HistoryEntry,
  BackgroundAgent
} from "@garrison/claude-pty/claude-sessions.d.mts";
export {
  readLiveRegistry,
  listHistory,
  isInternalCwd,
  listBackgroundAgents
} from "@garrison/claude-pty/claude-sessions.d.mts";

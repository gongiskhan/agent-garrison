// @garrison/claude-pty — drive the interactive Claude Code TUI under node-pty
// + @xterm/headless. Garrison's single substrate for talking to the model.
//
// Ported from the production module in ekoa-core
// (src/backends/claude-code-pty/ + src/sandbox/pty.ts), dropped to plain ESM,
// macOS-local (no bwrap), with a Signal-C command fast path, an auth-trap
// fast-fail, a streaming onEvent hook, and test env overrides
// (GARRISON_CLAUDE_PROJECTS_DIR / GARRISON_CLAUDE_CONFIG_PATH).

export { spawnClaudePty, getCursorPosition, getLastRows, getScreenRows } from "./pty.mjs";
export {
  jsonlFileSize,
  readJsonlFrom,
  parseTurn,
  parseEvents,
  emptyTurn,
  extractLocalCommandOutput,
  extractAskUserQuestions,
} from "./jsonl.mjs";
export {
  waitForCompletion,
  detectPromptReady,
  stripAnsi,
  listJsonlFiles,
  findNewestJsonl,
  isCommandMessage,
} from "./detection.mjs";
export { waitForSessionReady, AuthTrapError } from "./readiness.mjs";
export { preTrustCwd } from "./trust.mjs";
export {
  captureLines,
  extractReply,
  extractLatestAssistant,
  parseStatus,
  parsePermissionMode,
  isBusy,
  isWorking,
  isPromptReady,
  turnStarted,
  waitForTurnComplete,
} from "./screen.mjs";
export {
  enumerateCommands,
  enumerateCommandsCached,
  BUILTIN_COMMANDS,
} from "./commands.mjs";
export {
  openRichStream,
  richStatus,
  keySequence,
  cycleMode,
} from "./rich-stream.mjs";
export { OperativePtySession, oneShotTurn, buildClaudeArgs } from "./session.mjs";
export { PtySessionManager } from "./session-manager.mjs";
export { WarmPtySessionPool, measureIdleCost } from "./warm-pool.mjs";
export { ClaudeCodeAdapter, runAdapterConformance, ADAPTER_METHODS } from "./runtime-adapter.mjs";
export { delegate, validateTaskSpec, parseTaskSpec, validateDelegationResult, DelegationError } from "./runtime-bridge.mjs";
export { MultiRuntimePool } from "./multi-runtime-pool.mjs";
export { claudeProjectDirForCwd, claudeProjectsDir, claudeGlobalConfigPath } from "./paths.mjs";

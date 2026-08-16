export {
  ClaudeChat,
  applyGeneratedTurn,
  applyInputLifecycle,
  applySessionEvent,
  applyTurnActive,
  buildSendMeta,
  canonicalAssistantReply,
  findGeneratedTurnIndex,
  inputLifecycleAnnouncement,
  isActiveInputState,
  isPendingInputState,
  legacyAssistantFallback,
  liveSessionAnnouncement,
  mergeRouteAttribution,
  QuestionBlock,
  resolvedAssistantText,
  rewriteRouteForHost,
} from "./ClaudeChat";
export type { GeneratedTurnCoordinate, GeneratedTurnState, SessionEventTurn } from "./ClaudeChat";
export { FailureNotice, SessionEventTimeline, SessionStream } from "./SessionTranscript";
export type { SessionEventTimelineProps, SessionStreamProps } from "./SessionTranscript";
export {
  collectRelatedTasks,
  hasVisibleSessionActivity,
  isFailureInfo,
  isSessionEvent,
  isFanoutTool,
  latestBlocksByToolUse,
  mergeSessionEvents,
  parseToolInput,
  sessionEventTerminalText,
  sessionThinkingSummary,
  sessionToolSummary,
} from "./journal";
export type {
  FailureInfo,
  FailureKind,
  FailureSource,
  PermissionAnswer,
  PermissionDecision,
  PermissionRequestBlock,
  PermissionRequestStatus,
  RelatedTask,
  RelatedTaskStatus,
  SessionBlock,
  SessionErrorBlock,
  SessionEvent,
  SessionImage,
  SessionRateLimitBlock,
  SessionRetryBlock,
  SessionRouteAttribution,
  SessionRouteBlock,
  SessionTurnEndBlock,
} from "./journal";
export type { ClaudeChatProps, ChatFeatures, ComposerAdornmentApi } from "./ClaudeChat";
export { ChatTransportError, createHttpTransport, isChatInputReceipt } from "./transport";
export { createVoiceClient } from "./voice";
export type { VoiceClient, VoiceHealth } from "./voice";
export { sanitizeAssistantBadges, sanitizeAssistantText, routeChipLabel, routeChipFromAttribution } from "./sanitize";
export type { SanitizedReply, AssistantRouteMeta } from "./sanitize";
export { railBadges, effortState } from "./run-context";
export type { RailBadge, RailBadgeTone, EffortState } from "./run-context";
// The Turn Rail's option/pin surface. Exported because a HOST supplies the option
// lists (it owns the fetch and the persistence, the package never fetches), so a
// host that cannot import RailOptions ends up hand-declaring a structurally
// identical interface that then drifts from this one.
export { AttributionRail, railDisplayBadges, menuForField } from "./AttributionRail";
export type {
  AttributionRailProps,
  RailOptions,
  RailTargetOption,
  RailDutyOption,
  RailAccountOption,
  RailDisplayBadge,
  RailMenu,
  RailMenuRow,
  PinField,
  PinPatch,
} from "./AttributionRail";
export {
  getChatMode,
  setChatMode,
  resolvedChatScheme,
  subscribeChatTheme,
} from "./chat-theme";
export type { ChatThemeMode } from "./chat-theme";
export type {
  ChatTransport,
  ChatErrorEvent,
  ChatEvent,
  ChatFrameCoordinate,
  ChatInputReceipt,
  ChatInputState,
  ChatInterruptRequest,
  ChatInterruptResult,
  ChatSendMeta,
  ClaudeStatus,
  PermissionMode,
  SlashCommand,
  ToolQuestion,
  ToolQuestionOption,
  QuestionAnswer,
  RouteAttribution,
  TurnRouting,
  UploadedAttachment,
} from "./transport";

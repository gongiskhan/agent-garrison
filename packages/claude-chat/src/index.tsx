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
export {
  FailureNotice,
  renderTranscriptMarkdown,
  SessionEventTimeline,
  SessionStream,
  trapDialogTab,
  useModalLifecycle,
} from "./SessionTranscript";
export type { SessionEventTimelineProps, SessionStreamProps } from "./SessionTranscript";
// The conversation surface: the append-only stream as the body, its search/jump
// loop, and the payload viewer a ledger row opens. `PayloadOpenerContext` is
// exported because a host that renders a transcript OUTSIDE ConversationView can
// still light up its ledger references by providing one.
export { ConversationView, conversationEventId } from "./ConversationView";
export type { ConversationViewProps, ConversationSearchHit } from "./ConversationView";
export { PayloadModal } from "./PayloadModal";
export type { PayloadModalProps } from "./PayloadModal";
export { PayloadOpenerContext, payloadKindFromName } from "./payload-context";
export type { PayloadKind, PayloadTarget } from "./payload-context";
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
export { createVoiceClient, chunkSpeech, chunkCharsFor, DEFAULT_CHUNK_CHARS } from "./voice";
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
export { RoutingModal, resolvedPlanForPins, runtimeGroups, joinPhasesOn } from "./RoutingModal";
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
  ChatEffort,
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

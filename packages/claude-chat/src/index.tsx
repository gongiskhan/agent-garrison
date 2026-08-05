export { ClaudeChat, buildSendMeta, QuestionBlock, rewriteRouteForHost } from "./ClaudeChat";
export { SessionStream } from "./SessionTranscript";
export type { SessionStreamProps } from "./SessionTranscript";
export {
  collectRelatedTasks,
  isFanoutTool,
  latestBlocksByToolUse,
  mergeSessionEvents,
  parseToolInput,
  sessionThinkingSummary,
  sessionToolSummary,
} from "./journal";
export type {
  RelatedTask,
  RelatedTaskStatus,
  SessionBlock,
  SessionEvent,
  SessionImage,
} from "./journal";
export type { ClaudeChatProps, ChatFeatures, ChatSendMeta, ComposerAdornmentApi } from "./ClaudeChat";
export { createHttpTransport } from "./transport";
export { createVoiceClient } from "./voice";
export type { VoiceClient, VoiceHealth } from "./voice";
export { sanitizeAssistantText, routeChipLabel, routeChipFromAttribution } from "./sanitize";
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
  ChatEvent,
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

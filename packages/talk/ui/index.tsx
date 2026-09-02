// Public UI surface of @garrison/talk. Hosts render <TalkApp/> and import
// ./styles.css; nothing else in ui/ is a stable entry point.
import { TalkApp } from "./app";

export { TalkApp, type TalkAppProps } from "./app";
export { VoiceConversation, type VoiceConversationProps } from "./voice-conversation";
export { RecordButton, describeRecordError, type CaptureBridge, type CaptureBridgeStatus, type RecordButtonProps } from "./record-button";
export default TalkApp;

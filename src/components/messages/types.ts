import type { Message as StoredMessage, Conversation as StoredConversation } from '../../../packages/messages/types';
export type { Participant, Attachment, SystemAction, Filter, View } from '../../../packages/messages/types';
export type { ProviderDescriptor as Provider } from '../../../packages/messages/types';
export type Conversation = StoredConversation;
export type Message = StoredMessage & { pending?: boolean; failed?: boolean };
export type ConversationRow = StoredConversation & { lastMessage: Message };

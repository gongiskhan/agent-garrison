export type ProviderKind = 'system' | 'mail' | 'chat';
export interface Participant { id: string; name: string; address?: string; isMe: boolean; avatarPath?: string }
export interface Conversation {
  id: string; provider: string; account: string; externalId: string | null;
  kind: 'dm' | 'group' | 'channel' | 'thread' | 'mail-thread' | 'system';
  title: string; participants: Participant[]; lastMessageTs: string; unreadCount: number;
  muted: boolean; pinned: boolean; archived: boolean; parentConversationId: string | null;
  lastMessage?: Message;
}
export interface Attachment {
  id: string; kind: 'image' | 'audio' | 'file'; name: string; mime: string; size: number;
  path: string | null; thumbPath: string | null; playbackPath: string | null;
  durationMs: number | null; transcript: string | null;
  transcriptStatus: 'none' | 'pending' | 'done' | 'failed';
  transcriptError?: string; width?: number; height?: number; externalRef?: string; ownerNode?: string;
}
export interface ActionTarget {
  ownerNode?: string; conversationId?: string; questionId?: string; approvalId?: string; cardId?: string;
  proposalId?: string; expectedRev?: number; outboxId?: string;
}
export interface SystemAction {
  kind: 'question' | 'approval' | 'revert' | 'info' | 'cancel-send';
  prompt: string; options: string[] | null; answeredAt: string | null; answer: string | null;
  revertUntil: string | null; target?: ActionTarget;
}
export interface Message {
  id: string; provider: string; account: string; conversationId: string; externalId: string | null;
  direction: 'in' | 'out'; sender: Participant; recipients: Participant[];
  subject: string | null; bodyText: string; bodyMarkdown: string | null; bodyHtmlPath: string | null;
  attachments: Attachment[]; ts: string; receivedTs: string; read: boolean; archived: boolean;
  deleted: boolean; starred: boolean; labels: string[]; category: string | null;
  severity: 'info' | 'warning' | 'error' | null; action: SystemAction | null;
  cardId: string | null; conversationRef: string | null; triage: null; rawPath: string | null;
  suppressNotification?: boolean; reactions?: { name: string; count: number; users?: string[] }[];
  deepLink?: string; ownerNode?: string; htmlOwnerNode?: string; rawOwnerNode?: string; sourceLink?: string; mirrorTargets?: string[]; sendStatus?: OutboxItem['status'];
}
export interface Filter {
  text?: string; providers?: string[]; accounts?: string[]; kinds?: ProviderKind[];
  unread?: boolean; actionable?: boolean; starred?: boolean; hasAttachments?: boolean;
  attachmentKind?: 'image' | 'audio' | 'file'; from?: string; conversationId?: string;
  labels?: string[]; categories?: string[]; severity?: ('info' | 'warning' | 'error')[];
  direction?: 'in' | 'out'; dateFrom?: string; dateTo?: string; archived?: boolean; deleted?: boolean;
}
export interface View { id: string; name: string; icon: string; filter: Filter; order: number; builtIn: boolean }
export type RuleAction = { type: 'markRead' | 'archive' | 'star' | 'mute' | 'suppressNotification' }
  | { type: 'label'; label: string } | { type: 'createCard'; project?: string; flow?: string };
export interface Rule {
  id: string; name: string; enabled: boolean; order: number;
  match: Filter & { subjectContains?: string; bodyContains?: string; senderIs?: string[] };
  actions: RuleAction[]; stopProcessing: boolean; matchedCount: number; lastMatchedAt: string | null;
}
export interface OutboxItem {
  id: string; provider: string; account: string;
  to: { conversationId?: string; address?: string; jid?: string; channel?: string; cc?: string; subject?: string };
  body: { markdown: string }; attachments: { path: string; name: string; mime: string; asVoiceNote?: boolean }[];
  replyToExternalId: string | null; origin: 'user' | 'agent'; holdUntil: string;
  status: 'held' | 'sending' | 'sent' | 'failed' | 'cancelled'; error: string | null;
  externalReceipt?: {id:string;executeAt?:string};
}
export interface ProviderDescriptor {
  id: string; kind: ProviderKind; label: string; badge: { text: string; color: string; glyph: string };
  accounts: { id: string; label: string; address?: string }[];
  capabilities: { read: true; send: boolean; reply: boolean; markRead: boolean; archive: boolean;
    delete: boolean; groups: boolean; threads: boolean; attachments: boolean; audioReceive: boolean;
    audioSend: boolean; markdown: boolean; code: boolean; reactionsRead: boolean; openInProvider: boolean };
  sync: { mode: 'poll' | 'stream'; intervalSeconds?: number }; setupHint: string | null;
  callbackBaseUrl?: string; ownerNode?: string; lastSync?: string; health?: { ok: boolean; reason?: string };
  retentionDays?: number; sendReadReceipts?: boolean; holdSeconds?: number; deleteWindowSeconds?: number;
  managesAgentHold?: boolean;
  inboundStateFields?: ('read'|'archived'|'deleted'|'starred'|'labels')[];
}
export type SyncCursor = Record<string, unknown>;
export interface ProviderReadAdapter {
  listConversations(account: string, since: string | null): Promise<Conversation[]>;
  fetchMessages(account: string, cursor: SyncCursor | null): Promise<{ messages: Message[]; conversations: Conversation[]; cursor: SyncCursor }>;
  downloadAttachment(account: string, ref: string, dest: string): Promise<{ mime: string; size: number }>;
  fromProviderText(raw: unknown): { text: string; markdown: string | null };
  health(account: string): Promise<{ ok: boolean; reason?: string }>;
}
export interface ProviderAdapter extends ProviderReadAdapter {
  setRead(account: string, messageExternalIds: string[], read: boolean): Promise<void>;
  archive?(account: string, conversationExternalId: string): Promise<void>;
  delete?(account: string, messageExternalId: string): Promise<void>;
  send(item: OutboxItem): Promise<{ externalId: string }>;
  toProviderText(markdown: string): string;
  deepLink?(conversation: Conversation, message?: Message): string;
}

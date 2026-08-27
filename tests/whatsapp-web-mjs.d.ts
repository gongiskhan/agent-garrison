// whatsapp-web's lib/*.mjs + scripts/server.mjs are plain JS Fitting modules
// (see tests/connector-mjs.d.ts for the sibling connector.mjs convention,
// which already covers scripts/connector.mjs via its own wildcard). These
// ambient declarations give the TS tests types so tsc --noEmit doesn't flag
// the JS imports as implicit-any.
declare module "*/whatsapp-web/lib/jid.mjs" {
  export function isValidJid(value: unknown): boolean;
  export function assertValidJid(value: unknown, label?: string): void;
}

declare module "*/whatsapp-web/lib/contacts.mjs" {
  export class ContactIndex {
    byJid: Map<string, { jid: string; name: string }>;
    readonly size: number;
    upsert(jid: string | undefined, name: string | undefined): void;
    resolve(query: unknown, limit?: number): Array<{ name: string; jid: string }>;
  }
}

declare module "*/whatsapp-web/lib/store.mjs" {
  export interface WhatsAppMessage {
    id: string;
    chatJid: string;
    chatName?: string;
    fromMe?: boolean;
    sender?: string;
    body: string;
    timestamp: number;
    type?: string;
  }
  export class MessageStore {
    dir: string;
    file: string;
    maxRecent: number;
    recent: WhatsAppMessage[];
    lastByChat: Map<string, WhatsAppMessage>;
    constructor(sessionDir: string, opts?: { maxRecent?: number });
    append(message: WhatsAppMessage): void;
    recentMessages(n?: number): WhatsAppMessage[];
    lastForChat(chatJid: string): WhatsAppMessage | null;
  }
}

declare module "*/whatsapp-web/lib/pacing.mjs" {
  export function randomDelayMs(minMs: number, maxMs: number): number;
  export class SendQueue {
    constructor(opts?: { minDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> });
    enqueue<T>(task: () => Promise<T>): Promise<T>;
  }
}

declare module "*/whatsapp-web/scripts/server.mjs" {
  import type http from "node:http";
  export function parseArgs(argv?: string[]): {
    port: number;
    host: string;
    sessionDir: string;
    gatewayUrl: string;
    minSendDelayMs: number;
    maxSendDelayMs: number;
  };
  export function isLoopbackAddr(addr: unknown): boolean;
  export function extractMessageText(message: unknown): string;
  export interface MessageBus {
    publish(event: unknown): void;
    subscribe(fn: (event: unknown) => void): () => void;
    readonly size: number;
  }
  export function createMessageBus(): MessageBus;
  export const WA_SENT_ACK_STATUS: number;
  export interface OutboundPulse {
    chatJid: string | null;
    chatName: string | null;
    preview: string;
    timestamp: number;
  }
  export function createOutboundAckTracker(opts?: {
    maxEntries?: number;
    maxAgeMs?: number;
    now?: () => number;
  }): {
    trackPending(entry: OutboundPulse & { id: string }): void;
    takeAcked(id: string): OutboundPulse | null;
    readonly size: number;
  };
  export function createAvatarResolver(opts: {
    getProfilePictureUrl?: (jid: string, kind?: string) => unknown;
    timeoutMs?: number;
    ttlMs?: number;
    negativeTtlMs?: number;
    maxEntries?: number;
    now?: () => number;
  }): {
    lookup(jid: string | undefined | null): Promise<string | null>;
    readonly size: number;
  };
  export function buildConnectionManager(opts: Record<string, unknown>): {
    init(): Promise<void>;
    requestPairingCode(phoneNumber: string): Promise<string>;
    sendText(jid: string, body: string): Promise<{ id: string | null }>;
    status(): { paired: boolean; connected: boolean; connecting: boolean; phone: string | null };
    close(): Promise<void>;
  };
  export function createOutboxSender(connectionManager: {
    sendText(jid: string, body: string): Promise<unknown>;
  }): (entry: any) => Promise<unknown>;
  export function createApp(opts: {
    connectionManager: {
      status(): unknown;
      requestPairingCode(phoneNumber: string): Promise<string>;
      sendText(jid: string, body: string): Promise<unknown>;
    };
    store: unknown;
    contactIndex: unknown;
    messageBus?: MessageBus;
    outbox?: unknown;
    port: number;
    host: string;
    log?: (...args: unknown[]) => void;
  }): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  export function startServer(opts?: Record<string, unknown>): Promise<{
    server: http.Server;
    connectionManager: unknown;
    store: unknown;
    contactIndex: unknown;
  }>;
}

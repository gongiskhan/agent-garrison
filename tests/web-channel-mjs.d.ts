// Ambient types for the Web Channel fitting's plain-JS (.mjs) lib modules so the
// TS tests can import them under tsc --noEmit without implicit-any errors.
declare module "*/talk/src/threads.mjs" {
  interface ThreadMeta {
    id: string;
    /** The conversation this thread IS the channel surface of - derived from the
     *  id, never read back from the file (threads.mjs conversationIdFor). */
    conversationId: string | null;
    title: string;
    source: string;
    createdAt: string | null;
    updatedAt: string | null;
    messageCount: number;
  }
  // Run-context extras (docs/decisions/2026-07-25-web-channel-run-context.md):
  // `route` is the resolved RunAttribution of the assistant turn, `overrides` the
  // pinned intent that was in force on the user turn, and `routing` the thread's
  // mutable pin. All three are whitelist-sanitized on write, so these are `unknown`
  // here on purpose - the authoritative shapes live in @garrison/claude-chat.
  interface ThreadMessage {
    role: "user" | "assistant";
    text: string;
    ts?: string;
    route?: unknown;
    overrides?: unknown;
  }
  interface Thread extends ThreadMeta {
    mode: string | null;
    context?: unknown;
    messages: ThreadMessage[];
    claudeSessionId?: string | null;
    routing?: unknown;
    messageKeys?: string[];
  }
  export function safeThreadId(raw: unknown): string | null;
  export function conversationIdFor(thread: unknown): string | null;
  export function newThreadId(): string;
  export function listThreads(): Promise<ThreadMeta[]>;
  export function getThread(id: string): Promise<Thread | null>;
  export function getThreadSnapshot(id: string): Promise<{
    thread: Thread;
    pendingInputs: Array<Record<string, unknown>>;
    inputRevision: number;
  } | null>;
  export function ensureThread(opts: { id?: string; title?: string; source?: string; mode?: string; context?: unknown; nowIso?: string }): Promise<Thread>;
  export function appendMessages(id: string, messages: ThreadMessage[], opts?: { nowIso?: string; idempotencyKey?: string }): Promise<ThreadMeta>;
  export function deleteThread(id: string): Promise<boolean>;
  export function threadExistsSync(id: string): boolean;
  export function setThreadSession(id: string, sessionId: string): Promise<ThreadMeta | null>;
  export function setThreadRouting(id: string, routing: unknown, opts?: { nowIso?: string }): Promise<Thread | null>;
  export function sanitizeRouteMeta(raw: unknown): Record<string, unknown> | null;
  export function sanitizeRouting(raw: unknown): Record<string, unknown> | null;
  export function _threadsDirForTest(): string;
  export function _readThreadSync(id: string): Thread | null;
}

declare module "*/talk/ui/pwa-assets.mjs" {
  export function renderIconPng(size: number): Buffer;
  export function iconSvg(size?: number): string;
  export function emitPwaAssets(opts: { srcDir: string; distDir: string }): Promise<string[]>;
  export const PWA_DIST_ASSETS: string[];
}

declare module "*/talk/src/webpush.mjs" {
  export function b64url(buf: Uint8Array | Buffer): string;
  export function unb64url(str: string): Buffer;
  export function generateVapidKeys(): { publicKey: string; privateKey: string };
  export function vapidAuthorization(args: {
    audience: string;
    subject: string;
    publicKey: string;
    privateKey: string;
    expirySeconds?: number;
    now?: () => number;
  }): string;
  export function encryptPayload(args: {
    payload: string;
    p256dh: string;
    auth: string;
    salt?: Buffer;
    senderKeys?: { privateKey: string } | null;
  }): Buffer;
  export function decryptPayload(args: {
    body: Buffer;
    uaPrivateKey: string;
    uaPublicKey: string;
    auth: string;
  }): string;
  export function sendPush(args: {
    subscription: { endpoint: string; keys?: { p256dh?: string; auth?: string } };
    payload: string;
    vapid: { subject: string; publicKey: string; privateKey: string };
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; status: number; gone: boolean; error?: string }>;
}

declare module "*/talk/src/push-store.mjs" {
  interface PushSubscriptionRow {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    label: string | null;
    createdAt: string;
  }
  export function subscriptionsFile(env?: Record<string, string | undefined>): string;
  export function readSubscriptions(env?: Record<string, string | undefined>): PushSubscriptionRow[];
  export function saveSubscription(
    subscription: { endpoint?: string; keys?: { p256dh?: string; auth?: string } },
    env?: Record<string, string | undefined>,
    opts?: { label?: string | null; at?: string }
  ): PushSubscriptionRow[];
  export function removeSubscription(endpoint: string, env?: Record<string, string | undefined>): number;
  export function vapidFromEnv(
    env?: Record<string, string | undefined>
  ): { publicKey: string; privateKey: string; subject: string } | null;
}

// The talk router (.mjs): only the voice surface is declared, for
// tests/talk-voice-router.test.ts.
declare module "*/talk/src/router.mjs" {
  export function garrisonDir(): string;
  export const STATUS_ROOT: string;
  export const VOICE_NO_PROVIDER: string;
  export const VOICE_NOT_RUNNING: string;
  export const VOICE_LOCKED: string;
  export const VOICE_TOKEN_UNSET: string;
  export const VOICE_TOKEN_DENIED: string;
  export const VOICE_SECRETS_UNREACHABLE: string;
  export const VOICE_REST_DISABLED: string;
  export const VOICE_UNREACHABLE: string;
  export function readVoiceInfo(fittingId: unknown): { url?: string; [k: string]: unknown } | null;
  export function createTalkRouter(
    liveOpts: {
      gatewayUrl?: string;
      voice?: { fittingId?: () => unknown; token?: () => unknown; tokenReason?: () => unknown; vaultLocked?: () => unknown } | undefined;
      [k: string]: unknown;
    },
    opts?: { distDir?: string | null; log?: unknown }
  ): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<boolean>;
}

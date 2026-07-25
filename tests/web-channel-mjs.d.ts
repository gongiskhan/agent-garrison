// Ambient types for the Web Channel fitting's plain-JS (.mjs) lib modules so the
// TS tests can import them under tsc --noEmit without implicit-any errors.
declare module "*/web-channel-default/scripts/threads.mjs" {
  interface ThreadMeta {
    id: string;
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
  }
  export function safeThreadId(raw: unknown): string | null;
  export function newThreadId(): string;
  export function listThreads(): Promise<ThreadMeta[]>;
  export function getThread(id: string): Promise<Thread | null>;
  export function ensureThread(opts: { id?: string; title?: string; source?: string; mode?: string; context?: unknown; nowIso?: string }): Promise<Thread>;
  export function appendMessages(id: string, messages: ThreadMessage[], opts?: { nowIso?: string }): Promise<ThreadMeta>;
  export function deleteThread(id: string): Promise<boolean>;
  export function threadExistsSync(id: string): boolean;
  export function setThreadSession(id: string, sessionId: string): Promise<ThreadMeta | null>;
  export function setThreadRouting(id: string, routing: unknown, opts?: { nowIso?: string }): Promise<Thread | null>;
  export function sanitizeRouteMeta(raw: unknown): Record<string, unknown> | null;
  export function sanitizeRouting(raw: unknown): Record<string, unknown> | null;
  export function _threadsDirForTest(): string;
  export function _readThreadSync(id: string): Thread | null;
}

declare module "*/web-channel-default/ui/pwa-assets.mjs" {
  export function renderIconPng(size: number): Buffer;
  export function iconSvg(size?: number): string;
  export function emitPwaAssets(opts: { srcDir: string; distDir: string }): Promise<string[]>;
  export const PWA_DIST_ASSETS: string[];
}

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
  interface ThreadMessage { role: "user" | "assistant"; text: string; ts?: string }
  interface Thread extends ThreadMeta {
    mode: string | null;
    context?: unknown;
    messages: ThreadMessage[];
  }
  export function safeThreadId(raw: unknown): string | null;
  export function newThreadId(): string;
  export function listThreads(): Promise<ThreadMeta[]>;
  export function getThread(id: string): Promise<Thread | null>;
  export function ensureThread(opts: { id?: string; title?: string; source?: string; mode?: string; context?: unknown; nowIso?: string }): Promise<Thread>;
  export function appendMessages(id: string, messages: ThreadMessage[], opts?: { nowIso?: string }): Promise<ThreadMeta>;
  export function deleteThread(id: string): Promise<boolean>;
  export function threadExistsSync(id: string): boolean;
}

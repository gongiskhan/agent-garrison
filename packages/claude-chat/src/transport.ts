// Backend-agnostic transport for the rich Claude chat. The gateway (web-channel)
// and dev-env both expose the same /claude/* shape, so a single HTTP transport
// serves both — only the base path differs.

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "unknown";

export interface ClaudeStatus {
  rows: string[];
  mode: PermissionMode;
  contextPct: number | null;
  model: string | null;
  busy?: boolean;
}

export type ChatEvent =
  | { type: "hello"; mode: PermissionMode; status: ClaudeStatus; busy: boolean; assistant: string; screen: string[] }
  | { type: "assistant"; text: string }
  | { type: "status"; rows: string[]; mode: PermissionMode; contextPct: number | null; model: string | null }
  | { type: "turn"; active: boolean }
  | { type: "screen"; lines: string[] }
  | { type: "error"; message: string }
  | { type: "connection"; state: "open" | "closed" | "reconnecting" };

export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "user" | "project" | "skill";
  argumentHint?: string;
}

export interface ChatTransport {
  connect(onEvent: (ev: ChatEvent) => void): () => void; // returns an unsubscribe/close fn
  sendMessage(text: string): Promise<void>;
  sendKey(key: "escape" | "shift-tab" | "up" | "down" | "enter" | "tab" | "ctrl-c"): Promise<void>;
  setMode(mode: PermissionMode): Promise<{ mode: PermissionMode; reached: boolean }>;
  interrupt(): Promise<void>;
  fetchCommands(): Promise<SlashCommand[]>;
}

/** HTTP transport against a `<base>/claude/*` surface (default base "/api"). */
export function createHttpTransport(base = "/api"): ChatTransport {
  const b = base.replace(/\/$/, "");
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`${b}/claude/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json().catch(() => ({}));
  };
  return {
    connect(onEvent) {
      let es: EventSource | null = null;
      let closed = false;
      const open = () => {
        if (closed) return;
        es = new EventSource(`${b}/claude/stream`);
        es.addEventListener("open", () => onEvent({ type: "connection", state: "open" }));
        const on = (name: ChatEvent["type"]) =>
          es!.addEventListener(name, (e: MessageEvent) => {
            try {
              onEvent({ type: name, ...JSON.parse(e.data) } as ChatEvent);
            } catch {
              /* ignore malformed */
            }
          });
        on("hello");
        on("assistant");
        on("status");
        on("turn");
        on("screen");
        on("error");
        es.onerror = () => {
          onEvent({ type: "connection", state: "reconnecting" });
          // EventSource auto-reconnects; if it's permanently closed, retry.
          if (es && es.readyState === EventSource.CLOSED && !closed) {
            es.close();
            setTimeout(open, 1500);
          }
        };
      };
      open();
      return () => {
        closed = true;
        es?.close();
        onEvent({ type: "connection", state: "closed" });
      };
    },
    async sendMessage(text) {
      await post("message", { text });
    },
    async sendKey(key) {
      await post("keys", { key });
    },
    async setMode(mode) {
      return (await post("mode", { mode })) as { mode: PermissionMode; reached: boolean };
    },
    async interrupt() {
      await post("interrupt");
    },
    async fetchCommands() {
      const res = await fetch(`${b}/claude/commands`);
      if (!res.ok) return [];
      const j = await res.json().catch(() => ({ commands: [] }));
      return (j.commands ?? []) as SlashCommand[];
    },
  };
}

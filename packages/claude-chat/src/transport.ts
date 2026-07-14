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

// AskUserQuestion (D28): the operative's interactive picker, surfaced to a
// channel as tappable option buttons. `label` is load-bearing - the answer path
// maps a tapped label back to its option index to drive the TUI picker.
export interface ToolQuestionOption {
  label: string;
  description?: string;
}
export interface ToolQuestion {
  question: string;
  header?: string;
  options: ToolQuestionOption[];
  multiSelect?: boolean;
}
/** How a channel answers an AskUserQuestion: a chosen option label, free text
 *  ("Other…"), or a dismiss. `toolUseId` targets the specific picker. */
export interface QuestionAnswer {
  toolUseId: string;
  label?: string;
  text?: string;
  dismiss?: boolean;
}

/**
 * Per-turn runtime attribution the gateway attaches to a settled turn (the POST
 * /chat response + the /chat/stream `done` SSE frame). Every field is optional /
 * nullable: an older gateway path, or a turn the router could not attribute, sends
 * a subset (or none). The web channel lifts this onto the just-finished turn to
 * render an enriched routing chip. `route` is the resolved target id; `runtime`
 * the execution engine that ran it (e.g. "agent-sdk", "claude-code"); `honored`
 * whether the router honored a client classification hint.
 */
export interface RouteAttribution {
  route?: string | null;
  runtime?: string | null;
  provider?: string | null;
  model?: string | null;
  taskType?: string | null;
  tier?: string | null;
  effort?: string | null;
  ruleId?: string | null;
  profile?: string | null;
  honored?: boolean | null;
}

export type ChatEvent =
  | { type: "hello"; mode: PermissionMode; status: ClaudeStatus; busy: boolean; assistant: string; screen: string[] }
  | { type: "assistant"; text: string }
  | { type: "status"; rows: string[]; mode: PermissionMode; contextPct: number | null; model: string | null }
  | { type: "turn"; active: boolean }
  | { type: "screen"; lines: string[] }
  // Wire fields match the gateway payload (tool_use_id is snake_case on the wire).
  | { type: "tool"; name: string; tool_use_id: string; questions: ToolQuestion[] }
  // Structured runtime attribution for the just-finished turn — the web channel's
  // orchestrator transport emits this from the `done` frame before it idles the turn.
  | ({ type: "route" } & RouteAttribution)
  | { type: "error"; message: string }
  | { type: "connection"; state: "open" | "closed" | "reconnecting" };

export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "user" | "project" | "skill";
  argumentHint?: string;
}

export interface ChatTransport {
  /**
   * The base path this transport posts to (e.g. "/sessions/:id" in dev-env, ""
   * for a root-mounted host). Exposed so sibling same-origin features (voice)
   * can derive their own proxy path under the same prefix. Optional for back-
   * compat with transports that don't set it.
   */
  base?: string;
  connect(onEvent: (ev: ChatEvent) => void): () => void; // returns an unsubscribe/close fn
  sendMessage(text: string): Promise<void>;
  /**
   * Submit a line into the live Claude PTY WITHOUT it being rendered as a user
   * turn in the chat transcript — used for slash commands that drive the TUI
   * directly (e.g. `/model <id>`, `/compact`, `/clear`). Same wire path as
   * sendMessage (POST /claude/message); the distinction is purely client-side
   * (no Turn is appended). Optional so older transports stay valid.
   */
  sendCommand?(text: string): Promise<void>;
  sendKey(key: "escape" | "shift-tab" | "up" | "down" | "enter" | "tab" | "ctrl-c"): Promise<void>;
  setMode(mode: PermissionMode): Promise<{ mode: PermissionMode; reached: boolean }>;
  interrupt(): Promise<void>;
  fetchCommands(): Promise<SlashCommand[]>;
  /**
   * Answer an AskUserQuestion picker the operative raised (a tapped option label,
   * free text, or a dismiss). The gateway drives the live TUI picker via
   * keystrokes. Optional so transports that never surface `tool` events stay valid.
   */
  answerQuestion?(answer: QuestionAnswer): Promise<void>;
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
    base: b,
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
        on("tool");
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
    async sendCommand(text) {
      // Identical wire call to sendMessage; the caller chooses this variant only
      // to suppress the chat-transcript turn. The dev-env server's /message
      // route already does the two-phase (text, pause, Enter) write that the
      // Claude Code TUI needs for a slash command to register.
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
    async answerQuestion(answer) {
      // Posts to <base>/claude/answer (the gateway resolves the picker + drives keys).
      await post("answer", {
        tool_use_id: answer.toolUseId,
        ...(answer.label !== undefined ? { label: answer.label } : {}),
        ...(answer.text !== undefined ? { text: answer.text } : {}),
        ...(answer.dismiss ? { dismiss: true } : {}),
      });
    },
    async fetchCommands() {
      const res = await fetch(`${b}/claude/commands`);
      if (!res.ok) return [];
      const j = await res.json().catch(() => ({ commands: [] }));
      return (j.commands ?? []) as SlashCommand[];
    },
  };
}

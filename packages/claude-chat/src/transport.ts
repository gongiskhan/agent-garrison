// Backend-agnostic transport for the rich Claude chat. The gateway (web-channel)
// and dev-env both expose the same /claude/* shape, so a single HTTP transport
// serves both — only the base path differs.

import {
  isFailureInfo,
  isSessionEvent,
  type FailureInfo,
  type PermissionAnswer,
  type SessionEvent,
} from "./journal";

/** An HTTP/admission failure whose user-facing semantics survive an `Error`
 * boundary without callers parsing message prose. */
export class ChatTransportError extends Error {
  readonly failure: FailureInfo;

  constructor(failure: FailureInfo, message = failure.text) {
    super(message);
    this.name = "ChatTransportError";
    this.failure = failure;
  }
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "unknown";

/** Native Claude Code effort controls accepted by `/effort`. `auto` resets the
 * session to the current model's default; the remaining values pin a level. */
export type ChatEffort = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

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
  /** Policy-requested effort; presence alone does not mean it was honored. */
  effort?: string | null;
  /** True/false when the runtime reported application truth; null when unknown. */
  effortApplied?: boolean | null;
  taskType?: string | null;
  tier?: string | null;
  ruleId?: string | null;
  profile?: string | null;
  honored?: boolean | null;
  // The duties-and-levels vocabulary the router actually resolved against. Known
  // gateway-side since preRouteV4 but never reported to a channel until now.
  duty?: string | null;
  level?: number | null;
  /** The phase inside the duty ladder; often equal to `duty` (see preRouteV4). */
  phase?: string | null;
  /** The duty's skill fitting. Null on every live cell today - composition duties
   *  are defined inline with no skill, so the rail says "skill: none" rather than
   *  hiding the fact. */
  skill?: string | null;
  /** How the route was chosen: a duty-ladder cell, a per-turn override, or the
   *  classifier. */
  via?: "duty-cell" | "turn-override" | "classifier" | string | null;
  /** The flow whose phase plan the run follows, as RESOLVED (a pin when the
   *  user chose one, otherwise whatever the gateway inferred). Reported so the
   *  rail can badge an auto-chosen plan instead of leaving it invisible. */
  flow?: string | null;
  /** Phases turned OFF for the run, comma-separated - see TurnRouting.phasesOff. */
  phasesOff?: string | null;
  /** Phases ADDED beyond the plan, comma-separated - see TurnRouting.phasesOn. */
  phasesOn?: string | null;
  /** True when the router reached a route WITHOUT an LLM classification, because
   *  the pin already carried it. The honest counterpart to `via` - it is what makes
   *  "explicit, so no classifier ran" a reported fact rather than an assumption. */
  classifierSkipped?: boolean | null;
  /** Named runtime account the turn authenticated as. Distinguish absent from
   *  null: undefined = the lane could not report it (badge omitted); null = there
   *  IS no named account, i.e. the machine's own Claude login (a real fact, so it
   *  renders as "machine login"). */
  account?: string | null;
  accountSource?: "override" | "target" | "process" | null;
  /** Dev-root child NAME the turn ran in (not a path - see resolveProjectName). */
  project?: string | null;
  /** Absolute cwd the turn actually ran in; tooltip-only, never a client URL. */
  projectPath?: string | null;
  /** Set when a significant ask was CARDED: the work runs on the board, not here. */
  card?: string | null;
  /** Board URL for `card`. Already host-rewritten by the producer - the browser is
   *  almost never on the Garrison box, so a raw loopback board URL is unusable. */
  cardUrl?: string | null;
  /** The routed runtime's OWN session id, per message (not per thread) - the key
   *  the transcript drill-down passes to GET /api/session-stream. */
  sessionId?: string | null;
  /** Durable runtime-session identity reported on canonical route revisions. */
  sessionEpoch?: string | number | null;
  sessionDisposition?: "new" | "warm" | "resumed" | string | null;
  sessionBoundaryReason?: string | null;
  spawnSignature?: Record<string, unknown> | null;
  transcriptPath?: string | null;
  stoppedByUser?: boolean | null;
  stoppedReason?: string | null;
  // Override bookkeeping. The pinned INTENT (TurnRouting) is kept separate from
  // what actually RAN: a rejected override must read "override rejected: <reason>"
  // rather than silently showing the pin as if it had been honored.
  overridesApplied?: string[] | null;
  overridesRejected?: { field: string; reason: string }[] | null;
  /** True on the pre-turn frame (emitted right after preRoute resolves, so badges
   *  appear ~1s in); absent/false on the frame folded into `done`. */
  pending?: boolean | null;
  /** Monotonic per-send turn number. A frame whose turnSeq is OLDER than the
   *  current turn's is DROPPED - blind "write to the last turn" lands a late frame
   *  on the wrong bubble. */
  turnSeq?: number | null;
}

/**
 * The sparse pinned INTENT for the next turn - what the user asked for, not what
 * ran (that is {@link RouteAttribution}). Rides client -> gateway as
 * `ChatSendMeta.routing` -> `payload.routing` -> `body.routing` -> `hints.routing`.
 *
 * `runtime` and `model` are deliberately NOT independently settable from a menu:
 * there is no model catalog anywhere in the repo (model is free text in every
 * runtime `config_schema`), so a model dropdown would invite invalid pairs like
 * `runtime: gemini` + `model: opus`. A `target` picks runtime+provider+model
 * coherently; `model` stays as a typed escape hatch that overlays only the
 * resolved target's model.
 */
export interface TurnRouting {
  /** A composition `targets[]` id. */
  target?: string | null;
  /** Free-text model override, overlaid on the resolved target. */
  model?: string | null;
  /** low | medium | high | xhigh | max - mirrors `dutyEfforts` in src/lib/types.ts. */
  effort?: string | null;
  duty?: string | null;
  /** Integer 1..9. */
  level?: number | null;
  /** Dev-root child NAME only - absolute paths and any "/" are rejected. */
  project?: string | null;
  account?: string | null;
  /**
   * The compute tier the matrix is keyed on (`T0-trivial` | `T1-standard` |
   * `T2-deep`, from the compiled policy's `tiers`). Pinning it with a `duty`
   * completes the `{taskType, tier}` pair the router needs, which is what lets an
   * explicit choice skip the classifier entirely rather than classifying and then
   * overriding the answer.
   */
  tier?: string | null;
  /**
   * The flow whose phase plan this run follows (`full-feature`, `ui-change`,
   * … from the policy's `flows`). Decides WHICH phases exist for the run; the
   * duty sequence decides their ORDER. Only meaningful for a run that becomes a
   * card - a conversational turn has no pipeline to plan.
   */
  flow?: string | null;
  /**
   * Phases turned OFF for this run, as a comma-separated list of phase ids
   * ("adversarial-review,walkthrough").
   *
   * A CSV of the OFF set rather than an on/off map for two reasons: every pin
   * crosses four separate scalar whitelists (this type, the channel's thread
   * persistence, the gateway's edge validator, and the client compactor), and the
   * OFF set and ON set stay separate scalars so each crosses the whitelists on
   * its own. An OFF phase stays IN the rail rendered off; it is never hidden.
   */
  phasesOff?: string | null;
  /**
   * Phases ADDED for this run beyond the resolved flow's plan, comma-separated
   * ("security-review,walkthrough"). Validated against the policy's GLOBAL
   * phase catalog (that is the point - the plan does not carry them);
   * `railForCard` unions a `true` toggle into the plan, OFF wins a conflict.
   */
  phasesOn?: string | null;
}

/** Client-generated correlation only. The host assigns the durable input id and
 * the runtime assigns the generation id; neither authority is delegated to the
 * browser. Keeping this in the ordinary per-send metadata lets legacy transports
 * ignore it while an orchestrated transport can return an exact receipt. */
export interface ChatSendMeta {
  context?: unknown;
  mode?: string;
  autonomous?: boolean;
  routing?: TurnRouting;
  /** Host-native effort control, carried separately from user-visible text. */
  effort?: ChatEffort;
  clientRequestId?: string;
}

export type ChatInputState =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "settled"
  | "stopped"
  | "failed";

/** Durable admission/lifecycle coordinates returned by an orchestrated host.
 * `generationId` is absent while an accepted input is queued or still starting;
 * exact Stop stays disabled until the runtime publishes it. */
export interface ChatInputReceipt {
  clientRequestId: string;
  inputId: string;
  state: ChatInputState;
  position?: number;
  generationId?: string;
  acceptedAt?: string;
  reason?: string;
  failure?: FailureInfo;
}

const CHAT_INPUT_STATES: ReadonlySet<string> = new Set([
  "queued", "starting", "running", "stopping", "settled", "stopped", "failed",
]);

export function isChatInputReceipt(value: unknown): value is ChatInputReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const optionalText = (key: string, nonEmpty = false) => input[key] === undefined ||
    (typeof input[key] === "string" && (!nonEmpty || Boolean((input[key] as string).trim())));
  return typeof input.clientRequestId === "string" && Boolean(input.clientRequestId.trim()) &&
    typeof input.inputId === "string" && Boolean(input.inputId.trim()) &&
    typeof input.state === "string" && CHAT_INPUT_STATES.has(input.state) &&
    optionalText("generationId", true) && optionalText("acceptedAt") && optionalText("reason") &&
    (input.failure === undefined || isFailureInfo(input.failure)) &&
    (input.position === undefined ||
      (typeof input.position === "number" && Number.isInteger(input.position) && input.position >= 0));
}

/** Coordinates stamped onto every generated chat frame. They stay optional so
 * existing PTY/EventSource transports remain source-compatible. */
export interface ChatFrameCoordinate {
  inputId?: string;
  generationId?: string;
}

/** Exact generated-turn stop. A missing argument is retained only for legacy
 * transports; lifecycle-capable callers always provide the runtime generation. */
export interface ChatInterruptRequest {
  generationId: string;
}

export interface ChatInterruptResult {
  generationId: string;
  state: "stopping" | "stopped" | "settled";
  inputId?: string;
  reason?: string;
}

export type ChatErrorEvent =
  | { type: "error"; failure: FailureInfo; message?: string }
  | { type: "error"; message: string; failure?: undefined };

type ChatEventPayload =
  | { type: "hello"; mode: PermissionMode; status: ClaudeStatus; busy: boolean; assistant: string; screen: string[] }
  | { type: "assistant"; text: string }
  | { type: "session_event"; event: SessionEvent }
  | { type: "status"; rows: string[]; mode: PermissionMode; contextPct: number | null; model: string | null }
  | { type: "turn"; active: boolean }
  | { type: "screen"; lines: string[] }
  // Wire fields match the gateway payload (tool_use_id is snake_case on the wire).
  | { type: "tool"; name: string; tool_use_id: string; questions: ToolQuestion[] }
  // Structured runtime attribution for a turn - emitted TWICE by the web channel's
  // orchestrator transport: once right after the gateway's `preRoute` resolves
  // (`pending: true`) so badges appear early, once folded into the `done` frame.
  // The consumer MERGES the two ({...last.route, ...frame}) so the pre-turn frame
  // is refined, never clobbered, and drops any frame whose `turnSeq` is stale.
  | ({ type: "route" } & RouteAttribution)
  // Tool activity from a routed runtime (the non-primary lanes never streamed, so
  // the conversation sat silent for minutes). Renders into the working hint:
  // "Working 0:42 - Edit". `id` is the tool_use id when the lane reports one.
  // `kind: "thinking"` carries the tail of an extended-thinking block instead of a
  // tool name. Thinking is where a turn spends its silent minutes, so it is the
  // strongest liveness signal the lane has.
  | { type: "activity"; kind: "tool"; name: string; id?: string }
  | { type: "activity"; kind: "thinking"; name: string }
  | ({ type: "input" } & ChatInputReceipt)
  | ChatErrorEvent
  | { type: "connection"; state: "open" | "closed" | "reconnecting" };

export type ChatEvent = ChatEventPayload & ChatFrameCoordinate;

export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "user" | "project" | "skill";
  argumentHint?: string;
}

/** Result of uploading a file via {@link ChatTransport.uploadFile}. */
export interface UploadedAttachment {
  /** Where the host saved the file — Claude reads it back by path (no inline bytes). */
  path: string;
  bytes?: number;
}

export interface ChatTransport {
  /**
   * The base path this transport posts to (e.g. "/sessions/:id" in dev-env, ""
   * for a root-mounted host). Exposed so sibling same-origin features (voice)
   * can derive their own proxy path under the same prefix. Optional for back-
   * compat with transports that don't set it.
   */
  base?: string;
  /** Opt-in before the first send so the composer can expose Queue immediately.
   * Omitted by legacy transports, whose global busy/Stop behavior is unchanged. */
  inputLifecycle?: true;
  connect(onEvent: (ev: ChatEvent) => void): () => void; // returns an unsubscribe/close fn
  sendMessage(text: string, meta?: ChatSendMeta): Promise<void | ChatInputReceipt>;
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
  interrupt(request?: ChatInterruptRequest): Promise<void | ChatInterruptResult>;
  fetchCommands(): Promise<SlashCommand[]>;
  /**
   * Answer an AskUserQuestion picker the operative raised (a tapped option label,
   * free text, or a dismiss). The gateway drives the live TUI picker via
   * keystrokes. Optional so transports that never surface `tool` events stay valid.
   */
  answerQuestion?(answer: QuestionAnswer): Promise<void>;
  /** Resolve one durable, generation-bound tool permission request. Hosts that
   * do not own a Web thread omit this capability and render prompts read-only. */
  answerPermission?(answer: PermissionAnswer): Promise<void>;
  /**
   * Upload a pasted/dropped/picked file so its path can be referenced in the
   * next message. Optional — a transport that omits this hides the
   * composer's attach affordance (paste/drop/file-picker) entirely. The
   * upload lands as a plain file on disk; Claude Code reads it back by path
   * rather than receiving inline base64 image blocks.
   */
  uploadFile?(file: { name: string; mime: string; base64: string }): Promise<UploadedAttachment>;
}

/**
 * HTTP transport against a `<base>/claude/*` surface (default base "/api").
 * `opts.uploads` opts into the attach affordance for hosts that expose a
 * `<base>/attachments` upload endpoint (the web channel); hosts without one
 * (dev-env sessions) leave it off so the composer never shows a dead control.
 */
export function createHttpTransport(base = "/api", opts?: { uploads?: boolean }): ChatTransport {
  const b = base.replace(/\/$/, "");
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`${b}/claude/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { failure?: unknown; message?: unknown } | null;
      if (isFailureInfo(body?.failure)) {
        throw new ChatTransportError(
          body.failure,
          typeof body?.message === "string" && body.message.trim() ? body.message : body.failure.text
        );
      }
      throw new Error(`${path} ${res.status}`);
    }
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
        es.addEventListener("session_event", (e: MessageEvent) => {
          try {
            const event: unknown = JSON.parse(e.data);
            if (isSessionEvent(event)) onEvent({ type: "session_event", event });
          } catch {
            /* ignore malformed */
          }
        });
        on("status");
        on("turn");
        on("screen");
        on("tool");
        // Both attribution frames are shared features: without these two the
        // dev-env host stays permanently dark on the Turn Rail even though its
        // server speaks the same /claude/* shape as the web channel.
        on("route");
        on("activity");
        es.addEventListener("error", (e: Event) => {
          const data = "data" in e ? (e as MessageEvent).data : undefined;
          if (typeof data !== "string") return;
          try {
            const payload = JSON.parse(data) as Record<string, unknown>;
            const coordinates = {
              ...(typeof payload.inputId === "string" ? { inputId: payload.inputId } : {}),
              ...(typeof payload.generationId === "string" ? { generationId: payload.generationId } : {}),
            };
            const message = typeof payload.message === "string" && payload.message.trim() ? payload.message : undefined;
            if (isFailureInfo(payload.failure)) {
              onEvent({ type: "error", failure: payload.failure, ...(message ? { message } : {}), ...coordinates });
            } else if (message) {
              onEvent({ type: "error", message, ...coordinates });
            }
          } catch {
            /* ignore malformed */
          }
        });
        es.onerror = (event) => {
          // A server-sent `event: error` is an application failure frame, not a
          // broken EventSource connection. The listener above owns its data.
          if (event && "data" in event) return;
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
    async sendMessage(text, meta) {
      await post("message", {
        text,
        ...(meta?.effort ? { effort: meta.effort } : {}),
      });
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
    ...(opts?.uploads
      ? {
          async uploadFile(file: { name: string; mime: string; base64: string }): Promise<UploadedAttachment> {
            // Same wire shape as the orchestrator transport: the host proxies
            // <base>/attachments to the gateway's POST /attachments, which saves
            // the bytes to disk and returns the path Claude reads back via the
            // Read tool — no inline base64 image blocks.
            const res = await fetch(`${b}/attachments`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ filename: file.name, content_base64: file.base64 }),
            });
            if (!res.ok) throw new Error(`attachments ${res.status}`);
            const j = await res.json().catch(() => ({}));
            return { path: String(j.path ?? ""), bytes: typeof j.bytes === "number" ? j.bytes : undefined };
          },
        }
      : {}),
  };
}

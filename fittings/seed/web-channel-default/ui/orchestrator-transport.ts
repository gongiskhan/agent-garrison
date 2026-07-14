// The web channel's orchestrator transport: a fetch-streamed ChatTransport over
// the gateway path (/api/chat -> gateway /chat/stream). Split out of main.tsx so
// it is unit-testable without mounting the React app (main.tsx has top-level
// createRoot side effects). Behavior is unchanged from the inline version plus:
//   - the `tool` SSE event (AskUserQuestion) is surfaced as a ChatEvent so the
//     chat renders tappable option buttons;
//   - answerQuestion posts the tap back to /api/chat/answer, where the gateway
//     drives the live TUI picker.

import type { ChatEvent, ChatTransport, ChatSendMeta, QuestionAnswer } from "@garrison/claude-chat";

// `threadId` identifies the conversation this transport serves; it rides every
// POST /api/chat body so the SERVER can persist the exchange into the thread when
// the upstream `done` event arrives (survives navigation/tab-close mid-turn).
export function createOrchestratorTransport(base = "/api", threadId?: string): ChatTransport {
  const b = base.replace(/\/$/, "");
  let listener: ((ev: ChatEvent) => void) | null = null;
  let acc = "";

  const send: (text: string, meta?: ChatSendMeta) => Promise<void> = async (text, meta) => {
    acc = "";
    const payload: Record<string, unknown> = { message: text };
    if (threadId) payload.thread = threadId;
    if (meta?.context !== undefined && meta.context !== null) payload.context = meta.context;
    if (typeof meta?.mode === "string" && meta.mode.trim()) {
      payload.mode = meta.mode.trim();
      // A mode-carrying turn is an interactive Discuss/design chat (Kanban / Automations
      // open these with mode=james). These must NOT use extended thinking: the router
      // otherwise classifies a "design a process" prompt as standard-tier → Sonnet with
      // `/effort medium`, and extended thinking on that content trips Anthropic's
      // usage-policy classifier (a hard AUP refusal on every Discuss turn). Pin the turn
      // to the no-thinking trivial tier - Discuss is lightweight by design, and the
      // gateway honors this classification hint (routeHintsFromBody). Ad-hoc threaded
      // chats carry no mode and are left to auto-classify as before.
      payload.classification = { taskType: "other", tier: "T0-trivial" };
    }

    const res = await fetch(`${b}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      listener?.({ type: "error", message: `chat ${res.status}` });
      listener?.({ type: "turn", active: false });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawReply = false;
    const handleEvent = (name: string, dataRaw: string) => {
      let data: any = {};
      try { data = dataRaw ? JSON.parse(dataRaw) : {}; } catch { /* ignore */ }
      if (name === "chunk" && typeof data.text === "string") {
        // `replace` marks a full re-emit after a screen reflow (not a delta) - REPLACE
        // the accumulator rather than appending, so a reflow doesn't duplicate the whole
        // reply into the stream (the kilobytes-of-repeated-text bug).
        if (data.replace) acc = data.text;
        else acc += data.text;
        sawReply = true;
        listener?.({ type: "assistant", text: acc });
      } else if (name === "tool") {
        // AskUserQuestion → tappable buttons. Forward the wire payload verbatim
        // (name / tool_use_id / questions) as a ChatEvent.
        listener?.({ type: "tool", ...data } as ChatEvent);
      } else if (name === "done") {
        // The done event carries the AUTHORITATIVE final reply (the settled scrape).
        // Prefer it whenever present: the streamed chunks are a live preview that can
        // still carry transient reflow artifacts, while done.reply is the clean result.
        if (typeof data.reply === "string" && data.reply.trim()) {
          acc = data.reply;
          sawReply = true;
          listener?.({ type: "assistant", text: acc });
        }
        // The turn settled but produced nothing - surface it instead of silently
        // doing nothing (the old failure mode), so the user can retry.
        if (!sawReply) {
          listener?.({ type: "assistant", text: "_The operative returned an empty reply. Try sending again._" });
        }
        // Runtime attribution the gateway carries on the settled turn (route /
        // runtime / model / tier / …). Emit it BEFORE idling the turn so the UI can
        // attach it to the just-finished turn's reply. Fired only when the payload
        // actually carries routing info; every field is forwarded defensively as the
        // contract makes them all optional/nullable.
        if (data.route != null || data.runtime != null || data.model != null) {
          listener?.({
            type: "route",
            route: data.route ?? null,
            runtime: data.runtime ?? null,
            provider: data.provider ?? null,
            model: data.model ?? null,
            taskType: data.taskType ?? null,
            tier: data.tier ?? null,
            effort: data.effort ?? null,
            ruleId: data.ruleId ?? null,
            profile: data.profile ?? null,
            honored: typeof data.honored === "boolean" ? data.honored : null,
          });
        }
        listener?.({ type: "turn", active: false });
      } else if (name === "error") {
        listener?.({ type: "error", message: String(data.error ?? "stream error") });
        listener?.({ type: "turn", active: false });
      }
    };
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let name = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (name !== "message" || data) handleEvent(name, data);
      }
    }
    listener?.({ type: "turn", active: false });
  };

  return {
    base: b,
    connect(onEvent) {
      listener = onEvent;
      onEvent({ type: "connection", state: "open" });
      return () => { listener = null; onEvent({ type: "connection", state: "closed" }); };
    },
    sendMessage: send as ChatTransport["sendMessage"],
    async sendKey() { /* no key surface on the orchestrator channel */ },
    async setMode(mode) { return { mode, reached: false }; },
    async interrupt() { /* no interrupt surface on the orchestrator channel */ },
    async answerQuestion(answer: QuestionAnswer) {
      // POST the tap back to the gateway (via the web-channel /api/chat/answer
      // proxy); the gateway maps the label to an option index and drives the picker.
      await fetch(`${b}/chat/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: threadId,
          tool_use_id: answer.toolUseId,
          ...(answer.label !== undefined ? { label: answer.label } : {}),
          ...(answer.text !== undefined ? { text: answer.text } : {}),
          ...(answer.dismiss ? { dismiss: true } : {}),
        }),
      }).catch(() => {});
    },
    async fetchCommands() { return []; },
  };
}

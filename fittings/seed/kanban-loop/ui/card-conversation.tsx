// The card's conversation surface, and the door its composer writes through.
//
// A card and its conversation are ONE thing under one id: the append-only ledger
// at $GARRISON_HOME/conversations/<id> is what happened to this card, and the
// composer writes into it. The kanban server mounts the same conversation router
// the web channel and the Next app mount, at the same relative base, so the
// client code here is identical on every surface - and every URL it builds stays
// relative, because the browser is almost never on the Garrison box.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatTransportError,
  ConversationView,
  type ChatInputReceipt,
  type ChatTransport,
  type ComposerAdornmentApi,
  type UploadedAttachment
} from "@garrison/claude-chat";
import type { ConversationActivity } from "@garrison/claude-chat/journal";

export const CONVERSATION_BASE = "/api/conversation";

/**
 * The composer's transport. Deliberately minimal: the conversation stream IS the
 * transcript (ConversationView renders it from the SSE route), so this object
 * only has to ADMIT a message and report what the router said. The rest of the
 * ChatTransport contract describes a live PTY, which a conversation does not have.
 *
 * `inputLifecycle` is on because a transcript-only surface renders receipts as
 * its ONLY send feedback: without it a refused send would vanish without a trace.
 * The receipt settles at the 202 because the INPUT's life ends there - it is
 * durably in the ledger. The work it triggers is a stretch, which the stream
 * renders on its own account.
 */
export function createConversationTransport(conversationId: string, opts: { frozen?: boolean } = {}): ChatTransport {
  const base = `${CONVERSATION_BASE}/${encodeURIComponent(conversationId)}`;
  return {
    base,
    inputLifecycle: true,
    connect(onEvent) {
      let cancelled = false;
      // No socket to open. Probe the conversation's own route once so the chat's
      // connection state is a fact (this conversation is readable from here)
      // rather than the initial "reconnecting" it would otherwise keep forever.
      fetch(base, { cache: "no-store" })
        .then((res) => { if (!cancelled) onEvent({ type: "connection", state: res.ok ? "open" : "closed" }); })
        .catch(() => { if (!cancelled) onEvent({ type: "connection", state: "closed" }); });
      return () => { cancelled = true; };
    },
    async sendMessage(text, meta): Promise<ChatInputReceipt> {
      // Every refusal below is a ChatTransportError carrying a FailureInfo, not a
      // bare Error: a transcript-only surface renders ONLY structured failures in
      // its tail strip, so a plain throw is a message that vanishes.
      //
      // A frozen card's conversation is a record. The composer is suppressed for
      // one, but the refusal lives here too - a hidden control must not be able
      // to write into history.
      if (opts.frozen) {
        throw new ChatTransportError({
          source: "web",
          kind: "invalid_request",
          code: "conversation_frozen",
          text: "This card is frozen - its conversation is a read-only record.",
          retryable: false
        });
      }
      // The door also accepts `context` and `routing`. This surface sends
      // NEITHER, on purpose. The card IS the context - the launcher builds the
      // brief from the conversation's own summary and handoffs plus the card, so
      // a per-message blob would be the seeded copy the Discuss cut just removed.
      // And the pin lives on the CARD (`card.routing`, edited in Run
      // configuration): there is no Turn Rail in this composer, so a per-message
      // routing field would be a second authority for one fact.
      const clientRequestId = meta?.clientRequestId?.trim() ||
        `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      let res: Response;
      try {
        res = await fetch(`${base}/message`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ message: text, clientRequestId, origin: "kanban" })
        });
      } catch {
        throw new ChatTransportError({
          source: "transport",
          kind: "transport",
          code: "conversation_message_unreachable",
          text: "The conversation could not be reached. The message was not recorded.",
          retryable: true
        });
      }
      const body = await res.json().catch(() => null) as { error?: unknown; seq?: unknown } | null;
      if (!res.ok) {
        // The router accepts only once its forwarder confirms, so a refusal means
        // NOTHING was recorded. Say that, rather than leave the user believing a
        // delivered message went unanswered.
        throw new ChatTransportError({
          source: res.status === 502 ? "gateway" : "web",
          kind: res.status >= 500 ? "runtime" : "invalid_request",
          code: `conversation_message_${res.status}`,
          text: (typeof body?.error === "string" && body.error.slice(0, 1_000)) ||
            `The conversation refused the message (${res.status}).`,
          retryable: res.status >= 500,
          httpStatus: res.status
        });
      }
      return {
        clientRequestId,
        // A CLIENT coordinate, deliberately prefixed so it can never be mistaken
        // for the `<conversation>#<seq>` id the ledger's own events carry.
        inputId: typeof body?.seq === "number" ? `conv:${conversationId}#${body.seq}` : `conv:${clientRequestId}`,
        state: "settled",
        acceptedAt: new Date().toISOString()
      };
    },
    async sendKey() { /* no keyboard: there is no PTY behind a conversation */ },
    async setMode(mode) { return { mode, reached: false }; },
    async interrupt() { /* a stretch is cancelled from the card, not the composer */ },
    async fetchCommands() { return []; },
    // A frozen card refuses the write server-side too, but the transport omits
    // uploadFile entirely for one so the composer never shows a dead attach
    // control on a read-only record.
    ...(opts.frozen ? {} : {
      async uploadFile(file: { name: string; mime: string; base64: string }): Promise<UploadedAttachment> {
        // The conversation id IS the card id (see the module comment above), so
        // a message-composer upload is just a card attachment: it lands under
        // cards/<id>/attachments/ and therefore folds into every future stretch
        // brief for free, same as an upload made from the card's Detail sheet.
        const res = await fetch(`/cards/${encodeURIComponent(conversationId)}/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename: file.name, content_base64: file.base64 })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: unknown } | null;
          throw new Error(typeof body?.error === "string" ? body.error : `attachments ${res.status}`);
        }
        const body = await res.json().catch(() => ({})) as { path?: unknown; bytes?: unknown };
        return { path: String(body.path ?? ""), bytes: typeof body.bytes === "number" ? body.bytes : undefined };
      }
    })
  };
}

/**
 * What the last stretch recorded about WHERE it ran. Read from the conversation's
 * meta tail rather than from the card, because the card carries the project it was
 * ASKED to use and the ledger carries the one that resolved. `cwdDegraded` means a
 * project was named but did not exist on this machine, so the stretch ran in the
 * composition directory instead - silently running project work in the wrong
 * directory is the exact incident tests/kanban-turn-cwd.test.ts exists for, so it
 * gets said out loud.
 */
function useLastStretchScope(conversationId: string | null, generation: string) {
  const [scope, setScope] = useState<{ project: string | null; cwdDegraded: boolean } | null>(null);
  useEffect(() => {
    if (!conversationId) { setScope(null); return; }
    let alive = true;
    fetch(`${CONVERSATION_BASE}/${encodeURIComponent(conversationId)}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((meta: { tail?: Array<{ kind?: string; payload?: Record<string, unknown> }> } | null) => {
        if (!alive) return;
        const records = Array.isArray(meta?.tail) ? meta.tail : [];
        const started = records.filter((record) => record?.kind === "stretch-started").at(-1);
        if (!started) { setScope(null); return; }
        const project = typeof started.payload?.project === "string" ? started.payload.project : null;
        setScope({ project, cwdDegraded: started.payload?.cwdDegraded === true });
      })
      .catch(() => { if (alive) setScope(null); });
    return () => { alive = false; };
  }, [conversationId, generation]);
  return scope;
}

/**
 * Big buttons beside the composer while the conversation is stalled waiting on
 * the human - `needs-input` or `awaiting-approval`. Typing "Approve" or "Give
 * me a few options" by hand every time a card pauses is the friction this
 * removes; a genuine question still needs real words, so that button only
 * focuses the composer instead of guessing one.
 */
function QuickReplies({ activity, api }: { activity: ConversationActivity; api: ComposerAdornmentApi }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusComposer = useCallback(() => {
    const field = rootRef.current?.closest(".cc-composerrow")?.querySelector("textarea");
    field?.focus();
  }, []);
  if (activity.mode !== "needs-input" && activity.mode !== "awaiting-approval") return null;
  const approveText = activity.mode === "awaiting-approval"
    ? "Approve — go ahead with the plan as described."
    : "Approved — go ahead.";
  return (
    <div className="conv-quickreplies" ref={rootRef}>
      <button
        type="button"
        className="conv-quickreply conv-quickreply-approve"
        disabled={api.busy}
        title="Send an approval and let the conversation continue"
        onClick={() => api.send(approveText)}
      >
        Approve
      </button>
      <button
        type="button"
        className="conv-quickreply"
        disabled={api.busy}
        title="Ask the conversation for a few options before deciding"
        onClick={() => api.send("Give me a few options to choose from before I decide.")}
      >
        Give options
      </button>
      <button
        type="button"
        className="conv-quickreply conv-quickreply-ghost"
        disabled={api.busy}
        title="Write a question of your own into the composer"
        onClick={focusComposer}
      >
        Ask a question
      </button>
    </div>
  );
}

/**
 * The card's conversation surface: the stream is the body, the composer writes
 * into it, and the header carries the degraded-cwd marker plus the raw phase log.
 *
 * `frozen` renders the same view with its composer suppressed (a frozen card's
 * conversation is a record, and the History view shows it read-only). The
 * suppression is CSS today because ConversationView has no read-only prop yet -
 * the transport above refuses the write either way.
 */
export function CardConversation({
  conversationId,
  title,
  generation,
  frozen = false,
  running,
  onRawLog,
  onOpenRuntimeTranscript
}: {
  conversationId: string;
  title: string;
  /** Changes when the card does, so the scope re-reads on a stretch boundary. */
  generation: string;
  frozen?: boolean;
  /** Whether the CARD says work is being driven right now. `false` vetoes the
   *  stream's derived working spinners (a wedged ledger must not spin forever
   *  under a card that says parked); `undefined` trusts the stream's own
   *  derivation. */
  running?: boolean;
  onRawLog: () => void;
  onOpenRuntimeTranscript: (sessionId: string) => void;
}) {
  const transport = useMemo(
    () => createConversationTransport(conversationId, { frozen }),
    [conversationId, frozen]
  );
  const scope = useLastStretchScope(conversationId, generation);
  const [activity, setActivity] = useState<ConversationActivity | null>(null);
  return (
    <div className={`kanban-conversation${frozen ? " frozen" : ""}`}>
      <ConversationView
        conversationId={conversationId}
        base={CONVERSATION_BASE}
        transport={transport}
        live={frozen ? false : running ? undefined : false}
        title={title}
        placeholder={frozen ? "This conversation is frozen" : "Write into this conversation"}
        onOpenRuntimeTranscript={onOpenRuntimeTranscript}
        onActivityChange={frozen ? undefined : setActivity}
        composerAdornment={
          frozen || !activity ? undefined : (api) => <QuickReplies activity={activity} api={api} />
        }
        headerExtra={
          <>
            {scope?.cwdDegraded && (
              <span
                className="conv-degraded"
                title="the project named on this card did not resolve on this machine, so the work ran in the composition directory instead"
              >
                degraded cwd{scope.project ? `: ${scope.project} is not on this machine` : ""}
              </span>
            )}
            <button type="button" className="conv-rawlog" onClick={onRawLog} title="this card's raw phase log">
              Raw log
            </button>
          </>
        }
      />
    </div>
  );
}

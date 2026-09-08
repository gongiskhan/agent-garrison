// The view for an external (not-yet-owned) session row: a live transcript
// (reusing @garrison/claude-chat's SessionStream - the SSE frame shape is
// identical, by design, to what parseByFormat produces) plus the honest
// actions a row of its kind actually supports.

import React, { useEffect, useRef, useState } from "react";
import { SessionStream } from "@garrison/claude-chat";
import { NativeTerminal } from "./native-terminal";
import { DISCONNECTED_COLOR, sessionDisconnected, sessionRunning, disconnectedMessage } from "./session-connection";
import { SessionUsage } from "./session-usage";
import { ShellComposer } from "./shell-composer";
import type { RailSession } from "./sessions-rail";

const RUNTIME_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI", shell: "Shell" };

export function ExternalSessionView({
  row,
  streamUrl,
  onContinue,
  onSend,
  onOpenShell,
  onRetry,
  error,
  usageBase,
  onCopyResume,
  onClose,
  busy = false,
}: {
  row: RailSession;
  /** /api/sessions/:id/stream (self) or the peer-proxy equivalent - resolved
   *  by the caller, which knows whether `row` is local or a peer's. */
  streamUrl: string | null;
  onContinue?: () => void;
  onSend?: (text: string) => Promise<void>;
  onOpenShell?: () => void;
  onRetry?: () => void;
  error?: string | null;
  usageBase?: string;
  onCopyResume?: () => void;
  onClose?: () => void;
  busy?: boolean;
}) {
  const [plainOutput, setPlainOutput] = useState(false);
  const disconnected = sessionDisconnected(row);
  const running = sessionRunning(row);
  const draftKey = `native-shell-draft:${row.node}:${row.id}`;
  const [queued, setQueued] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [draftGeneration, setDraftGeneration] = useState(0);
  const submitting = useRef(false);
  const send = async (text: string) => {
    if (!onSend) return;
    if (running && !row.attachable) {
      setQueued(text);
      setQueueError(null);
      // Keep a recoverable draft if the viewer leaves before the turn ends.
      try { localStorage.setItem(`${draftKey}:queued`, text); } catch {}
      return;
    }
    await onSend(text);
  };
  useEffect(() => {
    // A queue only runs while this view is open. A previous closed view's
    // message returns as a draft, never as an unexpected automatic send.
    try {
      const previous = localStorage.getItem(`${draftKey}:queued`);
      if (previous) { localStorage.setItem(draftKey, previous); localStorage.removeItem(`${draftKey}:queued`); setDraftGeneration(n => n + 1); }
    } catch {}
  }, [draftKey]);
  useEffect(() => {
    if (!queued || queueError || busy || disconnected || running || !onSend || submitting.current) return;
    submitting.current = true;
    void onSend(queued).then(() => {
      setQueued(null);
      try { localStorage.removeItem(`${draftKey}:queued`); } catch {}
    }).catch(err => setQueueError(err instanceof Error ? err.message : "Could not send the queued message.")).finally(() => { submitting.current = false; });
  }, [queued, queueError, busy, disconnected, running, onSend, draftKey]);
  const cancelQueue = () => {
    if (queued) try { localStorage.setItem(draftKey, queued); localStorage.removeItem(`${draftKey}:queued`); } catch {}
    setQueued(null); setQueueError(null); setDraftGeneration(n => n + 1);
  };
  const subline = row.kind === "desktop"
    ? `${RUNTIME_LABEL[row.runtime] ?? row.runtime} desktop · ${row.project ?? row.cwd ?? row.node}`
    : row.status === "ended"
      ? `Recent shell session on ${row.node}`
      : `${running ? "Working" : "Shell session"} on ${row.node}`;

  return (
    <div className="wc-sess" data-testid="sess-view">
      <div className="wc-wb-head" data-testid="sess-head">
        <span className={`wc-wb-lamp wc-wb-lamp--${disconnected ? "offline" : running ? "running" : row.status === "ended" ? "offline" : "idle"}`} aria-hidden />
        <span className="wc-thread-src wc-thread-rt">{RUNTIME_LABEL[row.runtime] ?? row.runtime}</span>
        <span className="wc-thread-node" style={{ ["--node-accent" as never]: disconnected ? DISCONNECTED_COLOR : row.nodeAccent || "#6a746b" }}>{row.node}</span>
        {row.project && <span className="wc-thread-proj">{row.project}</span>}
        <span className="wc-wb-title">{row.title || row.cwd || row.id}</span>
        <span className="wc-wb-sub">{subline}</span>
        {onClose && <button type="button" className="wc-wb-reattach" data-testid="sess-close" onClick={onClose}>Close</button>}
      </div>
      <div className="wc-sess-actions">
        {onOpenShell && <button type="button" className="wc-wb-reattach" data-testid="sess-open-shell" disabled={busy || disconnected} onClick={onOpenShell} title="Open a terminal in this session’s folder">Open shell</button>}
        {usageBase && <SessionUsage base={usageBase} runtime={row.runtime} node={row.node} disconnected={disconnected} />}
        {streamUrl && <button type="button" className="wc-wb-reattach" aria-pressed={plainOutput} onClick={() => setPlainOutput(v => !v)}>
          {plainOutput ? "Conversation view" : "Plain output"}
        </button>}
        {onContinue && (row.resumable || row.attachable) && (
          <button type="button" className="wc-wb-reattach" data-testid={row.kind === "bg" ? "sess-attach" : "sess-continue"} disabled={busy || disconnected || (running && !row.attachable)} title={running && !row.attachable ? "The original client is still running this session" : undefined} onClick={onContinue}>
            {busy ? "Connecting…" : row.attachable ? "Open existing terminal" : "Continue in a shell"}
          </button>
        )}
        {onCopyResume && row.resumeCommand && (
          <button type="button" className="wc-wb-reattach" data-testid="sess-copy-resume" onClick={onCopyResume}>
            Copy resume command
          </button>
        )}
      </div>
      {(disconnected || error) && <div className="wc-session-warning" role="status">{disconnected ? disconnectedMessage(row.node) : error} {onRetry && <button type="button" onClick={onRetry}>Retry connection</button>}</div>}
      <div className="wc-sess-body" data-testid="sess-transcript">
        {streamUrl ? (
          plainOutput ? <NativeTerminal streamUrl={streamUrl} /> : (
            <div className="wc-sess-conversation" data-testid="native-conversation-view">
              <SessionStream url={streamUrl} reconnect live={running} title="Session output" />
            </div>
          )
        ) : (
          <div className="wc-sess-note" data-testid="sess-note">No transcript for this session yet.</div>
        )}
      </div>
      <div className="wc-sess-input-note">
        {row.terminalRef ? "Messages go to the existing Dev Env terminal."
          : row.attachable ? "Connect to send messages to the existing agent."
          : row.resumable && running ? "The original agent is working. Your message will wait for its current turn to finish."
          : row.resumable ? "Send resumes this conversation in a terminal here."
          : "Live output from the original app. Input is available when the session is connected to a shell."}
      </div>
      {queued && <div className="wc-session-warning" role="status">
        <strong>{queueError ? "Message not sent" : "Message queued"}</strong>
        <div>{queued}</div>
        <div>{queueError || "Keep this session open. The message will send when the current turn finishes."}</div>
        <button type="button" disabled={busy} onClick={cancelQueue}>Return to draft</button>
      </div>}
      {onSend && <ShellComposer key={draftGeneration} onSend={send} onKeys={() => {}} hideKeys
        disabled={busy || disconnected} sendDisabled={Boolean(queued)}
        sendLabel={running && !row.attachable ? "Queue message" : "Send"} draftKey={draftKey} />}
    </div>
  );
}

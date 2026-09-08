// The view for an external (not-yet-owned) session row: a live transcript
// (reusing @garrison/claude-chat's SessionStream - the SSE frame shape is
// identical, by design, to what parseByFormat produces) plus the honest
// actions a row of its kind actually supports.

import React, { useState } from "react";
import { SessionStream } from "@garrison/claude-chat";
import { NativeTerminal } from "./native-terminal";
import type { RailSession } from "./sessions-rail";

const RUNTIME_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI", shell: "Shell" };

export function ExternalSessionView({
  row,
  streamUrl,
  onContinue,
  onCopyResume,
  onClose,
  busy = false,
}: {
  row: RailSession;
  /** /api/sessions/:id/stream (self) or the peer-proxy equivalent - resolved
   *  by the caller, which knows whether `row` is local or a peer's. */
  streamUrl: string | null;
  onContinue?: () => void;
  onCopyResume?: () => void;
  onClose?: () => void;
  busy?: boolean;
}) {
  const [plainOutput, setPlainOutput] = useState(false);
  const subline = row.kind === "desktop"
    ? `${RUNTIME_LABEL[row.runtime] ?? row.runtime} desktop · ${row.project ?? row.cwd ?? row.node}`
    : row.status === "ended"
      ? `Recent shell session on ${row.node}`
      : `${row.status === "working" ? "Working" : "Shell session"} on ${row.node}`;

  return (
    <div className="wc-sess" data-testid="sess-view">
      <div className="wc-wb-head" data-testid="sess-head">
        <span className={`wc-wb-lamp wc-wb-lamp--${row.status === "working" ? "running" : row.status === "ended" ? "offline" : "idle"}`} aria-hidden />
        <span className="wc-thread-src wc-thread-rt">{RUNTIME_LABEL[row.runtime] ?? row.runtime}</span>
        <span className="wc-thread-node" style={{ ["--node-accent" as never]: row.nodeAccent || "#6a746b" }}>{row.node}</span>
        {row.project && <span className="wc-thread-proj">{row.project}</span>}
        <span className="wc-wb-title">{row.title || row.cwd || row.id}</span>
        <span className="wc-wb-sub">{subline}</span>
        {onClose && <button type="button" className="wc-wb-reattach" data-testid="sess-close" onClick={onClose}>Close</button>}
      </div>
      <div className="wc-sess-actions">
        {streamUrl && <button type="button" className="wc-wb-reattach" aria-pressed={plainOutput} onClick={() => setPlainOutput(v => !v)}>
          {plainOutput ? "Conversation view" : "Plain output"}
        </button>}
        {onContinue && (row.resumable || row.attachable) && (
          <button type="button" className="wc-wb-reattach" data-testid={row.kind === "bg" ? "sess-attach" : "sess-continue"} disabled={busy || (row.status === "working" && !row.attachable)} title={row.status === "working" && !row.attachable ? "The original client is still running this session" : undefined} onClick={onContinue}>
            {busy ? "Starting…" : row.kind === "bg" ? "Attach" : "Continue in a shell"}
          </button>
        )}
        {onCopyResume && row.resumeCommand && (
          <button type="button" className="wc-wb-reattach" data-testid="sess-copy-resume" onClick={onCopyResume}>
            Copy resume command
          </button>
        )}
      </div>
      <div className="wc-sess-body" data-testid="sess-transcript">
        {streamUrl ? (
          plainOutput ? <NativeTerminal streamUrl={streamUrl} /> : (
            <div className="wc-sess-conversation" data-testid="native-conversation-view">
              <SessionStream url={streamUrl} reconnect live={row.status === "working"} title="Session output" />
            </div>
          )
        ) : (
          <div className="wc-sess-note" data-testid="sess-note">No transcript for this session yet.</div>
        )}
      </div>
      <div className="wc-sess-input-note">
        {row.attachable ? "Attach to send prompts from this conversation."
          : row.resumable && row.status !== "working" ? "Continue in a shell to send prompts from this conversation."
          : "Live output from the original app. Input is available when the session is connected to a shell."}
      </div>
    </div>
  );
}

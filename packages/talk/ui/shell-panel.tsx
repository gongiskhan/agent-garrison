// The view for an OWNED shell thread (source:"shell"): a command deck, the
// xterm pane over the target node's Shells fitting (direct origin, never a
// same-origin relay), and a composer for typing into it. Deliberately its
// own small component rather than a mode on RemoteShellWorkbench - that
// component's dispatch-ledger/delegate-seam machinery is for the OLDER
// remote-shell thread shape and stays untouched.

import React, { useCallback, useState } from "react";
import { RemoteShellPane, type RemoteShellMeta } from "./remote-shell-pane";
import { ShellComposer } from "./shell-composer";
import { errorCopy, shellFetch, shellSocketUrl, ShellOriginError } from "./shell-origin";

export interface ShellThreadBinding {
  node: string;
  transport: string;
  tmuxSession?: string;
  cwd?: string;
  runtime?: string;
  label?: string;
  sessionId?: string;
  shellOrigin?: string;
}

type DeckState = "running" | "idle" | "linking" | "detached" | "unreachable";

function deckState(meta: RemoteShellMeta | null, originError: unknown): DeckState {
  if (originError) return "unreachable";
  if (!meta) return "linking";
  if (meta.status) return meta.status.includes("detached") ? "detached" : "unreachable";
  if (meta.agentState === "running") return "running";
  if (meta.agentState === "idle") return "idle";
  return "linking";
}

const STATE_WORD: Record<DeckState, string> = { running: "RUNNING", idle: "IDLE", linking: "LINKING", detached: "DETACHED", unreachable: "UNREACHABLE" };

export function ShellPanel({
  threadId,
  binding,
  title,
  origin,
  originError,
  onRetryOrigin,
}: {
  threadId: string;
  binding: ShellThreadBinding;
  title: string;
  origin: string | null;
  originError: ShellOriginError | null;
  onRetryOrigin: () => void;
}) {
  const [meta, setMeta] = useState<RemoteShellMeta | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const state = deckState(meta, originError);
  const sessionId = binding.sessionId ?? "";

  const sendInput = useCallback((text: string) => {
    if (!origin || !sessionId) return;
    void shellFetch(origin, `/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    }).catch(() => { /* the pane itself shows the outcome */ });
  }, [origin, sessionId]);

  const sendKeys = useCallback((keys: string) => {
    if (!origin || !sessionId) return;
    void shellFetch(origin, `/sessions/${encodeURIComponent(sessionId)}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys })
    }).catch(() => {});
  }, [origin, sessionId]);

  const reattach = useCallback(() => {
    if (!origin) { onRetryOrigin(); return; }
    void shellFetch(origin, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transport: binding.transport, tmuxSession: binding.tmuxSession, cwd: binding.cwd, runtime: binding.runtime, recycle: true })
    }).then(() => setReconnectNonce((n) => n + 1)).catch(() => {});
  }, [origin, binding, onRetryOrigin]);

  return (
    <div className="wc-wb wc-wb--shell" data-testid="wb-deck-root">
      <div className="wc-wb-head" data-testid="wb-deck">
        <span className={`wc-wb-lamp wc-wb-lamp--${state === "unreachable" ? "offline" : state}`} aria-hidden />
        <span className="wc-wb-state">{STATE_WORD[state]}</span>
        <span className="wc-wb-title" title={title}>{title}</span>
        <span className="wc-wb-crumb">{binding.node.toUpperCase()} / {binding.transport} / TMUX:{binding.tmuxSession ?? "?"}</span>
        <button type="button" className="wc-wb-reattach" data-testid="wb-reattach" onClick={reattach}>Reattach</button>
      </div>
      {originError ? (
        <div className="wc-sess-note" data-testid="wb-error">
          <strong>{errorCopy(originError, binding.node).title}</strong>
          <div>{errorCopy(originError, binding.node).sub}</div>
          <button type="button" className="wc-wb-reattach" data-testid="wb-retry" onClick={onRetryOrigin}>Retry</button>
        </div>
      ) : origin && sessionId ? (
        <RemoteShellPane
          key={threadId}
          sessionId={sessionId}
          hideBar
          reconnectNonce={reconnectNonce}
          ioUrl={shellSocketUrl(origin)}
          onMetaChange={setMeta}
        />
      ) : (
        <div className="wc-sess-note">Connecting…</div>
      )}
      <ShellComposer onSend={sendInput} onKeys={sendKeys} disabled={!origin || !sessionId} draftKey={`shell-draft:${threadId}`} />
    </div>
  );
}

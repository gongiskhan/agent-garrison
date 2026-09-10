// The view for an OWNED shell thread (source:"shell"): a command deck, the
// xterm pane with direct WebSocket and same-origin HTTP fallback, and a
// composer targeting the exact owner session. Deliberately its
// own small component rather than a mode on RemoteShellWorkbench - that
// component's dispatch-ledger/delegate-seam machinery is for the OLDER
// remote-shell thread shape and stays untouched.

import React, { useCallback, useState } from "react";
import { SessionStream } from "@garrison/claude-chat";
import { RemoteShellPane, type RemoteShellMeta } from "./remote-shell-pane";
import { disconnectedMessage } from "./session-connection";
import { SessionUsage } from "./session-usage";
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
  controlBase,
  originError,
  onRetryOrigin,
  streamUrl,
  disconnected = false,
  usageBase,
}: {
  threadId: string;
  binding: ShellThreadBinding;
  title: string;
  origin: string | null;
  controlBase?: string;
  originError: ShellOriginError | null;
  onRetryOrigin: () => void;
  streamUrl?: string | null;
  disconnected?: boolean;
  usageBase?: string;
}) {
  const [meta, setMeta] = useState<RemoteShellMeta | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [showShell, setShowShell] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const state = disconnected ? "unreachable" : deckState(meta, originError);
  const sessionId = binding.sessionId ?? "";
  const api = controlBase || origin;

  const sendInput = useCallback(async (text: string) => {
    if (!api || !sessionId) throw new Error("The shell is not connected.");
    await shellFetch(api, `/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    }, { timeoutMs: 25000 });
  }, [api, sessionId]);

  const sendKeys = useCallback((keys: string) => {
    if (!api || !sessionId) return;
    void shellFetch(api, `/sessions/${encodeURIComponent(sessionId)}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys })
    }).then(() => setInputError(null)).catch(err => setInputError(err instanceof Error ? err.message : String(err)));
  }, [api, sessionId]);

  const reattach = useCallback(() => {
    if (!api) { onRetryOrigin(); return; }
    setInputError(null);
    void shellFetch(api, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, recycle: true })
    }, { timeoutMs: 65000 }).then(() => setReconnectNonce((n) => n + 1)).catch(err => setInputError(err instanceof Error ? err.message : String(err)));
  }, [api, sessionId, onRetryOrigin]);

  return (
    <div className="wc-wb wc-wb--shell" data-testid="wb-deck-root">
      <div className="wc-wb-head" data-testid="wb-deck">
        <span className={`wc-wb-lamp wc-wb-lamp--${state === "unreachable" ? "offline" : state}`} aria-hidden />
        <span className="wc-wb-state">{STATE_WORD[state]}</span>
        <span className="wc-wb-title" title={title}>{title}</span>
        <span className="wc-wb-crumb">{binding.node.toUpperCase()} / {binding.transport} / TMUX:{binding.tmuxSession ?? "?"}</span>
        {usageBase && <SessionUsage base={usageBase} runtime={binding.runtime} node={binding.node} disconnected={disconnected} />}
        {streamUrl && <button type="button" className="wc-wb-reattach" aria-pressed={showShell} onClick={() => setShowShell(v => !v)}>{showShell ? "Hide shell" : "Show shell"}</button>}
        <button type="button" className="wc-wb-reattach" data-testid="wb-reattach" onClick={reattach}>Reattach</button>
      </div>
      {disconnected && <div className="wc-session-warning" role="status">{disconnectedMessage(binding.node)}</div>}
      {originError ? (
        <div className="wc-sess-note" data-testid="wb-error">
          <strong>{errorCopy(originError, binding.node).title}</strong>
          <div>{errorCopy(originError, binding.node).sub}</div>
          <button type="button" className="wc-wb-reattach" data-testid="wb-retry" onClick={onRetryOrigin}>Retry</button>
        </div>
      ) : origin && sessionId ? (
        <div className="wc-shell-output">
          {streamUrl && <div className="wc-sess-body wc-sess-conversation" hidden={showShell} data-testid="shell-conversation-view">
            <SessionStream url={streamUrl} reconnect live={state === "running"} title="Terminal output" />
          </div>}
          <div className="wc-shell-terminal" hidden={Boolean(streamUrl) && !showShell}>
            <RemoteShellPane
              key={threadId}
              sessionId={sessionId}
              hideBar
              reconnectNonce={reconnectNonce}
              ioUrl={shellSocketUrl(origin)}
              httpBase={api ?? undefined}
              onMetaChange={setMeta}
            />
          </div>
        </div>
      ) : (
        <div className="wc-sess-note">Connecting…</div>
      )}
      {inputError && <div className="wc-sess-input-error" role="alert">{inputError}</div>}
      <ShellComposer onSend={sendInput} onKeys={sendKeys} disabled={disconnected || !origin || !sessionId} draftKey={`shell-draft:${threadId}`} />
    </div>
  );
}

// The remote-shell thread's COMMAND-DECK WORKBENCH.
//
// Desktop (≥1024px): a 44px command deck (lamp, state word + elapsed, session
// identity, reattach) over a row split — the terminal full-height on the left,
// a draggable seam, and the paper DISPATCH ledger (the delegate chat lane) on
// the right. Narrow (<1024px): the same DOM re-flowed into a stacked console —
// deck, full-width terminal, and a bottom dispatch dock whose transcript
// reveals as a sheet above the composer.
//
// The terminal is the primary surface; the ledger records what was dispatched
// to the remote agent and what came back. ClaudeChat stays mounted in every
// mode (it owns the composer and the turn machinery); the workbench only
// reframes it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RemoteShellPane, type RemoteShellMeta } from "./remote-shell-pane";
import type { RemoteShellTransport } from "./app";

const DELEGATE_MIN = 280;
const DELEGATE_MAX = 520;

type DeckState = "running" | "idle" | "linking" | "detached" | "offline";

function deckState(meta: RemoteShellMeta): DeckState {
  if (meta.status) return meta.status.includes("detached") ? "detached" : "offline";
  if (meta.agentState === "running") return "running";
  if (meta.agentState === "idle") return "idle";
  return "linking";
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

const STATE_WORD: Record<DeckState, string> = {
  running: "RUNNING",
  idle: "IDLE",
  linking: "LINKING",
  detached: "DETACHED",
  offline: "OFFLINE",
};

export function RemoteShellWorkbench({
  sessionId,
  transport,
  sessionSpec = null,
  title,
  messageCount,
  hasActivity,
  children,
}: {
  sessionId: string;
  transport: RemoteShellTransport | null;
  /** The multi-session spec for this thread's session (null = the transport's
   *  standing session). Reattach must recycle THIS session, not the default. */
  sessionSpec?: { transport: string; tmuxSession: string | null; cwd: string | null; label: string | null } | null;
  title: string;
  messageCount: number;
  /** A turn is running or history exists — suppresses the empty-state prose. */
  hasActivity: boolean;
  children: React.ReactNode;
}) {
  const [meta, setMeta] = useState<RemoteShellMeta>({ agentState: null, status: null });
  const [nonce, setNonce] = useState(0);
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState("");
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const storageKey = `wc.wb.delegateWidth`;
  const [delegateW, setDelegateW] = useState<number | null>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? Math.min(DELEGATE_MAX, Math.max(DELEGATE_MIN, n)) : null;
    } catch { return null; }
  });
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const state = deckState(meta);

  // Elapsed clock while running.
  useEffect(() => {
    if (state === "running") {
      setRunningSince((prev) => prev ?? Date.now());
    } else {
      setRunningSince(null);
      setElapsed("");
    }
  }, [state]);
  useEffect(() => {
    if (runningSince === null) return;
    const tick = () => setElapsed(fmtElapsed(Date.now() - runningSince));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [runningSince]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Escape closes the narrow sheet.
  useEffect(() => {
    if (!narrow || !sheetOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSheetOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [narrow, sheetOpen]);

  // Reconnect recycles the fitting's ssh+tmux attach client too (recycle:
  // true), not just this pane's WebSocket - it is the user's one-click way out
  // of a wedged client state without touching tmux on the remote.
  const reattach = useCallback(() => {
    const t = transport?.name;
    const bump = () => setNonce((n) => n + 1);
    if (!t) return bump();
    void fetch("/api/remote-shell/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transport: t,
        recycle: true,
        ...(sessionSpec?.tmuxSession ? { tmuxSession: sessionSpec.tmuxSession } : {}),
        ...(sessionSpec?.cwd ? { cwd: sessionSpec.cwd } : {}),
        ...(sessionSpec?.label ? { label: sessionSpec.label } : {})
      })
    }).catch(() => { /* the WS reopen below still helps */ }).finally(bump);
  }, [transport?.name, sessionSpec?.tmuxSession, sessionSpec?.cwd, sessionSpec?.label]);

  // Seam drag: pointer-driven, clamped, persisted on release.
  const onSeamPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const body = bodyRef.current;
      if (!body) return;
      const w = Math.min(DELEGATE_MAX, Math.max(DELEGATE_MIN, body.getBoundingClientRect().right - ev.clientX));
      setDelegateW(w);
    };
    const up = () => {
      setDragging(false);
      setDelegateW((w) => {
        try { if (w !== null) window.localStorage.setItem(storageKey, String(Math.round(w))); } catch {}
        return w;
      });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [storageKey]);

  const onSeamKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setDelegateW((w) => {
      const cur = w ?? 360;
      const next = Math.min(DELEGATE_MAX, Math.max(DELEGATE_MIN, cur + (e.key === "ArrowLeft" ? 16 : -16)));
      try { window.localStorage.setItem(storageKey, String(next)); } catch {}
      return next;
    });
  }, [storageKey]);

  const resetSeam = useCallback(() => {
    setDelegateW(null);
    try { window.localStorage.removeItem(storageKey); } catch {}
  }, [storageKey]);

  // Focus entering the composer opens the sheet, so a typed instruction always
  // shows where the thread lands.
  const onDelegateFocus = useCallback((e: React.FocusEvent) => {
    if (!narrow) return;
    if ((e.target as HTMLElement)?.tagName === "TEXTAREA") setSheetOpen(true);
  }, [narrow]);

  const crumb = useMemo(() => {
    if (!transport) return null;
    const sess = sessionSpec?.tmuxSession || transport.tmuxSession;
    return `${transport.via} / TMUX:${sess}`.toUpperCase();
  }, [transport, sessionSpec?.tmuxSession]);

  const emptyDelegate = messageCount === 0 && !hasActivity;
  const stateWord = STATE_WORD[state];
  const troubled = state === "detached" || state === "offline";

  return (
    <div className="wc-workbench" data-state={state}>
      <div className="wc-wb-head" data-testid="wb-deck">
        <span className={`wc-wb-lamp wc-wb-lamp--${state}`} aria-hidden />
        <span className={`wc-wb-state wc-wb-state--${state}`} role="status" aria-live="polite">
          {stateWord}
          {state === "running" && elapsed ? <span className="wc-wb-elapsed"> · {elapsed}</span> : null}
        </span>
        <span className="wc-wb-div" aria-hidden />
        <span className="wc-wb-title" title={title}>{title}</span>
        {crumb ? <span className="wc-wb-crumb">{crumb}</span> : null}
        <span className="wc-wb-spacer" />
        <button
          type="button"
          className={`wc-wb-reattach${troubled ? " wc-wb-reattach--loud" : ""}`}
          onClick={reattach}
        >
          {troubled ? "REATTACH" : "RECONNECT"}
        </button>
      </div>
      <div className={`wc-wb-body${dragging ? " wc-wb-body--dragging" : ""}`} ref={bodyRef}>
        <div className="wc-wb-terminal">
          <RemoteShellPane sessionId={sessionId} hideBar reconnectNonce={nonce} onMetaChange={setMeta} />
          {troubled && (
            <div className="wc-wb-veil">
              <div className="wc-wb-plaque">
                <div className="wc-wb-plaque-title">{state === "detached" ? "Detached" : "Connection lost"}</div>
                <div className="wc-wb-plaque-sub">
                  {state === "detached"
                    ? "The tmux session is still running on the remote host."
                    : "The relay closed. Reattach to resume."}
                </div>
                <button type="button" className="wc-wb-reattach wc-wb-reattach--loud" onClick={reattach}>
                  REATTACH
                </button>
              </div>
            </div>
          )}
        </div>
        {!narrow && (
          <div
            className="wc-wb-seam"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the dispatch ledger"
            tabIndex={0}
            onPointerDown={onSeamPointerDown}
            onKeyDown={onSeamKeyDown}
            onDoubleClick={resetSeam}
          />
        )}
        <div
          className={`wc-wb-delegate${narrow && sheetOpen ? " wc-wb-delegate--open" : ""}`}
          data-testid="wb-dispatch"
          style={!narrow && delegateW !== null ? { flexBasis: delegateW } : undefined}
          onFocusCapture={onDelegateFocus}
        >
          {narrow ? (
            <button
              type="button"
              className="wc-wb-paneh wc-wb-paneh--btn"
              aria-expanded={sheetOpen}
              onClick={() => setSheetOpen((v) => !v)}
            >
              <span>Dispatch</span>
              <span className="wc-wb-paneh-right">
                {messageCount > 0 && !sheetOpen ? "OPEN" : messageCount}
                <svg
                  width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"
                  className={`wc-wb-chevron${sheetOpen ? " wc-wb-chevron--open" : ""}`}
                >
                  <path d="M2 6.5 5 3.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
          ) : (
            <div className="wc-wb-paneh">
              <span>Dispatch</span>
              <span className="wc-wb-paneh-right">{messageCount}</span>
            </div>
          )}
          {!narrow && emptyDelegate ? (
            <div className="wc-wb-empty">
              <p className="wc-wb-empty-lead">Nothing dispatched yet.</p>
              <p className="wc-wb-empty-sub">
                Instructions typed below are routed to the remote agent for this
                session. The console is where the work shows up.
              </p>
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}

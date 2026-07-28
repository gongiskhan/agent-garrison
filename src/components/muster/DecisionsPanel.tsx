"use client";

// The Muster Decisions panel (S5c, D12): a read-only feed of the most recent
// routing decisions the Dispatcher + gateway logged for this composition. Each
// row shows {kind, duty/level, target, reason} from the normalized tail of
// `.garrison/decisions.jsonl`. No secrets or paths: the reader whitelists scalar
// fields and the persisted records carry a digest, never the user's message. An
// empty feed (no session has routed yet) is the common first-run state.

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import type { DecisionView } from "@/lib/decisions-feed";
import styles from "./Orchestrator.module.css";

type Status = "loading" | "ready" | "error";

const FEED_LIMIT = 25;

function shortTime(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// Full precision for the hover title: the row shows minutes, but decisions
// inside one turn land seconds apart, so the exact stamp has to be reachable.
function fullWhen(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" });
}

// Fallback label when a session has no title yet: the leading segment of the id
// is enough to tell two sessions apart without spilling the whole uuid.
function shortSession(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

// Web Channel session deep-link. The channel keys threads by an opaque id, so
// this is the same handle the sidebar Views entry opens.
function sessionHref(id: string): string {
  return `/fitting/web-channel-default/?thread=${encodeURIComponent(id)}`;
}

export function DecisionsPanel({ compositionId }: { compositionId: string }) {
  const [decisions, setDecisions] = useState<DecisionView[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const res = await fetch(
        `/api/orchestrator/decisions?composition=${encodeURIComponent(id)}&limit=${FEED_LIMIT}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDecisions((data.decisions ?? []) as DecisionView[]);
      setStatus("ready");
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load(compositionId);
  }, [compositionId, load]);

  const summary = status === "ready" ? `${decisions.length} recent` : undefined;

  return (
    <section className={styles.section} data-testid="decisions-panel">
      <div className={styles.panelHead}>
        <span className={styles.panelLead}>
          The evidence feed: every routing decision the Dispatcher and gateway logged for this
          composition - which duty, at which level, to which target. Newest first.
        </span>
        {summary ? <span className={styles.panelSummary}>{summary}</span> : null}
      </div>
      <>
        {status === "loading" ? (
          <div className={styles.panelSkel} data-testid="decisions-loading" />
        ) : status === "error" ? (
          <div className={styles.panelState} data-testid="decisions-error">
            Could not load the decisions feed. {errorMsg}
          </div>
        ) : decisions.length === 0 ? (
          <div className={styles.panelState} data-testid="decisions-empty">
            No routing decisions logged yet. When the operative routes a request, the Dispatcher
            records the <b>duty</b>, <b>level</b>, and <b>target</b> it chose here.
          </div>
        ) : (
          <div className={styles.decisionsList} data-testid="decisions-list">
            {decisions.map((d, i) => {
              const misrouted = d.kind === "misroute" || d.reason?.includes("misrouted");
              return (
                <div className={styles.decisionRow} key={i} data-testid={`decision-row-${i}`}>
                  <span
                    className={clsx(
                      styles.decisionKind,
                      d.kind === "dispatch" && styles.dispatch,
                      misrouted && styles.misrouted
                    )}
                  >
                    {d.kind}
                  </span>
                  <span className={styles.decisionDuty}>
                    {d.duty ?? "route"}
                    {d.level != null ? <span className={styles.decisionLevel}>L{d.level}</span> : null}
                  </span>
                  <span className={styles.decisionReason}>{d.reason ?? ""}</span>
                  <span className={styles.decisionTarget}>{d.target ?? ""}</span>
                  {/* Time is its OWN column, always rendered. It used to live in
                      the target cell's else-branch, so a decision WITH a target
                      (the normal case) showed no timestamp at all - the feed read
                      as an undated list. */}
                  <span className={styles.decisionAt} title={fullWhen(d.at)}>
                    {shortTime(d.at)}
                  </span>
                  {/* The session that produced this decision, when the record
                      carries one. Records written before sessionId was recorded
                      have none, so this is absent rather than a dead link. */}
                  {d.sessionId ? (
                    <a
                      className={styles.decisionSession}
                      href={sessionHref(d.sessionId)}
                      target="_blank"
                      rel="noreferrer"
                      title={`Open the session that made this decision (${d.sessionId})`}
                    >
                      {d.sessionTitle || shortSession(d.sessionId)}
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </>
    </section>
  );
}

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
import { CollapsibleSection } from "./CollapsibleSection";
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
      <CollapsibleSection label="Recent decisions" summary={summary} testId="decisions-section">
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
                  <span className={styles.decisionTarget}>
                    {d.target ? (
                      d.target
                    ) : (
                      <span className={styles.decisionAt}>{shortTime(d.at)}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleSection>
    </section>
  );
}

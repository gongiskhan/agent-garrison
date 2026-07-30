"use client";

// The Muster Decisions panel (S5c, D12; verdicts added by RUN-SPEC-V1): the most
// recent routing decisions the Dispatcher + gateway logged for this composition,
// and the place to say whether each one was right.
//
// The feed was read-only in both directions — the orchestrator decided, the user
// watched. That is fine while the user makes the calls themselves, and wrong the
// moment every dimension defaults to auto: an automatic choice nobody can correct
// never gets better. So each row now carries a verdict (right / wrong / unsure) and,
// on "wrong", the counterfactual in the SAME vocabulary the run was decided with.
//
// Verdicts append to the Improver's existing feedback queue. The Improver turns
// accumulated verdicts into REVIEWABLE proposals and never auto-applies them, so a
// mistaken correction costs a rejected proposal rather than a silently re-routed
// fleet.
//
// SECURITY (unchanged): the reader whitelists scalar fields and the persisted
// records carry a digest, never the user's message. A verdict adds no free text —
// it is a closed vocabulary plus ids — so there is nothing new to redact.

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { DecisionView } from "@/lib/decisions-feed";
import { CORRECTION_FIELDS, type Correction, type Verdict } from "@/lib/decision-verdicts";
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
// this is the same handle the sidebar Fittings entry opens.
function sessionHref(id: string): string {
  return `/fitting/web-channel-default/?thread=${encodeURIComponent(id)}`;
}

/** What this decision actually resolved to, in the run-spec vocabulary — recorded
 *  alongside a correction so the Improver sees the delta without re-reading the log. */
function resolvedSpec(d: DecisionView): Correction {
  const out: Correction = {};
  if (d.target) out.target = d.target;
  if (d.model) out.model = d.model;
  if (d.effort) out.effort = d.effort;
  if (d.duty) out.duty = d.duty;
  if (d.tier) out.tier = d.tier;
  return out;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  right: "Right call",
  wrong: "Wrong",
  unsure: "Not sure"
};

/** Human names for the correction fields. The wire names are camelCase, and
 *  uppercased in the UI they render as WORKKIND / PHASESOFF - identifiers, not
 *  words. Only the two that need it are listed; the rest are already words. */
const FIELD_LABEL: Partial<Record<string, string>> = {
  workKind: "work kind",
  phasesOff: "phases off"
};

/**
 * The verdict control for one decision.
 *
 * "Not sure" is a first-class answer, not a cop-out: without it the only way to
 * express "I cannot evaluate this" is silence, and silence would read to the
 * Improver as approval.
 *
 * The correction is free text per dimension rather than a menu, deliberately: this
 * panel is a Garrison-shell surface and the routing vocabulary lives in the gateway
 * process, so a menu here would need a fourth copy of that catalogue. The value is
 * validated where every other pin is — at the gateway edge — and the Improver only
 * ever produces a proposal a human approves. A wrong string costs a rejected
 * proposal, not a misrouted run.
 */
function VerdictControls({
  decision,
  state,
  onSubmit
}: {
  decision: DecisionView;
  state: "idle" | "saving" | "saved" | "error";
  onSubmit: (verdict: Verdict, correction?: Correction) => void;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState<Correction>({});

  if (state === "saved") {
    return <span className={styles.decisionVerdictDone}>thanks — recorded for the Improver</span>;
  }

  return (
    <div className={styles.decisionVerdict}>
      {(["right", "wrong", "unsure"] as Verdict[]).map((v) => (
        <button
          key={v}
          type="button"
          className={clsx(styles.verdictBtn, v === "wrong" && styles.verdictBtnWrong)}
          disabled={state === "saving"}
          onClick={() => {
            // "Wrong" opens the correction rather than submitting immediately: the
            // counterfactual is the part that actually teaches the orchestrator
            // anything, and a one-tap "wrong" would throw it away.
            if (v === "wrong") setCorrecting((c) => !c);
            else onSubmit(v);
          }}
          aria-expanded={v === "wrong" ? correcting : undefined}
        >
          {VERDICT_LABEL[v]}
        </button>
      ))}
      {state === "error" ? <span className={styles.decisionVerdictErr}>could not record that</span> : null}
      {correcting ? (
        <div className={styles.correctionBox}>
          <span className={styles.correctionLead}>What should it have been? Leave blank what was fine.</span>
          <div className={styles.correctionGrid}>
            {CORRECTION_FIELDS.map((field) => (
              <label key={field} className={styles.correctionField}>
                <span>{FIELD_LABEL[field] ?? field}</span>
                <input
                  type="text"
                  value={correction[field] ?? ""}
                  placeholder={resolvedSpec(decision)[field] ?? "automatic"}
                  onChange={(e) => setCorrection((c) => ({ ...c, [field]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            className={styles.verdictBtn}
            disabled={state === "saving"}
            onClick={() => {
              const filled = Object.fromEntries(
                Object.entries(correction).filter(([, v]) => typeof v === "string" && v.trim())
              ) as Correction;
              // A bare "wrong" with no counterfactual is still recorded — it is a
              // weaker signal, not a non-signal, and refusing it would just lose it.
              onSubmit("wrong", Object.keys(filled).length ? filled : undefined);
              setCorrecting(false);
            }}
          >
            Record
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function DecisionsPanel({ compositionId }: { compositionId: string }) {
  const [decisions, setDecisions] = useState<DecisionView[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, "idle" | "saving" | "saved" | "error">>({});

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

  const submitVerdict = useCallback(
    async (decision: DecisionView, verdict: Verdict, correction?: Correction) => {
      setVerdicts((v) => ({ ...v, [decision.id]: "saving" }));
      try {
        const res = await fetch("/api/orchestrator/decisions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decisionId: decision.id,
            verdict,
            resolved: resolvedSpec(decision),
            correction,
            sessionId: decision.sessionId
          })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setVerdicts((v) => ({ ...v, [decision.id]: "saved" }));
      } catch {
        setVerdicts((v) => ({ ...v, [decision.id]: "error" }));
      }
    },
    []
  );

  // How many of these the orchestrator chose without being told. The headline
  // number for "we default to auto" — and the size of the surface worth reviewing.
  const autoCount = useMemo(
    () => decisions.filter((d) => d.via !== "turn-override" && d.classifierSkipped !== true).length,
    [decisions]
  );

  const summary = status === "ready" ? `${decisions.length} recent · ${autoCount} automatic` : undefined;

  return (
    <section className={styles.section} data-testid="decisions-panel">
      <div className={styles.panelHead}>
        <span className={styles.panelLead}>
          The evidence feed: every routing decision the Dispatcher and gateway logged for this
          composition - which duty, at which level, to which target. Newest first. Say whether a
          call was right and the Improver learns what to choose next time.
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
              // `misrouted` comes from the composed reason: the writer sets
              // honored:false and decisions-feed pushes the literal word. There is
              // no `kind: "misroute"` writer, so testing for one was dead code.
              const misrouted = d.reason?.includes("misrouted") ?? false;
              // Auto = the orchestrator chose it. A turn-override or a skipped
              // classification means the USER had already decided, so marking it
              // "auto" would invite them to correct their own choice.
              const auto = d.via !== "turn-override" && d.classifierSkipped !== true;
              return (
                <div className={styles.decisionRow} key={d.id} data-testid={`decision-row-${i}`}>
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
                  {/* Who chose it. The whole point of "auto by default" is that the
                      user can see which calls were not theirs. */}
                  <span
                    className={clsx(styles.decisionVia, auto && styles.decisionViaAuto)}
                    title={
                      auto
                        ? `chosen automatically${d.via ? ` (${d.via})` : ""} - you pinned nothing here`
                        : `you chose this${d.classifierSkipped ? " - no classifier ran" : ""}`
                    }
                  >
                    {auto ? "auto" : "yours"}
                  </span>
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
                  <VerdictControls
                    decision={d}
                    state={verdicts[d.id] ?? "idle"}
                    onSubmit={(verdict, correction) => void submitVerdict(d, verdict, correction)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </>
    </section>
  );
}

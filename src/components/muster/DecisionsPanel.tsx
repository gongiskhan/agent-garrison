"use client";

// The Muster Decisions panel (S5c, D12; verdicts added by RUN-SPEC-V1): the most
// recent routing decisions Orchestrator + gateway logged for this composition,
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { DecisionView } from "@/lib/decisions-feed";
import { type Correction, type Verdict } from "@/lib/decision-verdicts";
import {
  CARD_FIELD_ORDER,
  fetchRouteOptions,
  fieldLabel,
  optionsForField,
  postVerdict,
  resolvedSpec,
  verdictPayload,
  type RouteOptionsResponse
} from "@/lib/decision-feedback";
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

// Conversation deep-link. Threads are keyed by an opaque id, so this is the
// same handle the Conversations route opens.
function sessionHref(id: string): string {
  return `/talk/${encodeURIComponent(id)}`;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  right: "Right call",
  wrong: "Wrong",
  unsure: "Not sure"
};

/**
 * The verdict control for one decision.
 *
 * "Not sure" is a first-class answer, not a cop-out: without it the only way to
 * express "I cannot evaluate this" is silence, and silence would read to the
 * Improver as approval.
 *
 * The correction was free text per dimension because the routing vocabulary lives
 * in the gateway process and a menu here would have needed a fourth copy of that
 * catalogue. It no longer does: the shell proxies the gateway's own
 * `/route/options` (`/api/orchestrator/route-options`), so both verdict surfaces
 * offer the SAME list the edge validates a value against, and neither can offer
 * one that would then be refused. Typed values survive only as the fallback for a
 * gateway that is not answering — a missing vocabulary must not block a
 * correction.
 */
function VerdictControls({
  decision,
  state,
  options,
  onNeedOptions,
  onSubmit
}: {
  decision: DecisionView;
  state: "idle" | "saving" | "saved" | "error";
  /** null while the routing vocabulary has not been read yet. */
  options: RouteOptionsResponse | null;
  onNeedOptions: () => void;
  onSubmit: (verdict: Verdict, correction?: Correction) => void;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState<Correction>({});
  const resolved = resolvedSpec(decision);

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
            if (v === "wrong") {
              setCorrecting((c) => !c);
              // Read the vocabulary on the first correction, not on every feed
              // load: opening this box is the only thing that needs it.
              onNeedOptions();
            } else onSubmit(v);
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
          {/* The grid waits for the vocabulary rather than rendering as text
              inputs that turn into menus a moment later - a value typed into the
              input the menu replaces would be silently dropped. */}
          {options === null ? (
            <span className={styles.correctionLead}>reading the routing vocabulary</span>
          ) : (
            <div className={styles.correctionGrid}>
              {CARD_FIELD_ORDER.map((field) => {
                const choices = optionsForField(field, options, decision);
                return (
                  <label key={field} className={styles.correctionField}>
                    <span>{fieldLabel(field)}</span>
                    {choices.length ? (
                      <select
                        value={correction[field] ?? ""}
                        onChange={(e) => setCorrection((c) => ({ ...c, [field]: e.target.value }))}
                      >
                        {/* The empty row is "leave this dimension alone", named
                            after what actually ran so it is not mistaken for a
                            value that would be sent. */}
                        <option value="">
                          {resolved[field] ? `${resolved[field]} (unchanged)` : "automatic"}
                        </option>
                        {choices.map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.detail ? `${choice.value} - ${choice.detail}` : choice.value}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={correction[field] ?? ""}
                        placeholder={resolved[field] ?? "automatic"}
                        onChange={(e) => setCorrection((c) => ({ ...c, [field]: e.target.value }))}
                      />
                    )}
                  </label>
                );
              })}
            </div>
          )}
          {options && !options.available ? (
            <span className={styles.correctionLead}>
              {options.reason ?? "the gateway is not answering - type the values instead"}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.verdictBtn}
            disabled={state === "saving"}
            onClick={() => {
              // Blank dimensions are dropped by the shared payload builder, and a
              // bare "wrong" with no counterfactual is still recorded — it is a
              // weaker signal, not a non-signal, and refusing it would lose it.
              onSubmit("wrong", correction);
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
  // The routing vocabulary for the correction menus. Panel-level so 25 rows share
  // ONE read, and lazy so a feed nobody corrects never touches the gateway.
  const [options, setOptions] = useState<RouteOptionsResponse | null>(null);
  const optionsAsked = useRef(false);

  const needOptions = useCallback(() => {
    if (optionsAsked.current) return;
    optionsAsked.current = true;
    void fetchRouteOptions().then(setOptions);
  }, []);

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
        // The SAME builder and endpoint the home page's card uses: two surfaces
        // that record verdicts in two shapes would train the Improver on two
        // different things.
        await postVerdict(verdictPayload(decision, verdict, correction));
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
          The evidence feed: every routing decision Orchestrator and the gateway logged for this
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
            No routing decisions logged yet. When the session routes a request, Orchestrator
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
                    options={options}
                    onNeedOptions={needOptions}
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

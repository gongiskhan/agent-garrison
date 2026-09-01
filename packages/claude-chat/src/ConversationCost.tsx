import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUsd } from "./SessionTranscript";

/**
 * The conversation's running cost, in the header.
 *
 * Three honesty rules, all of which cost more code than the naive version and
 * all of which are the point:
 *
 *   - A conversation with unpriced stretches shows the total it CAN account for
 *     and says how many it cannot. It never quietly reports a partial sum as
 *     the whole.
 *   - The rate table's date is on the breakdown. A number priced from stale
 *     rates should be visibly stale rather than confidently wrong.
 *   - The provider SDK's own reported cost sits beside ours whenever it is
 *     available. If the two disagree, the reader sees the disagreement.
 */
export type ConversationCostMetrics = {
  stretches: number;
  apiCalls: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWrite5mTokens: number;
    cacheWrite1hTokens: number;
    cacheReadTokens: number;
  } | null;
  cacheReadShare: number;
  totalCostUsd: number | null;
  sdkCostUsd: number | null;
  unpricedStretches: number;
  exactlyPricedStretches: number;
  byDuty: Record<string, { stretches: number; usedTokens: number; apiCalls?: number; usd?: number; unpriced?: number }>;
  byModel: Record<string, { apiCalls: number; usd: number | null; unpriced?: boolean; usage?: Record<string, number> }>;
  ratesUpdated: string | null;
};

const num = (n: number) => n.toLocaleString("en-US");

export function ConversationCost({
  conversationId,
  base,
  /** Bumped by the host whenever the transcript advances, so the total follows
   *  the conversation instead of going stale after the first stretch. */
  generation,
}: {
  conversationId: string;
  base: string;
  generation?: number | string | null;
}) {
  const [metrics, setMetrics] = useState<ConversationCostMetrics | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = `${base}/${encodeURIComponent(conversationId)}/metrics`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && body && typeof body === "object") setMetrics(body as ConversationCostMetrics);
      })
      .catch(() => {
        /* the running total is ambient: a failed poll shows the last good value */
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, base, generation]);

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  if (!metrics || !metrics.stretches) return null;
  const total = metrics.totalCostUsd;
  const unpriced = metrics.unpricedStretches ?? 0;
  // No priced stretch at all: say so rather than render "$0".
  const label = total == null ? "cost unpriced" : formatUsd(total);
  const partial = total != null && unpriced > 0;

  const duties = Object.entries(metrics.byDuty ?? {})
    .map(([duty, d]) => ({ duty, usd: d.usd ?? 0, stretches: d.stretches, unpriced: d.unpriced ?? 0 }))
    .sort((a, b) => b.usd - a.usd);
  const models = Object.entries(metrics.byModel ?? {})
    .map(([model, m]) => ({ model, usd: m.usd, apiCalls: m.apiCalls, unpriced: m.unpriced === true }))
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

  return (
    <div className="cc-conv-cost" ref={boxRef}>
      <button
        type="button"
        className={`cc-conv-costbtn${partial ? " cc-conv-costbtn-partial" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          total == null
            ? "no stretch in this conversation could be priced"
            : partial
              ? `${formatUsd(total)} across the priced stretches; ${unpriced} could not be priced`
              : "list-rate cost of this conversation - click for the breakdown"
        }
      >
        {label}
        {partial && <span className="cc-conv-costwarn" aria-hidden="true">+?</span>}
      </button>
      {open && (
        <div className="cc-conv-costpanel" role="dialog" aria-label="Cost breakdown">
          <div className="cc-conv-costrow cc-conv-costhead">
            <span>{metrics.stretches} stretches</span>
            <span>{num(metrics.apiCalls)} API calls</span>
          </div>
          {metrics.usage && (
            <div className="cc-conv-costrow">
              <span>cache read share</span>
              <span>{(metrics.cacheReadShare * 100).toFixed(1)}%</span>
            </div>
          )}
          {metrics.usage && (
            <div className="cc-conv-costrow cc-conv-costsplit cc-conv-costdim">
              <span>in / out / cache w / cache r</span>
              <span>
                {num(metrics.usage.inputTokens)} / {num(metrics.usage.outputTokens)} /{" "}
                {num(metrics.usage.cacheWrite5mTokens + metrics.usage.cacheWrite1hTokens)} /{" "}
                {num(metrics.usage.cacheReadTokens)}
              </span>
            </div>
          )}
          {duties.length > 0 && <div className="cc-conv-costsub">by duty</div>}
          {duties.map((d) => (
            <div className="cc-conv-costrow" key={`duty-${d.duty}`}>
              <span>
                {d.duty}
                <span className="cc-conv-costdim"> x{d.stretches}</span>
              </span>
              <span>
                {d.usd > 0 ? formatUsd(d.usd) : "-"}
                {d.unpriced > 0 && <span className="cc-conv-costwarn"> +{d.unpriced}?</span>}
              </span>
            </div>
          ))}
          {models.length > 0 && <div className="cc-conv-costsub">by model</div>}
          {models.map((m) => (
            <div className="cc-conv-costrow" key={`model-${m.model}`}>
              <span>
                {m.model}
                <span className="cc-conv-costdim"> x{m.apiCalls}</span>
              </span>
              <span>{m.unpriced || m.usd == null ? "unpriced" : formatUsd(m.usd)}</span>
            </div>
          ))}
          {unpriced > 0 && (
            <div className="cc-conv-costrow cc-conv-costwarn">
              <span>unpriced stretches</span>
              <span>{unpriced}</span>
            </div>
          )}
          {metrics.sdkCostUsd != null && (
            <div className="cc-conv-costrow cc-conv-costdim">
              <span>provider SDK reported</span>
              <span>{formatUsd(metrics.sdkCostUsd)}</span>
            </div>
          )}
          <div className="cc-conv-costfoot">
            list API rates{metrics.ratesUpdated ? `, updated ${metrics.ratesUpdated}` : ""} - these sessions
            may bill against a subscription
          </div>
        </div>
      )}
    </div>
  );
}

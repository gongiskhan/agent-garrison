// Builds the prefix prepended to user-turn content before it's written to
// the orchestrator's stdin. Encodes:
//   1. The request origin ("ui-tab" or "channel") so the orchestrator can
//      default talk_to's mode appropriately.
//   2. Channel id (default "main").
//   3. Any acknowledged-as-completed soul session summaries since the last turn.
//   4. An optional resolved route hint (the Kanban Loop's explicit
//      {taskType,tier} honored by the gateway) so the orchestrator delegates at
//      the resolved role/tier instead of re-classifying. Absent → identical to
//      the prior output.

export function buildOrchestratorTurn({
  origin = "channel",
  channel = "main",
  mode = null,
  message,
  pendingSummaries = [],
  routeHint = null
}) {
  const summaryClause =
    pendingSummaries.length > 0
      ? `[Recent sub-session summaries — ${pendingSummaries
          .map((s) => `${s.soul ?? "soul"}/${s.sessionId?.slice(0, 8) ?? "?"}: ${truncate(s.summary, 400)}`)
          .join("; ")}]\n\n`
      : "";
  const routeClause = routeHint
    ? `[gateway-route (honored hint) — task: ${routeHint.classification?.taskType ?? "?"}, tier: ${routeHint.tier ?? "?"}, role: ${routeHint.role ?? "?"}, target: ${routeHint.targetId ?? "?"}${routeHint.model ? `, model: ${routeHint.model}` : ""}${routeHint.effort ? `/${routeHint.effort}` : ""}. Delegate at this role/tier.]\n\n`
    : "";
  const originLine = `[origin: ${origin}, channel: ${channel}${mode ? `, mode: ${mode}` : ""}]\n\n`;
  return `${originLine}${routeClause}${summaryClause}${message}`;
}

function truncate(text, max) {
  if (!text) return "";
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

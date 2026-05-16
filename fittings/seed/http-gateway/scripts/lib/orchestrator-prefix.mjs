// Builds the prefix prepended to user-turn content before it's written to
// the orchestrator's stdin. Encodes:
//   1. The request origin ("workbench" or "channel") so the orchestrator can
//      default talk_to's mode appropriately.
//   2. Channel id (default "main").
//   3. Any acknowledged-as-completed soul session summaries since the last turn.

export function buildOrchestratorTurn({
  origin = "channel",
  channel = "main",
  message,
  pendingSummaries = []
}) {
  const summaryClause =
    pendingSummaries.length > 0
      ? `[Recent sub-session summaries — ${pendingSummaries
          .map((s) => `${s.soul ?? "soul"}/${s.sessionId?.slice(0, 8) ?? "?"}: ${truncate(s.summary, 400)}`)
          .join("; ")}]\n\n`
      : "";
  const originLine = `[origin: ${origin}, channel: ${channel}]\n\n`;
  return `${originLine}${summaryClause}${message}`;
}

function truncate(text, max) {
  if (!text) return "";
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

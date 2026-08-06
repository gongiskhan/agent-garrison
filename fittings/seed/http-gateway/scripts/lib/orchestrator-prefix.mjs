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
  routeHint = null,
  inbound = null
}) {
  // External-connector turns (whatsapp-web) name the sender + surface so the
  // operative answers the right person on the right channel instead of treating
  // the text as a bare probe. name/jid are sanitizeTag'd — the sender controls
  // their pushName, so they must not be able to forge a bracketed directive.
  const inboundClause = inbound
    ? `[Inbound ${sanitizeTag(inbound.surface || "message")} from ${sanitizeTag(inbound.name || inbound.jid || "unknown")}${inbound.jid ? ` (${sanitizeTag(inbound.jid)})` : ""}. This is a real person messaging Gabriel. Reply on his behalf ONLY if this contact is authorized for auto-reply (check memory); the reply must be delivered by sending a message back to them through the whatsapp-web send_text connector — text you write here is NOT delivered to them. If the contact is not authorized, do not send anything.]\n\n`
    : "";
  const summaryClause =
    pendingSummaries.length > 0
      ? `[Recent sub-session summaries — ${pendingSummaries
          .map((s) => `${s.soul ?? "soul"}/${s.sessionId?.slice(0, 8) ?? "?"}: ${truncate(s.summary, 400)}`)
          .join("; ")}]\n\n`
      : "";
  const routeClause = routeHint
    ? `[gateway-route (honored hint) — task: ${routeHint.classification?.taskType ?? "?"}, tier: ${routeHint.tier ?? "?"}, role: ${routeHint.role ?? "?"}, target: ${routeHint.targetId ?? "?"}${routeHint.model ? `, model: ${routeHint.model}` : ""}${routeHint.effort ? `/${routeHint.effort}` : ""}. Delegate at this role/tier.]\n\n`
    : "";
  // origin/channel/mode are caller-controlled (body.channel, x-garrison-origin).
  // Strip brackets + newlines so a caller can't break out of this tag and forge a
  // `[gateway-route … Delegate at expert]`-style directive the orchestrator obeys.
  const originLine = `[origin: ${sanitizeTag(origin)}, channel: ${sanitizeTag(channel)}${mode ? `, mode: ${sanitizeTag(mode)}` : ""}]\n\n`;
  return `${originLine}${routeClause}${inboundClause}${summaryClause}${message}`;
}

function sanitizeTag(v) {
  return String(v ?? "").replace(/[[\]\r\n]/g, "").slice(0, 64);
}

function truncate(text, max) {
  if (!text) return "";
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Pure derivation of a card's one-line status sentence for the HUD's TAREFAS
// panel — kanban has no such field, so it's derived from status + list +
// lastEvent (+ runningSince/liveTail/attention). Extracted from server.mjs so it
// can be unit-tested. `now` is injectable so tests are time-independent.

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

// Order the Tasks-panel cards: running first, then needs-attention, then the rest,
// each group most-recently-updated first; cap to `limit`. Pure so it's testable.
export function rankAndCapCards(cards, limit = 8) {
  const rank = (s) => (s === "running" ? 0 : s === "needs-attention" ? 1 : 2);
  return [...cards]
    .sort((a, b) => rank(a.status) - rank(b.status) || String(b.updated).localeCompare(String(a.updated)))
    .slice(0, limit);
}

export function deriveStatusLine(card, listTitle, now = Date.now()) {
  const lastMsg = card.lastEvent?.message || "";
  if (card.status === "running") {
    let line = "A correr";
    if (Number.isFinite(card.iterations)) line += ` — iteração ${card.iterations}`;
    const ago = timeAgo(card.runningSince, now);
    if (ago) line += ` (há ${ago})`;
    const tail = Array.isArray(card.liveTail) && card.liveTail.length ? card.liveTail[card.liveTail.length - 1] : null;
    if (tail) line += ` — ${tail}`;
    return line;
  }
  if (card.status === "needs-attention") {
    return `Precisa de atenção: ${card.attentionReason || lastMsg || "—"}`;
  }
  if (card.lastDispatchError?.message) {
    return `Falhou o dispatch: ${card.lastDispatchError.message}`;
  }
  return lastMsg ? `${listTitle} · ${lastMsg}` : listTitle;
}

// Weekly board review (stall detection) — the single board-summary source
// inside the fitting. The Next.js app has its own read-only projection
// (src/lib/board-summary.ts); THIS module is what the fitting's own callers
// (the --review CLI today, any future rollup) build on, on top of
// loadAllCards/loadBoard. Pure: computeReview takes cards + a clock and
// returns buckets; it never reads disk and NEVER moves cards — the review
// reports and notifies only, so it cannot fight the engine.

const TERMINAL_LIST = "done";
const ATTENTION_LIST = "needs-attention";

export const DEFAULT_STALL_HOURS = 2;
export const REVIEW_WINDOW_DAYS = 7;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function ms(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

function fmtAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "unknown age";
  const days = Math.floor(deltaMs / DAY_MS);
  const hours = Math.floor((deltaMs % DAY_MS) / HOUR_MS);
  const mins = Math.floor((deltaMs % HOUR_MS) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// The three review buckets. Precedence: attention > stalled > moving — a card
// appears in exactly one bucket (or none), so the report reads as a partition
// of what needs eyes vs what is healthy.
//   attention — everything currently parked in needs-attention.
//   stalled   — on a non-terminal, non-attention list, and any of:
//                 (a) status running with runningSince older than stallMs,
//                 (b) waitingOn.since older than stallMs,
//                 (c) not updated within windowMs.
//   moving    — a routed (engine advance) or moved (manual move) event within
//               windowMs, and not stalled. Cards on done count: work that
//               finished inside the window is exactly what moved this week.
export function computeReview({ cards, now, stallMs = DEFAULT_STALL_HOURS * HOUR_MS, windowMs = REVIEW_WINDOW_DAYS * DAY_MS } = {}) {
  const nowMs = typeof now === "number" ? now : ms(now);
  if (!Number.isFinite(nowMs)) throw new Error("computeReview needs a valid `now` (ISO string or ms)");
  const all = Array.isArray(cards) ? cards.filter((c) => c && typeof c === "object") : [];

  const attention = [];
  const stalled = [];
  const moving = [];

  for (const card of all) {
    if (card.list === ATTENTION_LIST) {
      attention.push({ card, reason: card.attentionReason || "parked" });
      continue;
    }
    if (card.list !== TERMINAL_LIST) {
      const reasons = [];
      const runningSince = card.status === "running" ? ms(card.runningSince) : null;
      if (runningSince !== null && nowMs - runningSince > stallMs) {
        reasons.push(`running for ${fmtAge(nowMs - runningSince)}`);
      }
      const waitingSince = card.waitingOn ? ms(card.waitingOn.since) : null;
      if (waitingSince !== null && nowMs - waitingSince > stallMs) {
        const on = card.waitingOn.cardTitle || card.waitingOn.cardId || card.waitingOn.until || "another card";
        reasons.push(`waiting on ${on} for ${fmtAge(nowMs - waitingSince)}`);
      }
      const updated = ms(card.updated);
      if (updated !== null && nowMs - updated > windowMs) {
        reasons.push(`untouched for ${fmtAge(nowMs - updated)}`);
      }
      if (reasons.length) {
        stalled.push({ card, reasons });
        continue;
      }
    }

    const recentlyMoved = (Array.isArray(card.events) ? card.events : []).some((ev) => {
      if (!ev || (ev.kind !== "routed" && ev.kind !== "moved")) return false;
      const at = ms(ev.at);
      return at !== null && nowMs - at <= windowMs;
    });
    if (recentlyMoved) moving.push({ card });
  }

  return { moving, stalled, attention, nowMs, stallMs, windowMs };
}

function cardLine({ card, reason, reasons }) {
  const bits = [
    `\`${card.id}\``,
    (card.title || "(untitled)").trim(),
    `[${card.list}]`
  ];
  if (card.project) bits.push(`(${card.project})`);
  if (card.workKind) bits.push(`{${card.workKind}}`);
  const detail = reasons ? reasons.join("; ") : reason;
  return `- ${bits.join(" ")}${detail ? ` - ${detail}` : ""}`;
}

export function renderReviewMarkdown(review, { now } = {}) {
  const at = typeof now === "string" ? now : new Date(review.nowMs).toISOString();
  const lines = [
    `# Kanban weekly review - ${at.slice(0, 10)}`,
    "",
    `Generated ${at}. Stall threshold ${fmtAge(review.stallMs)}, activity window ${fmtAge(review.windowMs)}.`,
    "",
    `## Needs attention (${review.attention.length})`,
    ""
  ];
  lines.push(...(review.attention.length ? review.attention.map(cardLine) : ["- none"]));
  lines.push("", `## Stalled (${review.stalled.length})`, "");
  lines.push(...(review.stalled.length ? review.stalled.map(cardLine) : ["- none"]));
  lines.push("", `## Moving - last ${Math.round(review.windowMs / DAY_MS)} days (${review.moving.length})`, "");
  lines.push(...(review.moving.length ? review.moving.map(cardLine) : ["- none"]));
  lines.push("");
  return lines.join("\n");
}

// The short notification body (the report file holds the detail).
export function reviewNoticeText(review, reportPath) {
  const lines = [
    `Weekly board review: ${review.attention.length} needs attention, ${review.stalled.length} stalled, ${review.moving.length} moving.`
  ];
  for (const s of review.stalled.slice(0, 5)) {
    lines.push(`Stalled: ${(s.card.title || "(untitled)").trim()} [${s.card.list}] - ${s.reasons.join("; ")}`);
  }
  if (review.stalled.length > 5) lines.push(`...and ${review.stalled.length - 5} more stalled.`);
  if (reportPath) lines.push(`Report: ${reportPath}`);
  return lines.join("\n");
}

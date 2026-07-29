// Kanban → Drill handoff: "this card's change landed, go test it."
//
// A done card already knows everything Drill's planner needs to scope a test
// plan to ONE change: what was asked for, what the run concluded, which files
// it touched, and which commits carry it. The WS2 handoff packet
// (cards/<id>/handoff.json) has collected exactly that since the card landed —
// this module reshapes it into the change brief the Drill plan agent reads in
// UPDATE mode, and posts it.
//
// Why a brief and not "just run the Book": an UPDATE-mode plan authors checks
// for the change, and Drill then runs only the pages that plan touched. Handing
// over a vague brief costs the whole difference — the plan widens, the run
// widens, and the verdict stops being about this card.

import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { composeHandoff } from "./handoff.mjs";

function garrisonHome() {
  return process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
}

/** The running Drill fitting's base URL, via the URL-link contract. Never a baked port. */
export function drillBaseUrl() {
  try {
    const file = path.join(garrisonHome(), "ui-fittings", "drill.json");
    if (!existsSync(file)) return null;
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return typeof doc.url === "string" && doc.url ? doc.url : null;
  } catch {
    return null;
  }
}

export function boardBaseUrl() {
  try {
    const file = path.join(garrisonHome(), "ui-fittings", "kanban-loop.json");
    if (!existsSync(file)) return null;
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return typeof doc.url === "string" && doc.url ? doc.url : null;
  } catch {
    return null;
  }
}

function clip(text, max) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * The change brief handed to Drill's UPDATE-mode plan agent. Pure w.r.t. the
 * passed card + packet, so the wording is testable and stable.
 *
 * Bounded on purpose: this is a PROMPT, and a card whose description is a
 * 40 KB pasted transcript would otherwise drown the instruction that follows
 * it. Files are the highest-signal part (they tell the planner where to look),
 * so they get the largest share.
 */
export function composeChangeBrief(card, packet = null) {
  const lines = [];
  lines.push(`Change: ${clip(card.title, 200) || "(untitled card)"}`);

  const asked = clip(card.description, 1200);
  if (asked) lines.push("", "What was asked for:", asked);

  const summary = clip(packet?.completionSummary ?? card.lastReply, 1500);
  if (summary) lines.push("", "What was built (the run's own close-out):", summary);

  const decisions = Array.isArray(packet?.keyDecisions) ? packet.keyDecisions.filter(Boolean).slice(0, 10) : [];
  if (decisions.length) {
    lines.push("", "Key decisions:");
    for (const d of decisions) lines.push(`- ${clip(d, 240)}`);
  }

  const files = Array.isArray(packet?.filesTouched) ? packet.filesTouched.filter(Boolean).slice(0, 60) : [];
  if (files.length) {
    lines.push("", "Files touched:");
    for (const f of files) lines.push(`- ${clip(f, 200)}`);
  }

  const shas = (Array.isArray(card.fences) ? card.fences : [])
    .map((f) => f?.sha)
    .filter((s) => typeof s === "string")
    .slice(-10)
    .map((s) => s.slice(0, 10));
  if (shas.length) lines.push("", `Commits: ${shas.join(", ")}`);

  lines.push(
    "",
    "Scope the Book update to THIS change: the pages a user would see it on, and the checks that",
    "would catch it regressing. Do not re-plan unrelated pages - only the pages this change reaches",
    "will be run."
  );
  return lines.join("\n");
}

/**
 * Is this card eligible to be sent to Drill, and if not, why? Pure — the UI
 * and the endpoint must agree on the rule, and "why not" is more useful to
 * show than a disabled button with no explanation.
 */
export function drillEligibility(card) {
  if (!card) return { ok: false, reason: "no card" };
  if (card.list !== "done") return { ok: false, reason: "only a card on `done` can be sent to Drill" };
  if (!card.project) return { ok: false, reason: "the card has no project repo, so there is nothing to test" };
  return { ok: true };
}

/**
 * POST the card's change brief to Drill. Returns Drill's job record.
 * Throws with a readable message — the caller is a user-initiated button
 * press, so a failure must be shown, not swallowed.
 */
export async function sendCardToDrill(root, card, { fetchImpl = fetch } = {}) {
  const base = drillBaseUrl();
  if (!base) throw new Error("the Drill fitting is not running - start it from Views, then try again");
  let packet = null;
  try {
    packet = composeHandoff(card, { root });
  } catch {
    /* the brief degrades to the card's own fields - never block the handoff */
  }
  const res = await fetchImpl(`${base}/api/card-drill`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      card: {
        id: card.id,
        title: card.title ?? null,
        project: card.project ?? null,
        originChannel: card.originChannel ?? null
      },
      brief: composeChangeBrief(card, packet),
      project: card.project,
      boardUrl: boardBaseUrl()
    })
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* keep the status */
    }
    throw new Error(`Drill refused the handoff: ${detail}`);
  }
  const body = await res.json();
  return { job: body.job ?? null, started: body.started !== false, drillUrl: base };
}

/**
 * The card-side record of a drill handoff. Kept small and flat — this is a
 * board projection, not a copy of Drill's job.
 */
export function drillStamp({ state, jobId = null, at = new Date().toISOString(), ...rest }) {
  return { state, jobId, at, ...rest };
}

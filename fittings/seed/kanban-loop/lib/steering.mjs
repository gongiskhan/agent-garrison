// Steering sidecars (S3c, D9). A mid-run thread message about a card lands here:
//   cards/<id>/steering.md    — append-only guidance the engine folds into the
//                               current duty's prompt (like brief.md)
//   cards/<id>/steering.json  — the pending revisit directive the loop applies at
//                               a duty boundary (re-stage the card to an earlier phase)
// Shared by the board server (writes) and the engine (reads + applies). Best-effort
// throughout: a sidecar failure never breaks a card write.

import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from "node:fs";

// The board-side steering vocabulary (independent of the dispatcher's steer-core,
// which owns classification; this is the on-disk/endpoint contract).
export const STEER_ACTIONS = ["absorb", "revisit", "acknowledge"];

// The go-back invariant: revisitDuty must sit EARLIER than the card's current phase
// in its sequence, so a re-stage never marches a card FORWARD past gates. Only
// enforceable when the card carries a sequence; without one (legacy card) we cannot
// validate and allow it (the classifier already validated against the sequence).
//
// A card whose CURRENT list is off the sequence — a TERMINAL card (done /
// needs-attention) is the important case — is re-ENTERING the pipeline: every phase
// in its sequence sits "earlier" than being finished/parked, so any valid in-sequence
// target is allowed. This is exactly the human-feedback path (a card reached the end,
// the user sends it back to plan/implement to fold in what was missed); without it the
// endpoint would reject every revisit on a done card (cur = -1). The target must still
// name a real phase in the sequence, so a typo can never re-stage the card nowhere.
export function isEarlierPhase(card, revisitDuty) {
  const seq = Array.isArray(card?.sequence) ? card.sequence : null;
  if (!seq || !seq.length) return true;
  const tgt = seq.indexOf(revisitDuty);
  if (tgt < 0) return false;
  // Conversations: lists are STATES, the current phase is the card's DUTY.
  // A terminal-list card (done / needs-attention) is re-ENTERING, so any
  // in-sequence phase qualifies regardless of the duty it stopped on.
  if (card?.list === "done" || card?.list === "needs-attention" || card?.list === "archived") return true;
  // Duty first, list fallback (a legacy card's duty names its FLOW, not a leaf).
  let cur = seq.indexOf(card?.duty);
  if (cur < 0) cur = seq.indexOf(card?.list);
  // Off-sequence (parked / no duty) → re-entry: any in-sequence phase is earlier.
  if (cur < 0) return true;
  return tgt < cur;
}

export function steeringMdFile(root, id) {
  return path.join(root, "cards", id, "steering.md");
}
export function steeringJsonFile(root, id) {
  return path.join(root, "cards", id, "steering.json");
}

// Append one steering entry to steering.md: "## <ISO> [<action>]\n<message>\n".
export function appendSteeringMd(root, id, { at, action, message }) {
  try {
    const file = steeringMdFile(root, id);
    mkdirSync(path.dirname(file), { recursive: true });
    const entry = `## ${at} [${action}]\n${String(message ?? "").trim()}\n\n`;
    appendFileSync(file, entry, "utf8");
    return true;
  } catch {
    return false;
  }
}

// The steering guidance text the engine folds into the build prompt (size-capped,
// like readCardBrief). Null when absent/empty.
export function readSteeringMd(root, id, max = 4000) {
  try {
    const file = steeringMdFile(root, id);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8").trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max).trimEnd() + "\n\n…(steering truncated)" : text;
  } catch {
    return null;
  }
}

// Write (overwrite) the pending revisit directive. Newest revisit wins.
export function writeSteeringDirective(root, id, directive) {
  try {
    const file = steeringJsonFile(root, id);
    mkdirSync(path.dirname(file), { recursive: true });
    const rec = { applied: false, ...directive };
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
    }
    return rec;
  } catch {
    return null;
  }
}

// The PENDING (unapplied) revisit directive, or null.
export function readSteeringDirective(root, id) {
  try {
    const file = steeringJsonFile(root, id);
    if (!existsSync(file)) return null;
    const rec = JSON.parse(readFileSync(file, "utf8"));
    if (!rec || rec.applied === true) return null;
    return rec;
  } catch {
    return null;
  }
}

// Mark the pending directive applied. Only acts on an UNapplied directive (so it
// never clobbers an earlier appliedReason). `reason` records WHY (e.g. the
// terminal-edge "obsolete-terminal" clear). Returns true when it marked one.
export function markSteeringApplied(root, id, reason = null) {
  try {
    const file = steeringJsonFile(root, id);
    if (!existsSync(file)) return false;
    const rec = JSON.parse(readFileSync(file, "utf8"));
    if (!rec || rec.applied === true) return false;
    rec.applied = true;
    rec.appliedAt = new Date().toISOString();
    if (reason) rec.appliedReason = reason;
    writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

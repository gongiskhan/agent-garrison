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
export function isEarlierPhase(card, revisitDuty) {
  const seq = Array.isArray(card?.sequence) ? card.sequence : null;
  if (!seq || !seq.length) return true;
  const cur = seq.indexOf(card?.list);
  const tgt = seq.indexOf(revisitDuty);
  return tgt >= 0 && cur >= 0 && tgt < cur;
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

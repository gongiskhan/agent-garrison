// Ephemeral, card-local pointer to the runtime journal for the CURRENT run.
//
// The gateway announces a session before the turn completes, but card.json is
// guarded by a revision CAS for the whole run. Writing the session id into the
// card mid-turn would bump that revision and make the terminal transition lose
// its acquire. A generation-keyed sidecar gives Watch the early coordinate
// without participating in card state. Generation-specific filenames also mean
// a late cleanup from run N can never remove run N+1's pointer.

import { promises as fs } from "node:fs";
import path from "node:path";
import { ulid } from "./ulid.mjs";

const SAFE_CARD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,256}$/;

export function liveSessionPointerFile(root, cardId, runSeq) {
  if (typeof root !== "string" || !root) return null;
  if (typeof cardId !== "string" || !SAFE_CARD_ID.test(cardId)) return null;
  if (!Number.isSafeInteger(runSeq) || runSeq < 1) return null;
  return path.join(root, "cards", cardId, `live-session-${runSeq}.json`);
}

export async function writeLiveSessionPointer(root, card, identity, at = new Date().toISOString()) {
  const file = liveSessionPointerFile(root, card?.id, card?.runSeq);
  const sessionId = String(identity?.sessionId ?? identity?.session_id ?? "").trim();
  if (!file || !SAFE_SESSION_ID.test(sessionId)) return null;
  const transcript = identity?.transcriptPath ?? identity?.transcript_path;
  const transcriptPath = typeof transcript === "string" && path.isAbsolute(transcript) ? transcript : null;
  const pointer = {
    cardId: card.id,
    runSeq: card.runSeq,
    sessionId,
    transcriptPath,
    at
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${ulid()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(pointer, null, 2), "utf8");
  await fs.rename(tmp, file);
  return pointer;
}

export async function readLiveSessionPointer(root, card) {
  if (card?.status !== "running") return null;
  const file = liveSessionPointerFile(root, card?.id, card?.runSeq);
  if (!file) return null;
  try {
    const pointer = JSON.parse(await fs.readFile(file, "utf8"));
    if (pointer?.cardId !== card.id || pointer?.runSeq !== card.runSeq) return null;
    if (typeof pointer?.sessionId !== "string" || !SAFE_SESSION_ID.test(pointer.sessionId)) return null;
    if (pointer.transcriptPath !== null &&
        (typeof pointer.transcriptPath !== "string" || !path.isAbsolute(pointer.transcriptPath))) return null;
    return pointer;
  } catch {
    return null;
  }
}

export async function clearLiveSessionPointer(root, cardId, runSeq) {
  const file = liveSessionPointerFile(root, cardId, runSeq);
  if (!file) return false;
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

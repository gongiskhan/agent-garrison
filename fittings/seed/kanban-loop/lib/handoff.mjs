// Handoff packet (WS2, D6). When a card reaches `done` the board composes a
// durable cards/<id>/handoff.json — the successor's starting context and the human
// close-out record: what got done, the key decisions, the files touched, the
// fetchable evidence manifest, and the chain of predecessor cards.
//
// Generated at the saveCardCAS choke point beside notifyOriginTransition, so EVERY
// mover (engine, in-session, manual PATCH, gateway quick card) produces one. Fully
// fire-and-forget-safe: it never blocks or fails the card write (deferred to the
// next tick, every failure swallowed).

import path from "node:path";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { kanbanRoot } from "./board.mjs";
import { enumerateArtifactRefs, linksProjectRoot } from "./links.mjs";

const DONE_LIST = "done";

// The done edge: the list CHANGED into `done` (all cards, done only — not
// needs-attention). Pure, so the edge logic is testable.
export function doneTransition(prev, next) {
  if (!next || typeof next !== "object") return false;
  if (next.list !== DONE_LIST) return false;
  return (prev?.list ?? null) !== DONE_LIST;
}

// Read the engine-written per-duty summaries (duty-summary.<phase>.json) under the
// card's run dir, oldest first. Absent runDir / dir -> [].
function readDutySummaries(cwd, runDir) {
  if (!runDir) return [];
  const dir = path.resolve(cwd, runDir);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^duty-summary\..+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
    } catch {
      /* skip a torn/partial summary */
    }
  }
  out.sort((a, b) => String(a?.at || "").localeCompare(String(b?.at || "")));
  return out;
}

function readTouchSetFiles(cwd, runDir) {
  if (!runDir) return [];
  try {
    const p = path.resolve(cwd, runDir, "touch-set.json");
    if (!existsSync(p)) return [];
    const ts = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(ts.files) ? ts.files.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Bullet lines from the card-owned brief (decisions the discussion settled).
function briefDecisionLines(root, cardId, cap = 12) {
  try {
    const p = path.join(root, "cards", cardId, "brief.md");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[-*]\s+/.test(l))
      .map((l) => l.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
      .slice(0, cap);
  } catch {
    return [];
  }
}

function readPredecessorHandoff(root, continuesId) {
  if (typeof continuesId !== "string" || !continuesId) return null;
  try {
    const p = path.join(root, "cards", continuesId, "handoff.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Compose the packet for a done card. Pure w.r.t. the passed card; reads its run
// dir + brief + predecessor handoff off disk. Never throws (returns a minimal
// packet on any read failure via the guarded helpers).
export function composeHandoff(card, { root, cwd, at } = {}) {
  const kroot = root ?? kanbanRoot();
  const kcwd = cwd ?? linksProjectRoot();
  const summaries = readDutySummaries(kcwd, card.runDir);
  const last = summaries.length ? summaries[summaries.length - 1] : null;

  const completionSummary =
    (last && typeof last.summary === "string" && last.summary.trim() ? last.summary.trim() : null) ||
    (typeof card.lastReply === "string" && card.lastReply.trim() ? card.lastReply.trim() : "");

  const keyDecisions = [];
  for (const s of summaries) {
    if (typeof s?.gateSummary === "string" && s.gateSummary.trim()) keyDecisions.push(`${s.phase}: ${s.gateSummary.trim()}`);
  }
  for (const b of briefDecisionLines(kroot, card.id)) keyDecisions.push(b);

  let filesTouched = readTouchSetFiles(kcwd, card.runDir);
  if (!filesTouched.length && Array.isArray(card.fences)) {
    filesTouched = card.fences
      .filter((f) => f && f.sha)
      .map((f) => `commit ${String(f.sha).slice(0, 10)} (${f.phase || "phase"})`);
  }

  const evidenceManifest = enumerateArtifactRefs(card, { root: kroot, cwd: kcwd });

  // The chain, oldest first: the predecessor's own chain + the predecessor itself
  // (transitive via its stored chainIndex, so no deep recursion needed).
  const pred = readPredecessorHandoff(kroot, card.continues);
  let chainIndex = [];
  if (pred) {
    const predChain = Array.isArray(pred.chainIndex) ? pred.chainIndex : [];
    const predOne = typeof pred.completionSummary === "string" ? pred.completionSummary.slice(0, 100) : "";
    chainIndex = [...predChain, { cardId: pred.cardId ?? card.continues, title: pred.title ?? null, oneLiner: predOne }];
  }

  return {
    cardId: card.id,
    title: card.title ?? null,
    at: at ?? new Date().toISOString(),
    completionSummary,
    keyDecisions,
    filesTouched,
    evidenceManifest,
    chainIndex
  };
}

function writeHandoff(root, packet) {
  const file = path.join(root, "cards", packet.cardId, "handoff.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(packet, null, 2), "utf8");
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, JSON.stringify(packet, null, 2), "utf8");
  }
  return file;
}

// Fire-and-forget: on the done edge, compose + write the packet on the next tick so
// the card write (and its CAS lock) is never blocked or failed by handoff I/O.
export function generateHandoffIfDone(root, prev, next) {
  try {
    if (!doneTransition(prev, next)) return;
    setImmediate(() => {
      try {
        writeHandoff(root, composeHandoff(next, { root }));
      } catch (err) {
        console.error(`[kanban] handoff generation failed for ${next?.id}: ${err?.message || err}`);
      }
    });
  } catch {
    /* never let handoff generation break a card write */
  }
}

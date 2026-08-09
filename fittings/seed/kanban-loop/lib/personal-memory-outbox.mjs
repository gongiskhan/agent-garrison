// Neutral Kanban -> memory completion outbox.
//
// This module owns only a bounded, provider-agnostic source packet under the
// Kanban data root. It never opens an Obsidian vault, calls a memory CLI, reads a
// transcript, copies a diff, or inspects the environment. The Basic Memory
// fitting consumes these packets later, outside the card lifecycle lock.

import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

export const PERSONAL_COMPLETION_SCHEMA_VERSION = 1;
export const PERSONAL_COMPLETION_KIND = "garrison.personal-card-completion";

const CARD_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TITLE = 240;
const MAX_PROJECT_LABEL = 160;
const MAX_FLOW = 120;
const MAX_DESCRIPTION = 4_000;
const MAX_COMPLETION_NOTE = 2_000;
const MAX_CHECKLIST_ITEMS = 50;
const MAX_CHECKLIST_TEXT = 500;
const MAX_SUMMARY = 1_600;
const MAX_DECISIONS = 20;
const MAX_DECISION = 500;
const MAX_EVIDENCE = 30;
const MAX_EVIDENCE_TEXT = 500;

// Deliberately broader than the retired session-tail hook. This is still only a
// last-line defence: source packets contain the minimum fields in the first
// place, and never include transcripts, diffs, attachments, or env values.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[oprsu]_[A-Za-z0-9]{8,}/g,
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{8,}["']?/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
];

export function redactPersonalCompletionText(value) {
  let out = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

function bounded(value, max) {
  const clean = redactPersonalCompletionText(value).trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

// ClaudeChat appends this exact machine-local attachment block to a card
// description. The attachment bytes are card-owned elsewhere; neither their
// absolute paths nor a textual pointer to them belongs in a memory packet.
export function stripDescriptionAttachmentBlock(value) {
  return String(value ?? "")
    .replace(/\n{2,}Attached files?:\n(?:- [^\n]*(?:\n|$))+\s*$/i, "")
    .trimEnd();
}

function safeProjectLabel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // Project is context, not an execution path. Keep only the final label when
  // an old card carries an absolute or separator-containing spelling.
  const label = raw.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return bounded(label, MAX_PROJECT_LABEL) || null;
}

function isoOrNull(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function generationFor(card) {
  const value = card?.coordinationSeq;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function personalCompletionPacketId(card) {
  const cardId = typeof card?.id === "string" ? card.id : "";
  if (!CARD_ID_RE.test(cardId)) throw new Error("personal completion requires a valid card id");
  return `${cardId}-g${generationFor(card)}`;
}

export function personalCompletionOutboxRoot(root) {
  return path.join(root, "memory-outbox", "personal-completions");
}

export function personalCompletionPacketsDir(root) {
  return path.join(personalCompletionOutboxRoot(root), "packets");
}

export function personalCompletionStatusDir(root) {
  return path.join(personalCompletionOutboxRoot(root), "status");
}

export function personalCompletionPacketFile(root, card) {
  return path.join(personalCompletionPacketsDir(root), `${personalCompletionPacketId(card)}.json`);
}

export function isPersonalDoneTransition(prev, next) {
  return Boolean(
    next &&
    next.scope === "personal" &&
    next.list === "done" &&
    ((prev?.list ?? null) !== "done" || prev?.scope !== "personal")
  );
}

function safeChecklist(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_CHECKLIST_ITEMS).map((item) => ({
    text: bounded(item?.text, MAX_CHECKLIST_TEXT),
    done: item?.done === true
  })).filter((item) => item.text);
}

function safeEvidence(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const ref = bounded(item?.ref, MAX_EVIDENCE_TEXT);
    // A completion memory may cite bounded evidence artifacts, but never a
    // transcript/log/attachment/plan ref. Those can expose substantially more
    // source material when resolved than this packet is authorised to retain.
    if (!(ref === "evidenceIndex" || ref === "gateMarkers" || ref.startsWith("evidence:"))) continue;
    out.push({
      ref,
      description: bounded(item?.oneLiner, MAX_EVIDENCE_TEXT)
    });
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

function safeAgentCloseout(card, handoff) {
  const hadAgentRun = Boolean(
    card?.runDir ||
    (Number.isInteger(card?.iterations) && card.iterations > 0) ||
    (Array.isArray(card?.sessionIds) && card.sessionIds.length > 0)
  );
  if (!hadAgentRun) return null;

  const handoffMatchesCard = handoff && handoff.cardId === card.id;
  const handoffHasGeneration = Number.isSafeInteger(handoff?.coordinationSeq);
  const handoffMatchesGeneration = handoffHasGeneration && handoff.coordinationSeq === generationFor(card);
  const usableHandoff = handoffMatchesCard && (!handoffHasGeneration || handoffMatchesGeneration) ? handoff : null;
  const summary = bounded(usableHandoff?.completionSummary ?? card?.lastReply, MAX_SUMMARY);
  const decisions = (Array.isArray(usableHandoff?.keyDecisions) ? usableHandoff.keyDecisions : [])
    .map((item) => bounded(item, MAX_DECISION))
    .filter(Boolean)
    .slice(0, MAX_DECISIONS);
  const evidence = safeEvidence(usableHandoff?.evidenceManifest);
  if (!summary && decisions.length === 0 && evidence.length === 0) return null;

  return {
    source: usableHandoff ? "kanban-handoff" : "card-closeout-fallback",
    handoffGenerationVerified: Boolean(usableHandoff && handoffMatchesGeneration),
    summary,
    decisions,
    evidence,
    verification: "bounded-agent-closeout-not-independently-verified"
  };
}

export function buildPersonalCompletionPacket(card, { handoff = null } = {}) {
  if (!card || card.scope !== "personal" || card.list !== "done") {
    throw new Error("personal completion packets require a done card with scope=personal");
  }
  const packetId = personalCompletionPacketId(card);
  const completedAt =
    isoOrNull(handoff?.at) ||
    isoOrNull(card.updated) ||
    isoOrNull(card.created) ||
    "1970-01-01T00:00:00.000Z";
  const completionNote = bounded(card.completionNote, MAX_COMPLETION_NOTE);
  const routedProject = typeof card?.routing?.project === "string" && card.routing.project.trim()
    ? card.routing.project
    : null;

  return {
    schemaVersion: PERSONAL_COMPLETION_SCHEMA_VERSION,
    kind: PERSONAL_COMPLETION_KIND,
    packetId,
    cardId: card.id,
    coordinationSeq: generationFor(card),
    cardRev: Number.isSafeInteger(card.rev) ? card.rev : null,
    scope: "personal",
    completedAt,
    title: bounded(card.title || "(untitled)", MAX_TITLE),
    // Match execution precedence: an explicit run-spec project is the cwd, then
    // the visible card project, then the managed personal workspace.
    project: safeProjectLabel(routedProject || card.project),
    flow: bounded(card.flow, MAX_FLOW) || null,
    description: bounded(stripDescriptionAttachmentBlock(card.description), MAX_DESCRIPTION),
    checklist: safeChecklist(card.checklist),
    manualCompletionNote: completionNote || null,
    agentCloseout: safeAgentCloseout(card, handoff),
    verification: {
      description: "unverified-user-authored",
      checklist: "unverified-user-authored",
      manualCompletionNote: completionNote ? "unverified-user-authored" : "not-recorded",
      agentCloseout: "bounded-run-closeout-not-product-truth"
    },
    provenance: {
      producer: "garrison-kanban-loop",
      sourceType: "personal-done-card",
      sourceIdentity: `card:${card.id}@coordination:${generationFor(card)}`,
      semantics: "completion-source-record-not-promoted-memory",
      omittedByPolicy: ["transcripts", "logs", "diffs", "environment", "attachment-bodies", "session-identifiers"]
    }
  };
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readMatchingHandoff(root, card) {
  const handoff = await readJsonOrNull(path.join(root, "cards", card.id, "handoff.json"));
  if (!handoff || handoff.cardId !== card.id) return null;
  if (Number.isSafeInteger(handoff.coordinationSeq) && handoff.coordinationSeq !== generationFor(card)) return null;
  return handoff;
}

// Publish a complete file without ever exposing a partial `.json` to the
// consumer. `link` is the exclusive commit: two processes may prepare the same
// immutable packet, but only one creates the final path and neither overwrites
// an existing generation.
async function atomicCreateJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const nonce = crypto.randomBytes(8).toString("hex");
  const tmp = `${file}.${process.pid}.${nonce}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fs.link(tmp, file);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function enqueuePersonalCompletion(root, card, { handoff = null } = {}) {
  const resolvedHandoff = handoff ?? await readMatchingHandoff(root, card);
  const packet = buildPersonalCompletionPacket(card, { handoff: resolvedHandoff });
  const file = personalCompletionPacketFile(root, card);
  const created = await atomicCreateJson(file, packet);
  if (!created) {
    const existing = await readJsonOrNull(file);
    const sameIdentity = existing &&
      existing.schemaVersion === PERSONAL_COMPLETION_SCHEMA_VERSION &&
      existing.kind === PERSONAL_COMPLETION_KIND &&
      existing.packetId === packet.packetId &&
      existing.cardId === packet.cardId &&
      existing.coordinationSeq === packet.coordinationSeq &&
      existing.scope === "personal";
    if (!sameIdentity) {
      throw new Error(`personal completion outbox collision at ${path.basename(file)}`);
    }
  }
  return { status: "pending", packetId: packet.packetId, file, created };
}

// Called only after saveCardCAS has released the per-card lock. Schedule and
// return immediately: processCard must regain control and write its FINAL duty
// summary before the handoff and immutable packet snapshot run. The CAS caller
// queues the handoff first, so Node's FIFO immediate queue writes it before this
// callback reads it. Any failure is fail-open and startup reconciliation repairs
// the post-commit gap.
export function emitPersonalCompletionAfterDone(root, prev, next) {
  if (!isPersonalDoneTransition(prev, next)) return null;
  const packetId = personalCompletionPacketId(next);
  setImmediate(() => {
    enqueuePersonalCompletion(root, next).catch((err) => {
      const message = bounded(err?.message || err, 300);
      console.error(`[kanban] personal completion outbox enqueue failed for ${next.id}: ${message}`);
    });
  });
  return { status: "scheduled", packetId };
}

// Startup repair for the narrow crash window after card.json committed but
// before its outbox packet landed. It emits only exact scope=personal Done
// cards, and immutable generation keys make repeated reconciliation harmless.
export async function reconcilePersonalCompletionOutbox(root) {
  const cardsDir = path.join(root, "cards");
  let entries = [];
  try {
    entries = await fs.readdir(cardsDir, { withFileTypes: true });
  } catch {
    return { scanned: 0, emitted: 0, existing: 0, errors: [] };
  }

  let scanned = 0;
  let emitted = 0;
  let existing = 0;
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CARD_ID_RE.test(entry.name)) continue;
    const card = await readJsonOrNull(path.join(cardsDir, entry.name, "card.json"));
    if (!card || card.id !== entry.name || card.scope !== "personal" || card.list !== "done") continue;
    scanned += 1;
    try {
      const result = await enqueuePersonalCompletion(root, card);
      if (result.created) emitted += 1;
      else existing += 1;
    } catch (err) {
      errors.push({ cardId: entry.name, error: bounded(err?.message || err, 300) });
    }
  }
  return { scanned, emitted, existing, errors };
}

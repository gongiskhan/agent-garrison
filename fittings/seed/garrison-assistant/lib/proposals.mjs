// proposals.mjs — file assistant-drafted candidates into the Improver review
// queue as proposals with provenance `assistant`. The Assistant NEVER edits an
// artifact directly; it only appends a `pending` proposal the Improver UI shows
// with Approve/Reject. Writes the same review-queue.json + proposals/<id>.json
// the Improver reads, plus the per-proposal copy. Atomic-ish (write temp, rename).
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function improverDataDir() {
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return process.env.IMPROVER_DATA || path.join(home, "improver");
}
function queueFile() {
  return path.join(improverDataDir(), "review-queue.json");
}
function proposalsDir() {
  return path.join(improverDataDir(), "proposals");
}

function loadQueue() {
  const f = queueFile();
  if (!existsSync(f)) return [];
  // I5: an existing-but-unreadable queue must NOT be treated as empty — writing
  // over it would destroy prior proposals. Refuse loudly instead of clobbering.
  const raw = readFileSync(f, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `review-queue.json exists but is not valid JSON — refusing to overwrite it (fix or move it first): ${f}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`review-queue.json is not a JSON array — refusing to overwrite it: ${f}`);
  }
  return parsed;
}

function atomicWriteJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}

// Build one review-queue proposal from a drafted candidate. Carries the standard
// Improver fields PLUS `provenance: "assistant"` so it is attributable and the
// Improver's assistant-provenance handling can find it.
export function buildProposal(candidate, at) {
  const id = `assistant-${candidate.kind}-${slug(candidate.draft?.name || candidate.title)}-${stampSuffix(at)}`;
  return {
    id,
    rule: "assistant",
    provenance: "assistant",
    targetClass: candidate.targetClass,
    claim: candidate.claim,
    diff: JSON.stringify(candidate.draft, null, 2),
    decision: `Draft ${candidate.kind} for review — the Assistant proposes, the operator approves.`,
    applyVia: candidate.kind === "skill"
      ? "Quarters skill authoring (owned skill) after approval"
      : "Automations job registration after approval",
    status: "pending",
    at: at ?? null
  };
}

// Append proposals to the queue + write per-proposal copies. Idempotent by id.
export function fileProposals(candidates, at) {
  const queue = loadQueue();
  const seen = new Set(queue.map((p) => p.id));
  const filed = [];
  for (const c of candidates) {
    const proposal = buildProposal(c, at);
    if (seen.has(proposal.id)) continue;
    queue.push(proposal);
    seen.add(proposal.id);
    filed.push(proposal);
    atomicWriteJson(path.join(proposalsDir(), `${proposal.id}.json`), proposal);
  }
  atomicWriteJson(queueFile(), queue);
  return filed;
}

function slug(s) {
  return String(s || "x").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
}
// A short deterministic-from-timestamp suffix so ids are unique per run without
// Math.random (unavailable in some sandboxes) — derived from the ISO string.
function stampSuffix(at) {
  const s = String(at ?? "0").replace(/[^0-9]/g, "");
  return s.slice(-6) || "000000";
}

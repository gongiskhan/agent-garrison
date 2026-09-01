// findings.mjs — the record a stretch leaves for the next one.
//
// A stretch dies at the end of its turn. What survives today is a 300-character
// handoff summary and a ledger nobody reads, so the next stretch re-discovers
// the same files, the same symbols, the same dead ends. The findings record is
// the middle thing: what was ESTABLISHED, as pointers, written while the work
// happens rather than reconstructed from the transcript afterwards.
//
// Three properties do the work, and each one is a constraint enforced here
// rather than a convention hoped for:
//
//   NO CONTENT. A claim carries a finding and pointers to where it lives, never
//   the thing itself. "mintKey lives in src/lib/identity.js and returns a
//   sortable id" survives; the body of identity.js does not. A record that
//   carries content is a transcript with extra steps, and it grows without
//   bound. A code fence in a claim is therefore rejected outright.
//
//   APPEND-ONLY, SINGLE WRITER. A stretch appends to its own entries and
//   nothing else. Composition for the next stretch is a concatenation in
//   ledger order with no model anywhere in the path, so what stretch N sees is
//   a pure function of what stretches 1..N-1 wrote.
//
//   NOTHING PROVIDER-SHAPED. There is no field here for a model, a token count,
//   a message id or a tool-call shape. An entry is a claim, some pointers and a
//   content anchor. Adding a second provider must not change this file; if it
//   ever does, something provider-shaped got in and the design was wrong.
//
// There is deliberately no summarization step. When the record hits its cap the
// task STOPS and says so, because compacting it would be exactly the
// lossy-rewrite this mechanism exists to replace - and a task that routinely
// hits the cap is telling you its claims are too verbose, which is worth
// knowing rather than hiding.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const FINDING_KINDS = ["fact", "decision", "rejected", "change", "failure"];

// A fact or a change asserts that a file is in a particular state, so it must
// name the state it saw. A decision, a rejection or a failure is about the
// work, not about a file, and pinning one to a hash would make it go stale for
// a reason that has nothing to do with whether it still holds.
export const ANCHORED_KINDS = new Set(["fact", "change"]);

export const CLAIM_MAX_CHARS = 200;
export const FINDINGS_CAP = 120;
export const POINTERS_MAX = 12;

const CODE_FENCE = /```|\n {4}\S/;

export class FindingRejected extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "FindingRejected";
    this.code = "finding_rejected";
    this.detail = detail;
  }
}

export class FindingsCapReached extends Error {
  constructor(count, cap) {
    super(
      `findings cap reached: ${count} entries against a cap of ${cap}. The record is not compacted ` +
      `on purpose - compaction is the summarization step this design replaces. Either the claims are ` +
      `too verbose or this task is too large for one record.`
    );
    this.name = "FindingsCapReached";
    this.code = "findings_cap_reached";
    this.count = count;
    this.cap = cap;
  }
}

/** sha256 of a file's bytes, or null when it is not there to hash. */
export function hashFile(absPath) {
  try {
    return createHash("sha256").update(fs.readFileSync(absPath)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/** The anchor for a path: what the file looked like when the claim was made. */
export function anchorFor(target, { cwd = process.cwd() } = {}) {
  if (!target) return null;
  const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
  const hash = hashFile(abs);
  if (!hash) return null;
  return { path: target, hash };
}

/**
 * Validate and normalise one entry. Throws FindingRejected rather than
 * silently repairing: an entry that had to be fixed up is one the author did
 * not mean, and the whole value of the record is that its claims are exact.
 */
export function normalizeFinding(input, { stretchId, duty, cwd = process.cwd(), now = () => new Date().toISOString(), id = null } = {}) {
  const kind = String(input?.kind ?? "").trim();
  if (!FINDING_KINDS.includes(kind)) {
    throw new FindingRejected(`kind must be one of ${FINDING_KINDS.join(", ")}`, { got: input?.kind });
  }
  const claim = String(input?.claim ?? "").trim();
  if (!claim) throw new FindingRejected("claim is required");
  if (claim.length > CLAIM_MAX_CHARS) {
    throw new FindingRejected(`claim is ${claim.length} chars, cap is ${CLAIM_MAX_CHARS}`, { claim: claim.slice(0, 80) });
  }
  if (CODE_FENCE.test(claim) || claim.includes("\n")) {
    throw new FindingRejected(
      "a claim is one line of finding and pointers, never content. Point at where the code lives instead of quoting it.",
      { claim: claim.slice(0, 80) }
    );
  }
  const pointers = Array.isArray(input?.pointers) ? input.pointers.map((p) => String(p).trim()).filter(Boolean) : [];
  if (pointers.length > POINTERS_MAX) {
    throw new FindingRejected(`at most ${POINTERS_MAX} pointers`, { got: pointers.length });
  }

  let anchor = null;
  if (input?.anchor && typeof input.anchor === "object" && input.anchor.path && input.anchor.hash) {
    anchor = { path: String(input.anchor.path), hash: String(input.anchor.hash) };
  } else if (input?.anchorPath) {
    anchor = anchorFor(String(input.anchorPath), { cwd });
    if (!anchor) {
      throw new FindingRejected(`anchorPath ${input.anchorPath} could not be hashed - the file is not there`, { anchorPath: input.anchorPath });
    }
  } else if (input?.anchorCommit) {
    anchor = { commit: String(input.anchorCommit) };
  }

  if (ANCHORED_KINDS.has(kind) && !anchor) {
    throw new FindingRejected(
      `a "${kind}" entry asserts a file is in a particular state, so it needs an anchor: pass anchorPath (or anchorCommit)`,
      { kind }
    );
  }
  if (!ANCHORED_KINDS.has(kind) && anchor) {
    throw new FindingRejected(
      `a "${kind}" entry is about the work, not about a file, so it takes no anchor`,
      { kind }
    );
  }

  return {
    id: id ?? `f_${createHash("sha256").update(`${stretchId}|${claim}|${now()}`).digest("hex").slice(0, 12)}`,
    kind,
    claim,
    pointers,
    anchor,
    stretch: stretchId ?? null,
    duty: duty ?? null,
    ts: now(),
  };
}

/** Every finding in the ledger, in order, oldest first. */
export function readFindings(events) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e?.kind === "finding" && e.payload)
    .map((e) => ({ ...e.payload, seq: e.seq ?? null }));
}

/**
 * Recompute each anchored entry against the working tree. An entry whose file
 * has changed is marked stale and KEPT: that something moved since it was
 * recorded is information the next stretch needs, and dropping it would hide
 * exactly the case this exists to catch.
 */
export function markStaleness(findings, { cwd = process.cwd() } = {}) {
  return findings.map((f) => {
    if (!f.anchor?.path) return { ...f, stale: false };
    const abs = path.isAbsolute(f.anchor.path) ? f.anchor.path : path.join(cwd, f.anchor.path);
    const now = hashFile(abs);
    if (now === null) return { ...f, stale: true, staleReason: "the file is gone" };
    if (now !== f.anchor.hash) return { ...f, stale: true, staleReason: "the file changed since this was recorded" };
    return { ...f, stale: false };
  });
}

const KIND_LABEL = {
  fact: "FACT", decision: "DECISION", rejected: "REJECTED", change: "CHANGE", failure: "FAILURE",
};

/**
 * Render the record for the next stretch. Deterministic concatenation in
 * ledger order - no model, no reordering, no selection.
 */
export function composeFindings(events, { cwd = process.cwd(), conversationId = null } = {}) {
  const all = markStaleness(readFindings(events), { cwd });
  if (!all.length) return { text: "", entries: [], staleCount: 0 };
  const lines = [];
  lines.push("## What earlier stretches established");
  lines.push("");
  lines.push("Findings, oldest first, exactly as they were recorded. They carry pointers, not");
  lines.push("content: follow the pointer rather than assuming what is behind it. An entry marked");
  lines.push("STALE had its file change after it was written - re-read that file, do not trust the");
  lines.push("claim. Add your own with `mcp__garrison__garrison_finding_add` as you establish");
  lines.push("things, not at the end.");
  lines.push("");
  for (const f of all) {
    const bits = [`- [${KIND_LABEL[f.kind] ?? f.kind.toUpperCase()}]`];
    if (f.stale) bits.push("**STALE**");
    bits.push(f.claim);
    lines.push(bits.join(" "));
    const sub = [];
    if (f.pointers.length) sub.push(`→ ${f.pointers.join(", ")}`);
    if (f.anchor?.path) sub.push(f.stale ? `anchor ${f.anchor.path} (${f.staleReason})` : `anchor ${f.anchor.path}@${f.anchor.hash}`);
    if (f.anchor?.commit) sub.push(`commit ${f.anchor.commit}`);
    if (f.duty) sub.push(`from ${f.duty}`);
    if (sub.length) lines.push(`  ${sub.join(" · ")}`);
  }
  const staleCount = all.filter((f) => f.stale).length;
  if (staleCount) {
    lines.push("");
    lines.push(`${staleCount} of ${all.length} entries are STALE. Re-read those files before relying on them.`);
  }
  if (conversationId) {
    lines.push("");
    lines.push(`Anything a finding points at but does not contain is in the ledger. Fetch one item with`);
    lines.push(`\`mcp__garrison__garrison_conversation_fetch\` using the address \`${conversationId}#<seq>\`.`);
  }
  return { text: lines.join("\n"), entries: all, staleCount };
}

/** Guard the cap before a write, so the caller surfaces it rather than trimming. */
export function assertUnderCap(events, { cap = FINDINGS_CAP } = {}) {
  const count = readFindings(events).length;
  if (count >= cap) throw new FindingsCapReached(count, cap);
  return count;
}

// ── read/search repetition, the instrumented number ───────────────────────
//
// What a stretch READ or SEARCHED FOR, normalised to comparable targets, so
// "stretch 3 looked at eleven things, eight of which an earlier stretch had
// already looked at" is a fact rather than an impression. Bash is included
// because with a narrowed tool profile most searching happens through it.

const BASH_PATTERNS = [
  [/\bgrep\b[^|;&]*?(?:-[a-zA-Z]+\s+)*(?:-e\s+)?(['"])(.+?)\1/g, (m) => `grep:${m[2]}`],
  [/\bfind\s+(\S+)[^|;&]*?-name\s+(['"]?)([^'"\s]+)\2/g, (m) => `glob:${m[1]}/${m[3]}`],
  [/\b(?:ls|ll)\s+(?:-[a-zA-Z]+\s+)*([^\s|;&]+)/g, (m) => `ls:${m[1]}`],
  [/\b(?:cat|head|tail|sed -n[^|;&]*?)\s+([^\s|;&]+\.[a-zA-Z0-9]+)/g, (m) => `read:${m[1]}`],
  [/\brg\b[^|;&]*?(['"])(.+?)\1/g, (m) => `grep:${m[2]}`],
];

function parseToolInput(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** The read/search targets one tool_use block represents, possibly none. */
export function targetsForToolUse(block) {
  const name = block?.name;
  const input = parseToolInput(block?.input);
  if (!name || !input) return [];
  const out = [];
  if (name === "Read" && input.file_path) out.push(`read:${input.file_path}`);
  else if (name === "Grep" && input.pattern) out.push(`grep:${input.pattern}`);
  else if (name === "Glob" && input.pattern) out.push(`glob:${input.pattern}`);
  else if (name === "LS" && input.path) out.push(`ls:${input.path}`);
  else if (name === "Bash" && typeof input.command === "string") {
    for (const [re, fmt] of BASH_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(input.command)) !== null) out.push(fmt(m));
    }
  }
  return out;
}

/**
 * Per-stretch read/search targets and, for each stretch after the first, how
 * many of its targets an EARLIER stretch in the same task had already hit.
 *
 * Reported, not judged, and nothing in this slice is tuned against it.
 */
export function repetitionReport(events) {
  const perStretch = new Map();
  const order = [];
  const dutyOf = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.kind === "stretch-started" && e.stretch) {
      if (!order.includes(e.stretch)) order.push(e.stretch);
      dutyOf.set(e.stretch, e.payload?.duty ?? e.duty ?? null);
    }
    if (e?.kind !== "session-event" || !e.stretch) continue;
    if (!order.includes(e.stretch)) order.push(e.stretch);
    if (!dutyOf.has(e.stretch)) dutyOf.set(e.stretch, e.duty ?? null);
    for (const b of e.payload?.blocks ?? []) {
      if (b?.type !== "tool_use") continue;
      const set = perStretch.get(e.stretch) ?? new Set();
      for (const t of targetsForToolUse(b)) set.add(t);
      perStretch.set(e.stretch, set);
    }
  }
  const seen = new Set();
  const stretches = [];
  for (const id of order) {
    const targets = [...(perStretch.get(id) ?? new Set())].sort();
    const repeated = targets.filter((t) => seen.has(t));
    stretches.push({
      stretch: id,
      duty: dutyOf.get(id) ?? null,
      targets: targets.length,
      repeatedFromEarlierStretches: repeated.length,
      fraction: targets.length ? repeated.length / targets.length : null,
      repeatedTargets: repeated,
      newTargets: targets.filter((t) => !seen.has(t)),
    });
    for (const t of targets) seen.add(t);
  }
  const after = stretches.slice(1);
  const totalTargets = after.reduce((a, s) => a + s.targets, 0);
  const totalRepeated = after.reduce((a, s) => a + s.repeatedFromEarlierStretches, 0);
  return {
    stretches,
    task: {
      stretchesAfterTheFirst: after.length,
      targets: totalTargets,
      repeated: totalRepeated,
      fraction: totalTargets ? totalRepeated / totalTargets : null,
      distinctTargetsAcrossTask: seen.size,
    },
  };
}

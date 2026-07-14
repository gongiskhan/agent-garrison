// Artifact-ref vocabulary (WS2) — ONE source for how a card's opaque ref tokens
// map to on-disk paths + their human one-liners, shared by the board server
// (resolveCardLinks / handleArtifact) and the handoff-packet generator. Honors the
// board's link-never-duplicate contract: refs point at the single owning file, the
// board serves the bytes, nobody copies them.
//
// The ref token vocabulary (opaque, client never supplies a path):
//   plan            -> <runDir>/FLOW_PLAN.md
//   brief           -> cards/<id>/brief.md (or a legacy project-relative briefPath)
//   evidenceIndex   -> <runDir>/evidence-index.json
//   gateMarkers     -> <runDir>/slices/<sliceId>/gate-status.json
//   evidence:<name> -> <runDir>/evidence/<name>
//   session:<i>     -> ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
//   log:<n>         -> cards/<id>/log-<n>.md

import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { claudeProjectDirForCwd } from "@garrison/claude-pty";
import { kanbanRoot, cardBriefFile, cardBriefRel } from "./board.mjs";

// The project root the board resolves card.runDir + evidence against. Mirrors the
// server's projectRoot() so links.mjs and server.mjs agree without a circular import.
export function linksProjectRoot() {
  return process.env.GARRISON_KANBAN_PROJECT_ROOT || process.cwd();
}

// A slice id flows into the gate-marker path — reject separators / `..` so the read
// stays inside THIS card's run dir.
export function isValidSliceId(s) {
  return typeof s === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(s) && s !== "." && s !== "..";
}

// An evidence file name flows into a served path — a plain filename only (no
// separators, no `..`, no leading dot). confinePath re-checks the resolved path.
export function isSafeEvidenceName(s) {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) && !s.includes("..");
}

const EVIDENCE_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export function isEvidenceImage(name) {
  return EVIDENCE_IMAGE_EXT.has(path.extname(String(name || "")).toLowerCase());
}

// resolveArtifactRef — the READ side. Given a card and an OPAQUE ref token, derive
// the absolute path from the card's OWN stored pointers (NEVER from client input),
// or null for an unknown/out-of-range ref. The caller confines + serves it.
export function resolveArtifactRef(card, ref, { root = kanbanRoot(), cwd = linksProjectRoot() } = {}) {
  if (!card || typeof ref !== "string") return null;
  if (ref === "plan") return card.runDir ? path.resolve(cwd, card.runDir, "FLOW_PLAN.md") : null;
  // Card-scoped: each card mints its own runId, so the per-run evidence index lives
  // under THIS card's run dir — not the shared project-global docs/autothing one.
  if (ref === "evidenceIndex") return card.runDir ? path.resolve(cwd, card.runDir, "evidence-index.json") : null;
  if (ref === "gateMarkers") {
    // sliceId is client-editable -> reject any value with separators/`..` so the
    // read stays inside THIS card's run dir (a bad sliceId yields no ref).
    return card.runDir && isValidSliceId(card.sliceId)
      ? path.resolve(cwd, card.runDir, "slices", card.sliceId, "gate-status.json")
      : null;
  }
  if (ref === "brief") {
    // A legacy explicit briefPath (project-relative) resolves against the project
    // root; the card-owned marker (cards/<id>/brief.md) and the no-briefPath default
    // both resolve to the deterministic card-owned file under the board root.
    return card.briefPath && card.briefPath !== cardBriefRel(card.id)
      ? path.resolve(cwd, card.briefPath)
      : cardBriefFile(root, card.id);
  }
  const em = ref.match(/^evidence:(.+)$/);
  if (em) {
    return card.runDir && isSafeEvidenceName(em[1])
      ? path.resolve(cwd, card.runDir, "evidence", em[1])
      : null;
  }
  const sm = ref.match(/^session:(\d+)$/);
  if (sm) {
    const sid = (Array.isArray(card.sessionIds) ? card.sessionIds : [])[Number(sm[1])];
    return sid ? path.join(claudeProjectDirForCwd(cwd), `${sid}.jsonl`) : null;
  }
  const lm = ref.match(/^log:(\d+)$/);
  if (lm) {
    const n = Number(lm[1]);
    return n >= 1 && n <= (card.iterations ?? 0) ? path.join(root, "cards", card.id, `log-${n}.md`) : null;
  }
  return null;
}

// Human one-liner for a ref token (the handoff manifest's fetchable-ref labels).
function oneLinerFor(ref, card) {
  if (ref === "plan") return "FLOW_PLAN.md - the plan duty output";
  if (ref === "brief") return "brief.md - the discussion brief";
  if (ref === "evidenceIndex") return "evidence-index.json - the run's evidence index";
  if (ref === "gateMarkers") return "gate-status.json - the durable per-phase gate records";
  const em = ref.match(/^evidence:(.+)$/);
  if (em) return isEvidenceImage(em[1]) ? `${em[1]} - an evidence screenshot` : `${em[1]} - an evidence artifact`;
  const sm = ref.match(/^session:(\d+)$/);
  if (sm) {
    const sid = (Array.isArray(card.sessionIds) ? card.sessionIds : [])[Number(sm[1])];
    return `session transcript ${sm[1]}${sid ? ` (${sid})` : ""}`;
  }
  const lm = ref.match(/^log:(\d+)$/);
  if (lm) return `log-${lm[1]}.md - iteration ${lm[1]} operative log`;
  return ref;
}

// Enumerate the artifact refs a card exposes, as an ordered [{ref, oneLiner}] list
// using the SAME vocabulary as resolveCardLinks — the handoff packet's fetchable
// evidence manifest. Structural (card fields) plus a disk scan of the evidence dir
// so the successor learns the exact evidence filenames it can pull.
export function enumerateArtifactRefs(card, { root = kanbanRoot(), cwd = linksProjectRoot() } = {}) {
  if (!card || typeof card !== "object") return [];
  const out = [];
  const push = (ref) => out.push({ ref, oneLiner: oneLinerFor(ref, card) });
  // The card-owned brief, when present.
  const briefPath = resolveArtifactRef(card, "brief", { root, cwd });
  if (card.briefPath || (briefPath && existsSync(briefPath))) push("brief");
  if (card.runDir) {
    push("plan");
    push("evidenceIndex");
    if (isValidSliceId(card.sliceId)) push("gateMarkers");
    const evDir = path.resolve(cwd, card.runDir, "evidence");
    if (existsSync(evDir)) {
      let names = [];
      try {
        names = readdirSync(evDir, { withFileTypes: true })
          .filter((d) => d.isFile() && isSafeEvidenceName(d.name))
          .map((d) => d.name);
      } catch {
        names = [];
      }
      names.sort((a, b) => (isEvidenceImage(b) ? 1 : 0) - (isEvidenceImage(a) ? 1 : 0) || a.localeCompare(b));
      for (const name of names) push(`evidence:${name}`);
    }
  }
  const sids = Array.isArray(card.sessionIds) ? card.sessionIds : [];
  sids.forEach((_sid, i) => push(`session:${i}`));
  for (let n = 1; n <= (card.iterations ?? 0); n++) push(`log:${n}`);
  return out;
}

// Convenience for tests / callers that want to know a ref points at a real file.
export function refExists(card, ref, opts = {}) {
  const abs = resolveArtifactRef(card, ref, opts);
  try {
    return Boolean(abs) && statSync(abs).isFile();
  } catch {
    return false;
  }
}

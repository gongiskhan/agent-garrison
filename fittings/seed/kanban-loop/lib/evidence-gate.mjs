// evidence-gate.mjs — the durable evidence/gate predicates (Conversations).
//
// Moved verbatim from engine.mjs when duty-list dispatch was cut: the
// predicates survive because the CONTRACT survives — a run directory owes
// tangible evidence and a fresh, concordant gate record before work may call
// itself done. Consumers now: the stretch launcher's exit gate (via the
// handoff validator's rule 10), the board's Done invariant
// (board.mjs doneEvidenceVerdict), and the tests that pin the contract.
import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

export function hasEvidence(cwd, runDir, requiredEvidenceFile = null) {
  if (!runDir || typeof runDir !== "string") return false;
  try {
    const dir = path.resolve(cwd || process.cwd(), runDir, "evidence");
    if (!existsSync(dir)) return false;
    const entries = readdirSync(dir, { withFileTypes: true });
    if (requiredEvidenceFile != null) {
      const name = String(requiredEvidenceFile);
      // List config is local, but keep this filename-only so a malformed board
      // cannot turn the evidence check into a traversal probe.
      if (!name || name === "." || name === ".." || /[\\/]/.test(name)) return false;
      const required = entries.find((d) => d.isFile() && d.name === name);
      if (!required) return false;
      // A zero-byte/whitespace placeholder is not a report. The engine cannot
      // semantically grade prose here, but it can require tangible content.
      return readFileSync(path.join(dir, name), "utf8").trim().length > 0;
    }
    return entries.some((d) => d.isFile());
  } catch {
    return false;
  }
}

// Evidence can be required for every exit (Walkthrough) or only for a particular
// edge (Test -> Done when Test is the card's final executable phase).
export function evidenceRequiredForTransition(list, next) {
  if (!list || !next) return false;
  if (list.requiresEvidence) return true;
  return Array.isArray(list.requiresEvidenceOn) && list.requiresEvidenceOn.includes(next);
}

// Engine invariant for the canonical terminal Test -> Done edge. Board/list
// fields are mutable and old installed boards can predate requiresEvidenceOn,
// so terminal proof cannot depend on those fields being fresh. Every seam asks
// this helper about the ACTUAL destination after rail fast-forwarding; when Test
// lands in Done, a non-empty evidence/evidence.md is mandatory. Other edges keep
// the configurable Walkthrough/transition evidence contract.
export function evidenceContractForTransition(list, phase, next, rail = null) {
  // An evidence-free rail (the card's flow declares `evidence: false`)
  // owes no evidence anywhere — including the terminal Test -> Done invariant,
  // so the waiver comes first. Every seam funnels through this helper, so the
  // waiver holds for the dispatched, batched, and in-session paths alike.
  if (rail && rail.evidenceRequired === false) {
    return { required: false, requiredEvidenceFile: null, invariant: null, waived: true };
  }
  if (phase === "test" && next === "done") {
    return { required: true, requiredEvidenceFile: "evidence.md", invariant: "terminal-test-done" };
  }
  return {
    required: evidenceRequiredForTransition(list, next),
    requiredEvidenceFile: list?.requiredEvidenceFile ?? null,
    invariant: null
  };
}

// D9 concordance. A status-only gate is accepted for backwards compatibility;
// once the phase writes an explicit next_phase/nextPhase/next, the authoritative
// (newest, phase-sidecar-preferred) record must name the ACTUAL edge. This is
// intentionally checked after rail resolution so a gate saying
// `adversarial-test` cannot silently authorize a real Test -> Done transition.
export function gateContractForTransition(cwd, runDir, phase, next, freshness = null, rail = null) {
  // Evidence-free rail: the contract reports satisfied without touching the
  // filesystem — no gate record is owed, so none is inspected. `waived: true`
  // keeps the shape honest for diagnostics (this is a waiver, not a real gate).
  if (rail && rail.evidenceRequired === false) {
    return { exists: true, declaresNext: false, nextLists: [], stale: false, agrees: true, waived: true };
  }
  const evidence = inspectPhaseGateEvidence(cwd, runDir, phase, freshness);
  // Keep stale history visible for diagnostics, but never let it satisfy a
  // current-attempt contract. With no freshness constraint this is the same
  // inspection and `stale` is necessarily false.
  const historical = freshness ? inspectPhaseGateEvidence(cwd, runDir, phase) : evidence;
  const normalized = typeof next === "string" ? next.trim().toLowerCase() : "";
  return {
    ...evidence,
    stale: !evidence.exists && historical.exists,
    agrees: evidence.exists && (!evidence.declaresNext || evidence.nextLists.includes(normalized))
  };
}

// Read the Discuss brief a card links (card.briefPath), so the discussion's RESULT
// becomes context for the downstream phases (plan/implement/…). The brief path is set
// by the server (recordBrief / the Move-out-of-Discuss auto-link) and is project-
// relative; we confine the read to the project root (cwd) defensively, require a
// regular readable file, and cap the size so a huge brief can't blow up the prompt.
// Best-effort: any miss returns null and the prompt simply omits the section.
// The evidence bundle: <runDir>/evidence/, and the predicates that read it.
//
// Most of this file used to drive processCard / processBatch / advanceCardPhase
// to prove the gate was enforced on every transition seam. Those seams are gone
// with the duty-list engine, and there is no local transition left to enforce
// on. Two things survive the cut and are kept here:
//
//   1. The SERVE side, which is live and security-sensitive. server.mjs
//      enumerates the bundle into card links (server.mjs:911) and guards every
//      evidence/attachment filename with isSafeEvidenceName (server.mjs:3566,
//      3600). tests/kanban-board-ui.test.ts covers resolveCardLinks and
//      resolveArtifactRef for the OTHER card pointers; the evidence bundle —
//      the `evidence:<file>` ref, the name guard, the image classifier, the
//      directory enumeration — is covered only here.
//   2. The evidence-gate PREDICATES, which the cut deliberately split into
//      lib/evidence-gate.mjs rather than deleting. See the orphan note on that
//      describe: they currently have no caller, so this file is the whole
//      record of what the contract means.
//
// Deliberately NOT kept: railForCard / railIsManualOnly, which
// tests/level-chain.test.ts and tests/mutation-killers.test.ts already cover in
// more depth, and the Test-list prompt projection, which died with the phase
// templates.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// The gate predicates are pure transition mechanics; pin the policy path at a
// nonexistent file so nothing reads a real compiled policy.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
// runDirs mint ABSOLUTE under the evidence home — sandbox it so tests never
// write the real ~/.garrison/runs.
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { isSafeEvidenceName, isEvidenceImage, resolveArtifactRef, resolveCardLinks } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import {
  evidenceContractForTransition,
  evidenceRequiredForTransition,
  gateContractForTransition,
  hasEvidence
} from "../fittings/seed/kanban-loop/lib/evidence-gate.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});

const tmp = () => mkdtempSync(join(tmpdir(), "kanban-ev-"));

describe("evidence filename safety (isSafeEvidenceName)", () => {
  it("accepts plain filenames", () => {
    for (const n of ["after.png", "evidence.md", "step-1.jpg", "a_b.webp", "X.png"]) {
      expect(isSafeEvidenceName(n)).toBe(true);
    }
  });
  it("rejects separators, traversal, leading dots and junk", () => {
    for (const n of ["../secret", "a/b.png", "a\\b.png", "..", ".", ".hidden", "..evil.png", "", null as any, "x".repeat(200)]) {
      expect(isSafeEvidenceName(n)).toBe(false);
    }
  });
});

describe("isEvidenceImage", () => {
  it("classifies image extensions", () => {
    expect(isEvidenceImage("after.png")).toBe(true);
    expect(isEvidenceImage("a.JPG")).toBe(true);
    expect(isEvidenceImage("evidence.md")).toBe(false);
    expect(isEvidenceImage("log.txt")).toBe(false);
  });
});

describe("resolveArtifactRef evidence:<file>", () => {
  const card = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ1", runDir: "docs/autothing/runs/RUN1" };
  it("resolves a safe name under <runDir>/evidence/", () => {
    const p = resolveArtifactRef(card, "evidence:after.png", { root: "/board", cwd: "/proj" });
    expect(p).toBe("/proj/docs/autothing/runs/RUN1/evidence/after.png");
  });
  it("refuses a traversing / separator-bearing name (null, never escapes)", () => {
    expect(resolveArtifactRef(card, "evidence:../../../../etc/passwd", { root: "/board", cwd: "/proj" })).toBe(null);
    expect(resolveArtifactRef(card, "evidence:a/b", { root: "/board", cwd: "/proj" })).toBe(null);
    expect(resolveArtifactRef({ id: card.id }, "evidence:after.png", { root: "/board", cwd: "/proj" })).toBe(null); // no runDir
  });
});

describe("resolveCardLinks enumerates the evidence bundle from disk", () => {
  it("lists screenshots (image:true) before the log, all confined under the run dir", () => {
    const cwd = tmp();
    const runDir = "docs/autothing/runs/RUNX";
    const evDir = join(cwd, runDir, "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "evidence.md"), "# what changed\n- one line\n");
    writeFileSync(join(evDir, "after.png"), "PNGDATA");
    const card = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ2", runDir };
    const links = resolveCardLinks(card, { root: tmp(), cwd });
    expect(Array.isArray(links.evidence)).toBe(true);
    expect(links.evidence.length).toBe(2);
    // image leads
    expect(links.evidence[0].name).toBe("after.png");
    expect(links.evidence[0].image).toBe(true);
    expect(links.evidence[1].name).toBe("evidence.md");
    expect(links.evidence[1].image).toBe(false);
    // every entry is a confined serve ref with the opaque artifact url (no abs path)
    for (const e of links.evidence) {
      expect(e.kind).toBe("serve");
      expect(e.url).toContain("/artifact?ref=evidence");
    }
  });

  it("is empty (not erroring) when there is no evidence dir", () => {
    const cwd = tmp();
    const card = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ3", runDir: "docs/autothing/runs/NONE" };
    const links = resolveCardLinks(card, { root: tmp(), cwd });
    expect(links.evidence).toEqual([]);
  });

  it("does NOT enumerate a subdirectory as a serve link (only regular files)", () => {
    const cwd = tmp();
    const runDir = "docs/autothing/runs/RUNSUB";
    const evDir = join(cwd, runDir, "evidence");
    mkdirSync(join(evDir, "shots"), { recursive: true }); // a subdir
    writeFileSync(join(evDir, "evidence.md"), "# log\n");
    const card = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ4", runDir };
    const links = resolveCardLinks(card, { root: tmp(), cwd });
    expect(links.evidence.map((e: any) => e.name)).toEqual(["evidence.md"]); // no "shots"
  });

  it("skips a file whose name the safety guard rejects", () => {
    const cwd = tmp();
    const runDir = "docs/autothing/runs/RUNDOT";
    const evDir = join(cwd, runDir, "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, ".hidden"), "secret");
    writeFileSync(join(evDir, "evidence.md"), "# log\n");
    const card = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ5", runDir };
    const links = resolveCardLinks(card, { root: tmp(), cwd });
    expect(links.evidence.map((e: any) => e.name)).toEqual(["evidence.md"]);
  });
});

// ── the gate predicates: ORPHANS, pinned ─────────────────────────────────────
// lib/evidence-gate.mjs was carved out of engine.mjs during the cut rather than
// deleted, on the stated grounds that the CONTRACT survives its engine. Worth
// knowing before anyone relies on that: as of this cut nothing calls these four
// functions. engine.mjs:59 re-exports them "for one release for old importers"
// and that re-export is their only reference.
//
// The file header names two consumers, and neither reads this module:
//   • board.mjs `doneEvidenceVerdict` (board.mjs:1135) checks the conversation's
//     terminal handoff `evidenceRefs`, not <runDir>/evidence/.
//   • the launcher's exit gate (http-gateway stretch.mjs applyFlowPolicy) also
//     works off handoff evidenceRefs.
// So the run-dir evidence contract and the handoff evidence contract are two
// different things, and only the second one currently has a caller.
//
// These stay pinned because the predicates are the only written definition of
// what "a run directory owes proof" means, and whoever re-wires the run-dir
// contract will need it to still be true. If the decision is that it never
// comes back, delete evidence-gate.mjs and this block together.
describe("evidence-gate predicates (no live caller — contract pinned)", () => {
  it("hasEvidence is true only when <runDir>/evidence/ holds a regular file", () => {
    const cwd = tmp();
    const runDir = "docs/autothing/runs/HE";
    expect(hasEvidence(cwd, runDir)).toBe(false);
    mkdirSync(join(cwd, runDir, "evidence"), { recursive: true });
    expect(hasEvidence(cwd, runDir)).toBe(false); // empty dir
    writeFileSync(join(cwd, runDir, "evidence", "evidence.md"), "x");
    expect(hasEvidence(cwd, runDir)).toBe(true);
  });

  it("requires the exact named report, and treats a placeholder as absent", () => {
    const cwd = tmp();
    const runDir = "runs/terminal-test";
    mkdirSync(join(cwd, runDir, "evidence"), { recursive: true });
    writeFileSync(join(cwd, runDir, "evidence", "after.png"), "PNG");
    expect(hasEvidence(cwd, runDir)).toBe(true); // historical any-artifact contract
    expect(hasEvidence(cwd, runDir, "evidence.md")).toBe(false);
    writeFileSync(join(cwd, runDir, "evidence", "evidence.md"), "  \n");
    expect(hasEvidence(cwd, runDir, "evidence.md")).toBe(false); // placeholder is not proof
    writeFileSync(join(cwd, runDir, "evidence", "evidence.md"), "# Tests\n- `npm test`: pass\n");
    expect(hasEvidence(cwd, runDir, "evidence.md")).toBe(true);
    // filename-only confinement: the required name can never be a path
    expect(hasEvidence(cwd, runDir, "../evidence.md")).toBe(false);
    expect(hasEvidence(cwd, runDir, "a/b.md")).toBe(false);
    expect(hasEvidence(cwd, null)).toBe(false);
  });

  it("evidenceRequiredForTransition honours requiresEvidence and the per-edge list", () => {
    expect(evidenceRequiredForTransition({ requiresEvidence: true }, "anything")).toBe(true);
    const perEdge = { requiresEvidenceOn: ["done"] };
    expect(evidenceRequiredForTransition(perEdge, "done")).toBe(true);
    expect(evidenceRequiredForTransition(perEdge, "review")).toBe(false);
    expect(evidenceRequiredForTransition(null, "done")).toBe(false);
    expect(evidenceRequiredForTransition(perEdge, null)).toBe(false);
  });

  it("the terminal test→done invariant is ENGINE-owned, not read off the list", () => {
    // The point of the invariant: an installed list predating requiresEvidenceOn
    // must not be able to waive terminal proof by being stale.
    expect(evidenceContractForTransition({}, "test", "done")).toEqual({
      required: true,
      requiredEvidenceFile: "evidence.md",
      invariant: "terminal-test-done"
    });
    // Any other edge falls back to the configurable list contract.
    expect(evidenceContractForTransition({ requiresEvidenceOn: ["done"] }, "test", "adversarial-test")).toEqual({
      required: false,
      requiredEvidenceFile: null,
      invariant: null
    });
  });

  it("an evidence-free rail waives both contracts, and waives them without touching disk", () => {
    const rail = { evidenceRequired: false };
    expect(evidenceContractForTransition({}, "test", "done", rail)).toEqual({
      required: false,
      requiredEvidenceFile: null,
      invariant: null,
      waived: true
    });
    // The cwd/runDir here do not exist; a waiver that inspected the filesystem
    // would have to fail or throw.
    expect(gateContractForTransition("/nonexistent-cwd", "runs/none", "test", "done", null, rail)).toMatchObject({
      exists: true,
      stale: false,
      agrees: true,
      waived: true
    });
    // …and an evidence-requiring rail keeps the engine-owned terminal invariant.
    expect(evidenceContractForTransition({}, "test", "done", { evidenceRequired: true })).toMatchObject({
      required: true,
      invariant: "terminal-test-done"
    });
  });

  // ── BUG PIN ────────────────────────────────────────────────────────────────
  // REPORTED, NOT ADAPTED AROUND. gateContractForTransition throws
  // `ReferenceError: inspectPhaseGateEvidence is not defined` on every call that
  // is not short-circuited by an evidence-free rail waiver.
  //
  // evidence-gate.mjs was created by THE CUT (c7475ecf) by moving this function
  // out of engine.mjs. engine.mjs imports inspectPhaseGateEvidence from
  // policy.mjs (engine.mjs:43); the new file imports only node:path and node:fs
  // (evidence-gate.mjs:9-10), so the reference at evidence-gate.mjs:79 is free.
  //
  // Nothing calls it today — see the describe note — which is the only reason
  // this is latent rather than an outage. It is also why no module-load guard
  // finds it: a free variable inside a function body is legal at LINK time and
  // only explodes when the line runs. The fix is one import line in
  // fittings/seed/kanban-loop/lib/evidence-gate.mjs:
  //   import { inspectPhaseGateEvidence } from "./policy.mjs";
  // Delete this marker (not the tests) when it lands.
  it("BUG: without a waiver, a missing gate record does not agree with any edge", () => {
    const gate = gateContractForTransition(tmp(), "runs/none", "test", "done");
    expect(gate.exists).toBe(false);
    expect(gate.agrees).toBe(false);
    expect(gate.waived).toBeUndefined(); // a real gate result is never labelled a waiver
  });

  it("BUG: a gate record naming a DIFFERENT next phase does not authorize this edge", () => {
    const cwd = tmp();
    const runDir = "runs/mismatch";
    mkdirSync(join(cwd, runDir), { recursive: true });
    writeFileSync(
      join(cwd, runDir, "gate-status.test.json"),
      JSON.stringify({ status: "passed", next_phase: "adversarial-test", notes: "14/14" }),
      "utf8"
    );
    // The record exists and passed, but it declares a different destination —
    // it cannot silently authorize test → done.
    expect(gateContractForTransition(cwd, runDir, "test", "done")).toMatchObject({ exists: true, agrees: false });
    expect(gateContractForTransition(cwd, runDir, "test", "adversarial-test")).toMatchObject({ exists: true, agrees: true });
    // …and the comparison is case/whitespace tolerant on the edge it is given.
    expect(gateContractForTransition(cwd, runDir, "test", "  Adversarial-Test  ")).toMatchObject({ agrees: true });
  });
});

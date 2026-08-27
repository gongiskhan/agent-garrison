// The evidence bundle: <runDir>/evidence/, as the board SERVES it.
//
// Most of this file used to drive processCard / processBatch / advanceCardPhase
// to prove the run-dir evidence gate was enforced on every transition seam.
// Those seams went with the duty-list engine, and the gate predicates
// themselves (lib/evidence-gate.mjs) were then deleted too — the surviving
// evidence contract is the conversation's terminal handoff `evidenceRefs`,
// checked by board.mjs `doneEvidenceVerdict` and the launcher's flow policy,
// which is a different contract over different data and is covered with those.
//
// What is left here is the SERVE side, which is live and security-sensitive:
// server.mjs enumerates the bundle into card links (server.mjs:911) and guards
// every evidence/attachment filename with isSafeEvidenceName (server.mjs:3566,
// 3600). tests/kanban-board-ui.test.ts covers resolveCardLinks and
// resolveArtifactRef for the OTHER card pointers; the evidence bundle — the
// `evidence:<file>` ref, the name guard, the image classifier, the directory
// enumeration — is covered only here.
//
// Deliberately NOT kept: railForCard / railIsManualOnly, which
// tests/level-chain.test.ts and tests/mutation-killers.test.ts already cover in
// more depth, and the Test-list prompt projection, which died with the phase
// templates.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Nothing here reads a compiled policy; pin the path at a nonexistent file so a
// stray read can never reach the real one.
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

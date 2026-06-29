// Always-on evidence bundle: when the heavy walkthrough VIDEO is skipped, the pipeline
// still leaves tangible proof under <runDir>/evidence/ (a screenshot and/or evidence.md),
// surfaced on the finished card. These tests pin (a) the path-confinement of the new
// served directory — the security-sensitive part — and (b) that resolveCardLinks
// enumerates + classifies the bundle from disk.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { isSafeEvidenceName, isEvidenceImage, resolveArtifactRef, resolveCardLinks } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import { hasEvidence, processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

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
});

describe("evidence GATE — a requiresEvidence list cannot advance without producing evidence", () => {
  const board = seedBoard();

  it("hasEvidence is true only when <runDir>/evidence/ holds a regular file", () => {
    const cwd = tmp();
    const runDir = "docs/autothing/runs/HE";
    expect(hasEvidence(cwd, runDir)).toBe(false);
    mkdirSync(join(cwd, runDir, "evidence"), { recursive: true });
    expect(hasEvidence(cwd, runDir)).toBe(false); // empty dir
    writeFileSync(join(cwd, runDir, "evidence", "evidence.md"), "x");
    expect(hasEvidence(cwd, runDir)).toBe(true);
  });

  it("parks (no-evidence) when Walkthrough routes forward but left NO evidence", async () => {
    const root = tmp();
    const cwd = tmp();
    const card = await createCard(root, { title: "T", project: "p", list: "walkthrough" });
    // operative claims success (verdict `validate`) but writes nothing under evidence/.
    const runFn = async () => ({ reply: "all good\nvalidate" });
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10, cwd });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("no-evidence");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.attentionReason).toMatch(/no evidence/i);
  });

  it("ADVANCES when the evidence bundle actually exists on disk", async () => {
    const root = tmp();
    const cwd = tmp();
    const card = await createCard(root, { title: "T", project: "p", list: "walkthrough" });
    // mint the runDir the engine will look under, and write evidence there
    const runFn = async ({ card: c }: { card: any }) => {
      mkdirSync(join(cwd, c.runDir, "evidence"), { recursive: true });
      writeFileSync(join(cwd, c.runDir, "evidence", "after.png"), "PNG");
      return { reply: "captured screenshot\nvalidate" };
    };
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10, cwd });
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("validate");
  });
});

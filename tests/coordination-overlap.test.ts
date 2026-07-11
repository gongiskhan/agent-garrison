// GARRISON-FLOW-V2 S1 (Q1/Q2/Q8) — touch-set schema + overlap scorer + repo
// resolver + serialize gate. Pure-function coverage; no board/engine driving.
import { describe, it, expect } from "vitest";

// Policy-less mode (no compiled policy) — coordinationConfig then yields the code
// defaults, matching how the engine runs when the composer hasn't surfaced the
// section yet.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { scoreOverlap, validateTouchSet, readTouchSet, coordinationConfig, DEFAULT_COORDINATION, repoPathForProject, serializeGate } from "../fittings/seed/kanban-loop/lib/coordination.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

const ts = (o: any) => ({ version: 1, files: [], dirs: [], surfaces: [], exclusive: [], ...o });

describe("scoreOverlap — grades", () => {
  it("none when nothing is shared", () => {
    expect(scoreOverlap(ts({ files: ["a.ts"] }), ts({ files: ["b.ts"] })).grade).toBe("none");
  });

  it("light when only dir claims overlap by prefix", () => {
    const s = scoreOverlap(ts({ dirs: ["src/x/"] }), ts({ dirs: ["src/x/y/"] }));
    expect(s.grade).toBe("light");
    expect(s.sharedDirs).toContain("src/x");
    expect(s.sharedFiles).toEqual([]);
  });

  it("medium on one shared exact file (below the heavy ratio)", () => {
    const s = scoreOverlap(ts({ files: ["src/a.ts", "src/b.ts", "src/c.ts"] }), ts({ files: ["src/a.ts", "src/x.ts", "src/y.ts"] }));
    expect(s.grade).toBe("medium");
    expect(s.sharedFiles).toEqual(["src/a.ts"]);
  });

  it("medium when one card's file falls under the other's dir claim", () => {
    const s = scoreOverlap(ts({ files: ["src/api/routes.ts"] }), ts({ dirs: ["src/api/"] }));
    expect(s.grade).toBe("medium");
  });

  it("medium on a shared surface with no shared files", () => {
    const s = scoreOverlap(ts({ surfaces: ["policy.json:coordination"] }), ts({ surfaces: ["policy.json:coordination"] }));
    expect(s.grade).toBe("medium");
    expect(s.sharedSurfaces).toContain("policy.json:coordination");
  });

  it("heavy on >= heavyFiles shared exact files", () => {
    const s = scoreOverlap(ts({ files: ["a.ts", "b.ts", "c.ts", "d.ts"] }), ts({ files: ["a.ts", "b.ts", "c.ts", "z.ts"] }));
    expect(s.grade).toBe("heavy");
    expect(s.sharedFiles.length).toBe(3);
  });

  it("heavy when shared files reach the heavy ratio of the smaller set", () => {
    // smaller set is 2 files, 1 shared -> 0.5 >= 0.5 -> heavy
    const s = scoreOverlap(ts({ files: ["a.ts", "b.ts"] }), ts({ files: ["a.ts", "x.ts", "y.ts", "z.ts"] }));
    expect(s.grade).toBe("heavy");
  });

  it("heavy on the COUNT threshold alone, below the ratio (mutation killer)", () => {
    // 3 shared of 10 -> ratio 0.3 < 0.5, but count 3 >= heavyFiles(3) -> heavy.
    // Isolates the count path so a sabotaged heavyFiles threshold is caught.
    const many = (p: string) => Array.from({ length: 7 }, (_, i) => `${p}${i}.ts`);
    const s = scoreOverlap(
      ts({ files: ["a.ts", "b.ts", "c.ts", ...many("left")] }),
      ts({ files: ["a.ts", "b.ts", "c.ts", ...many("right")] })
    );
    expect(s.grade).toBe("heavy");
    expect(s.sharedFiles.length).toBe(3);
  });

  it("heavy on a shared exclusive lease regardless of file count", () => {
    const s = scoreOverlap(ts({ exclusive: ["package-lock.json"] }), ts({ exclusive: ["package-lock.json"] }));
    expect(s.grade).toBe("heavy");
    expect(s.sharedExclusive).toContain("package-lock.json");
  });

  it("honours threshold overrides", () => {
    const a = ts({ files: ["a.ts", "b.ts", "x.ts", "y.ts"] });
    const b = ts({ files: ["a.ts", "b.ts", "p.ts", "q.ts"] });
    // 2 shared of 4 -> ratio 0.5 -> heavy under defaults
    expect(scoreOverlap(a, b).grade).toBe("heavy");
    // raise both thresholds so 2 shared is no longer heavy -> medium
    expect(scoreOverlap(a, b, { heavyFiles: 5, heavyRatio: 0.9 }).grade).toBe("medium");
  });

  it("normalises ./ and leading/trailing slashes before comparing", () => {
    // ./src/a.ts and src/a.ts must be recognised as the SAME file; in 3-file sets
    // one shared file (ratio 1/3) lands on medium.
    const s = scoreOverlap(ts({ files: ["./src/a.ts", "p.ts", "q.ts"] }), ts({ files: ["src/a.ts", "m.ts", "n.ts"] }));
    expect(s.grade).toBe("medium");
    expect(s.sharedFiles).toEqual(["src/a.ts"]);
  });
});

describe("validateTouchSet — schema v1", () => {
  it("accepts a version-1 object and normalises paths", () => {
    const v = validateTouchSet({ version: 1, files: ["./src/a.ts", "src/b.ts/"], dirs: ["src/x/"], notes: "n" });
    expect(v).not.toBeNull();
    expect(v.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(v.dirs).toEqual(["src/x"]);
    expect(v.notes).toBe("n");
  });
  it("rejects a wrong/missing version or non-object", () => {
    expect(validateTouchSet({ version: 2, files: [] })).toBeNull();
    expect(validateTouchSet({ files: [] })).toBeNull();
    expect(validateTouchSet(null)).toBeNull();
    expect(validateTouchSet("nope")).toBeNull();
  });
  it("tolerates a sparse (empty) prediction", () => {
    const v = validateTouchSet({ version: 1 });
    expect(v).not.toBeNull();
    expect(v.files).toEqual([]);
  });
  it("rejects absolute paths and .. traversal segments in any path field", () => {
    expect(validateTouchSet({ version: 1, files: ["../etc/passwd"] })).toBeNull();
    expect(validateTouchSet({ version: 1, files: ["/abs/path.ts"] })).toBeNull();
    expect(validateTouchSet({ version: 1, dirs: ["src/../../x"] })).toBeNull();
    expect(validateTouchSet({ version: 1, exclusive: ["/abs"] })).toBeNull();
    expect(validateTouchSet({ version: 1, files: ["C:/win/abs.ts"] })).toBeNull();
    // benign relative paths (incl. ./ and dot-containing names) still validate
    expect(validateTouchSet({ version: 1, files: ["./src/a.ts", "src/a..b.ts"] })).not.toBeNull();
  });
});

describe("readTouchSet — from a run directory", () => {
  it("reads + validates <runDir>/touch-set.json, null when absent", () => {
    const runDir = mkdtempSync(join(tmpdir(), "coord-ts-"));
    expect(readTouchSet(runDir)).toBeNull();
    writeFileSync(join(runDir, "touch-set.json"), JSON.stringify({ version: 1, files: ["src/a.ts"] }));
    expect(readTouchSet(runDir)!.files).toEqual(["src/a.ts"]);
    expect(readTouchSet(null)).toBeNull();
  });
});

describe("coordinationConfig — defaults + merge", () => {
  it("returns the code defaults when the policy has no section", () => {
    expect(coordinationConfig(null)).toEqual(DEFAULT_COORDINATION);
  });
  it("deep-merges thresholds/fences over the defaults", () => {
    const c = coordinationConfig({ coordination: { enabled: false, thresholds: { heavyFiles: 9 } } });
    expect(c.enabled).toBe(false);
    expect(c.thresholds.heavyFiles).toBe(9);
    expect(c.thresholds.heavyRatio).toBe(DEFAULT_COORDINATION.thresholds.heavyRatio);
    expect(c.fences.trailer).toBe("Garrison-Card");
  });
});

describe("repoPathForProject — resolver precedence", () => {
  it("prefers an explicit board.projects[label].path that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "coord-repo-"));
    const board = { projects: { proj: { path: dir } } };
    expect(repoPathForProject("proj", board)).toBe(dir);
  });
  it("accepts an absolute-path label that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "coord-abs-"));
    expect(repoPathForProject(dir, { projects: {} })).toBe(dir);
  });
  it("returns null for an unresolvable label", () => {
    expect(repoPathForProject("definitely-not-a-real-repo-xyz", { projects: {} })).toBeNull();
    expect(repoPathForProject(null as any, {})).toBeNull();
  });
});

describe("serializeGate — one live card per project, oldest ULID wins", () => {
  const board = seedBoard();
  const live = (id: string, project: string) => ({ id, project, list: "implement", runDir: "/x", status: "ok" });

  it("allows the sole live card", () => {
    const a = live("01A", "p");
    expect(serializeGate([a], a, board).allowed).toBe(true);
  });
  it("allows the OLDEST and blocks a YOUNGER same-project card", () => {
    const older = live("01A", "p");
    const younger = live("01B", "p");
    const cards = [older, younger];
    expect(serializeGate(cards, older, board).allowed).toBe(true);
    const blocked = serializeGate(cards, younger, board);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("01A");
  });
  it("ignores cards of a different project", () => {
    const a = live("01A", "p");
    const other = live("00Z", "q");
    expect(serializeGate([a, other], a, board).allowed).toBe(true);
  });
  it("does not count a not-started card (no runDir, not running) as live", () => {
    const older = { id: "00A", project: "p", list: "todo" };
    const younger = live("01B", "p");
    // older is on a manual list with no runDir -> not live -> younger is the only live card
    expect(serializeGate([older, younger], younger, board).allowed).toBe(true);
  });
});

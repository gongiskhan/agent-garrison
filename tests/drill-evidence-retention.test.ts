// Drill Evidence retention (D6, v1 hardcoded defaults) on a SYNTHETIC set of
// runs: protected runs (findings / Needs Attention) keep everything, the last
// 3 green Full Drill runs stay complete, older green runs lose video + trace
// zips but keep steps.json, evidence.json, and screenshots — and the pruned
// index rows are flagged rather than left dangling.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-retention-home-"));
process.env.GARRISON_HOME = ghome;
delete process.env.GARRISON_DRILL_HOME;

// @ts-ignore — pure ESM .mjs, no .d.ts
import {
  classifyForRetention,
  pruneEvidence,
  evidenceRunDir,
  removeRunEvidence,
  KEEP_GREEN_FULL
  // @ts-ignore
} from "../fittings/seed/drill/lib/evidence.mjs";

const ROOT = "/tmp/retention-project";

type SyntheticRun = {
  id: string;
  startedAt: string;
  findings?: any[];
  summary?: { steps: number; failed: number; infra: number };
  circuit?: object | null;
  evidence?: { video: string | null; steps: string | null; index: string | null };
};

function seedEvidenceDir(runId: string, { video = true } = {}) {
  const dir = evidenceRunDir(runId, ROOT);
  mkdirSync(dir, { recursive: true });
  if (video) writeFileSync(path.join(dir, "video.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));
  writeFileSync(path.join(dir, "trace-home--s1--desktop.zip"), "PK");
  writeFileSync(path.join(dir, "step-home--s1--desktop.png"), "png");
  // Spotter raw frames follow the video/trace retention; the manifest never does.
  writeFileSync(path.join(dir, "frame-0000.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  writeFileSync(path.join(dir, "frame-0001.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  writeFileSync(path.join(dir, "spotter-frames.json"), JSON.stringify({ version: 1, frames: [{ name: "frame-0000.jpg" }, { name: "frame-0001.jpg" }] }));
  writeFileSync(path.join(dir, "steps.json"), JSON.stringify([{ stepId: "s1", startMs: 0, endMs: 10 }]));
  writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({
    project: ROOT,
    runId,
    items: [
      ...(video ? [{ item: "video", kind: "video", path: "video.webm" }] : []),
      { item: "spotter", kind: "spotter", manifest: "spotter-frames.json", frames: 2 },
      { item: "home--s1--desktop", kind: "step", trace: "trace-home--s1--desktop.zip", screenshot: "step-home--s1--desktop.png" }
    ]
  }, null, 2));
  return dir;
}

function greenRun(id: string, startedAt: string, { video = true } = {}): SyntheticRun {
  return {
    id, startedAt,
    findings: [],
    summary: { steps: 1, failed: 0, infra: 0 },
    circuit: null,
    evidence: { video: video ? "video.webm" : null, steps: "steps.json", index: "evidence.json" }
  };
}

afterAll(() => {
  rmSync(ghome, { recursive: true, force: true });
});

describe("classifyForRetention", () => {
  it("marks findings, failed checks, infra noise, and circuits as not-green; video as fullDrill", () => {
    const classified = classifyForRetention([
      greenRun("A", "2026-07-01T00:00:00Z"),
      { ...greenRun("B", "2026-07-02T00:00:00Z"), findings: [{ id: "f" }] },
      { ...greenRun("C", "2026-07-03T00:00:00Z"), summary: { steps: 2, failed: 1, infra: 0 } },
      { ...greenRun("D", "2026-07-04T00:00:00Z"), summary: { steps: 2, failed: 0, infra: 1 } },
      { ...greenRun("E", "2026-07-05T00:00:00Z"), circuit: { code: "x" } },
      greenRun("F", "2026-07-06T00:00:00Z", { video: false })
    ]);
    const byId = Object.fromEntries(classified.map((c: any) => [c.runId, c]));
    expect(byId.A).toMatchObject({ green: true, fullDrill: true });
    expect(byId.B.green).toBe(false);
    expect(byId.C.green).toBe(false);
    expect(byId.D.green).toBe(false);
    expect(byId.E.green).toBe(false);
    expect(byId.F).toMatchObject({ green: true, fullDrill: false });
  });
});

describe("pruneEvidence (D6 defaults)", () => {
  // Oldest → newest: two old green full runs (prunable), one old green
  // authoring run (prunable, no video), one old RED run (protected), then
  // three newer green full runs (the kept window) and one newest green
  // authoring run (newer than the window — stays complete).
  const runs: SyntheticRun[] = [
    greenRun("OLD-GREEN-1", "2026-07-01T00:00:00Z"),
    greenRun("OLD-GREEN-2", "2026-07-02T00:00:00Z"),
    greenRun("OLD-AUTHORING", "2026-07-03T00:00:00Z", { video: false }),
    { ...greenRun("OLD-RED", "2026-07-04T00:00:00Z"), findings: [{ id: "f1" }] },
    greenRun("KEEP-1", "2026-07-05T00:00:00Z"),
    greenRun("KEEP-2", "2026-07-06T00:00:00Z"),
    greenRun("KEEP-3", "2026-07-07T00:00:00Z"),
    greenRun("NEW-AUTHORING", "2026-07-08T00:00:00Z", { video: false })
  ];

  beforeAll(async () => {
    expect(KEEP_GREEN_FULL).toBe(3);
    for (const run of runs) seedEvidenceDir(run.id, { video: !!run.evidence?.video });
    const pruned = await pruneEvidence({ root: ROOT, classified: classifyForRetention(runs) });
    expect(pruned.map((p: any) => p.runId).sort()).toEqual(["OLD-AUTHORING", "OLD-GREEN-1", "OLD-GREEN-2"]);
  });

  const fileState = (runId: string) => {
    const dir = evidenceRunDir(runId, ROOT);
    return {
      video: existsSync(path.join(dir, "video.webm")),
      trace: existsSync(path.join(dir, "trace-home--s1--desktop.zip")),
      screenshot: existsSync(path.join(dir, "step-home--s1--desktop.png")),
      frames: existsSync(path.join(dir, "frame-0000.jpg")) && existsSync(path.join(dir, "frame-0001.jpg")),
      spotterManifest: existsSync(path.join(dir, "spotter-frames.json")),
      steps: existsSync(path.join(dir, "steps.json")),
      index: existsSync(path.join(dir, "evidence.json"))
    };
  };

  it("prunes video + traces + raw frames from older green runs, keeping manifests, index, and screenshots", () => {
    for (const runId of ["OLD-GREEN-1", "OLD-GREEN-2"]) {
      expect(fileState(runId)).toEqual({ video: false, trace: false, screenshot: true, frames: false, spotterManifest: true, steps: true, index: true });
    }
    expect(fileState("OLD-AUTHORING")).toEqual({ video: false, trace: false, screenshot: true, frames: false, spotterManifest: true, steps: true, index: true });
  });

  it("never touches protected runs or the kept green window", () => {
    expect(fileState("OLD-RED")).toEqual({ video: true, trace: true, screenshot: true, frames: true, spotterManifest: true, steps: true, index: true });
    for (const runId of ["KEEP-1", "KEEP-2", "KEEP-3"]) {
      expect(fileState(runId)).toEqual({ video: true, trace: true, screenshot: true, frames: true, spotterManifest: true, steps: true, index: true });
    }
    expect(fileState("NEW-AUTHORING")).toEqual({ video: false, trace: true, screenshot: true, frames: true, spotterManifest: true, steps: true, index: true });
  });

  it("stamps pruned index rows instead of leaving dangling names", () => {
    const index = JSON.parse(readFileSync(path.join(evidenceRunDir("OLD-GREEN-1", ROOT), "evidence.json"), "utf8"));
    expect(index.prunedAt).toBeTruthy();
    expect(index.items.find((i: any) => i.kind === "video").pruned).toBe(true);
    expect(index.items.find((i: any) => i.kind === "step").pruned).toBe(true);
    const spotterRow = index.items.find((i: any) => i.kind === "spotter");
    expect(spotterRow.pruned).toBe(true);
    expect(spotterRow.prunedFrames).toBe(2);
    const kept = JSON.parse(readFileSync(path.join(evidenceRunDir("KEEP-1", ROOT), "evidence.json"), "utf8"));
    expect(kept.prunedAt).toBeUndefined();
  });

  it("is idempotent and prunes nothing when green-full history is short", async () => {
    const again = await pruneEvidence({ root: ROOT, classified: classifyForRetention(runs) });
    expect(again).toEqual([]);
    const short = await pruneEvidence({
      root: ROOT,
      classified: classifyForRetention([greenRun("ONLY-1", "2026-07-01T00:00:00Z"), greenRun("ONLY-2", "2026-07-02T00:00:00Z")])
    });
    expect(short).toEqual([]);
  });

  it("removeRunEvidence deletes a run's whole evidence dir", async () => {
    const dir = seedEvidenceDir("DOOMED");
    expect(existsSync(dir)).toBe(true);
    await removeRunEvidence("DOOMED", ROOT);
    expect(existsSync(dir)).toBe(false);
  });
});

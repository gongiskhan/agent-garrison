// Capture-rule graduation (Drill Evidence V2, S5/D5), proven synthetically:
// three consecutive stable curation runs graduate a deterministic capture
// rule into the Drill Book page; run 4 curates with ZERO vision calls; an
// induced hash-profile drift on run 5 re-engages vision and stamps the rule.
// Plus the unit seams: observation folding, rule application, finding-based
// re-engagement, mixed-decision resets, and the blind-run guard.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-graduation-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-graduation-target-"));
process.env.GARRISON_HOME = ghome;
process.env.GARRISON_DRILL_TARGET_REPO = target;

// @ts-ignore — pure ESM .mjs, no .d.ts
import {
  STABLE_RUNS_TO_GRADUATE,
  DRIFT_HAMMING_TOLERANCE,
  hexHamming,
  runTriggerObservations,
  applyCaptureRules
  // @ts-ignore
} from "../fittings/seed/drill/lib/spotter-book.mjs";
// @ts-ignore
import { curateRunEvidence } from "../fittings/seed/drill/lib/curation.mjs";
// @ts-ignore — pure ESM .mjs; tsc's unchecked-JS signature synthesis DROPS
// default-initialized params (root = drillTargetRoot()), so calls with an
// explicit root would false-fail arity checks. Cast once at the import.
import * as drillStoreModule from "../fittings/seed/drill/lib/store.mjs";
const { savePage, getPage } = drillStoreModule as any;
// @ts-ignore
import { evidenceRunDir } from "../fittings/seed/drill/lib/evidence.mjs";

const H1 = "0".repeat(35) + "3";
const H2 = "0".repeat(34) + "c0";
const FAR = "f".repeat(36);

function seedRunEvidence(runId: string, hashes: string[]) {
  const dir = evidenceRunDir(runId, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "spotter-frames.json"),
    JSON.stringify({
      version: 1,
      frames: hashes.map((hash, i) => ({
        name: `frame-000${i}.jpg`,
        tMs: 100 * (i + 1),
        trigger: "step-end",
        chunk: "lab--s-one--desktop",
        hash,
        bytes: 100,
        collapsed: 0
      })),
      counts: {},
      collapsed: []
    })
  );
  writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ runId, items: [] }));
  return dir;
}

function fakeRecord(runId: string, extra: Record<string, unknown> = {}) {
  return {
    id: runId,
    contextTag: "drill",
    project: target,
    pages: [{ pageId: "lab", stepId: "s-one", viewportId: "desktop" }],
    findings: [],
    ...extra
  };
}

function makeFetch(calls: any[]) {
  return async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return {
      ok: true,
      json: async () => ({
        results: body.frames.map((f: any) => ({
          name: f.name,
          keep: true,
          importance: "normal",
          annotation: "Build preview updated to the new state"
        })),
        routedVia: "cc-fake"
      })
    } as any;
  };
}

beforeAll(async () => {
  writeFileSync(path.join(ghome, "internal-token"), "graduation-test-token");
  await savePage("lab", {
    title: "Lab",
    path: "",
    areas: [],
    steps: [
      { id: "s-one", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "check", tags: [] }
    ]
  }, target);
});

afterAll(() => {
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("the D5 loop end to end (synthetic 5-run sequence)", () => {
  const CFG = { maxCurated: 10, batchSize: 5 };

  it("a blind adversarial run neither applies rules nor writes graduation state", async () => {
    const calls: any[] = [];
    seedRunEvidence("RUN-BLIND", [H1, H2]);
    const reel = await curateRunEvidence({
      record: fakeRecord("RUN-BLIND", { contextTag: "drill-adversarial" }),
      root: target, config: CFG, app: "lab", fetchImpl: makeFetch(calls)
    });
    expect(calls.length).toBe(1); // vision still judges the blind run's frames
    expect(reel.counts.ruleApplied).toBe(0);
    const page = await getPage("lab", target);
    expect(page.spotter ?? undefined).toBeUndefined();
  });

  it("three stable runs graduate a capture rule into the page yml", async () => {
    for (const runId of ["RUN-A", "RUN-B", "RUN-C"]) {
      const calls: any[] = [];
      seedRunEvidence(runId, [H1, H2]);
      const reel = await curateRunEvidence({
        record: fakeRecord(runId), root: target, config: CFG, app: "lab", fetchImpl: makeFetch(calls)
      });
      expect(calls.length, `${runId} used vision`).toBe(1);
      expect(reel.counts.reel).toBe(2);
    }
    const page = await getPage("lab", target);
    expect(page.spotter.rules).toHaveLength(1);
    const rule = page.spotter.rules[0];
    expect(rule).toMatchObject({
      trigger: "step-end",
      action: "keep",
      annotation: "Build preview updated to the new state",
      stableRuns: STABLE_RUNS_TO_GRADUATE,
      drift: null
    });
    expect(rule.hashProfile).toEqual([H1, H2]);
    // The counter cleared on graduation; the raw yml on disk carries it all.
    expect(page.spotter.stability["step-end"]).toBeUndefined();
    expect(readFileSync(path.join(target, "drills", "pages", "lab.yml"), "utf8")).toContain("step-end");
  });

  it("run 4 curates deterministically with ZERO vision calls", async () => {
    const calls: any[] = [];
    seedRunEvidence("RUN-D", [H1, H2]);
    const reel = await curateRunEvidence({
      record: fakeRecord("RUN-D"), root: target, config: CFG, app: "lab", fetchImpl: makeFetch(calls)
    });
    expect(calls.length).toBe(0);
    expect(reel.routedVia).toBe("capture-rules");
    expect(reel.batches).toBe(0);
    expect(reel.counts.ruleApplied).toBe(2);
    expect(reel.counts.reel).toBe(2);
    for (const row of reel.frames) {
      expect(row.ruleApplied).toBe(true);
      expect(row.annotation).toBe("Build preview updated to the new state");
    }
    // Sidecars name the rule as the router lane.
    const dir = evidenceRunDir("RUN-D", target);
    const sidecar = JSON.parse(readFileSync(path.join(dir, "frame-0000.json"), "utf8"));
    expect(sidecar.routedVia).toBe("capture-rule");
    expect(sidecar.ruleApplied).toBe(true);
  });

  it("induced drift on run 5 re-engages vision and stamps the rule", async () => {
    const calls: any[] = [];
    seedRunEvidence("RUN-E", [FAR, FAR]);
    const reel = await curateRunEvidence({
      record: fakeRecord("RUN-E"), root: target, config: CFG, app: "lab", fetchImpl: makeFetch(calls)
    });
    expect(calls.length).toBe(1); // vision is back
    expect(reel.reengaged).toEqual([{ pageId: "lab", reason: "hash-profile" }]);
    expect(reel.counts.ruleApplied).toBe(0);
    const page = await getPage("lab", target);
    expect(page.spotter.rules[0].drift).toMatchObject({ reason: "hash-profile", runId: "RUN-E" });
    // Counting restarted: the drifted rule is inert and stability is fresh.
    expect(page.spotter.stability["step-end"]).toMatchObject({ decision: "keep", runs: 1 });
  });
});

describe("unit seams", () => {
  it("hexHamming distances are sane", () => {
    expect(hexHamming(H1, H1)).toBe(0);
    expect(hexHamming(H1, H2)).toBe(4);
    expect(hexHamming(H1, FAR)).toBeGreaterThan(DRIFT_HAMMING_TOLERANCE);
    expect(hexHamming(null as any, H1)).toBeNull();
  });

  it("runTriggerObservations folds vision verdicts and skips rule-applied ones", () => {
    const frames = [
      { name: "a.jpg", trigger: "step-end", chunk: "lab--s-one--desktop", hash: H1 },
      { name: "b.jpg", trigger: "step-end", chunk: "lab--s-one--desktop", hash: H2 },
      { name: "c.jpg", trigger: "phash", chunk: "lab--s-one--desktop", hash: H1 },
      { name: "d.jpg", trigger: "step-end", chunk: "lab--s-one--desktop", hash: H1 }
    ];
    const verdicts = new Map([
      ["a.jpg", { keep: true, annotation: "kept a" }],
      ["b.jpg", { keep: true, annotation: "kept b" }],
      ["c.jpg", { keep: false }],
      ["d.jpg", { keep: true, ruleApplied: true }] // must not count
    ]);
    const obs = runTriggerObservations({ frames, verdictByName: verdicts, pageIds: ["lab"] });
    const stepEnd = obs.find((o: any) => o.trigger === "step-end");
    expect(stepEnd).toMatchObject({ pageId: "lab", decision: "keep", keeps: 2, drops: 0 });
    expect(obs.find((o: any) => o.trigger === "phash")).toMatchObject({ decision: "drop" });
  });

  it("mixed decisions never stabilize", () => {
    const frames = [
      { name: "a.jpg", trigger: "step-end", chunk: "lab--s-one--desktop", hash: H1 },
      { name: "b.jpg", trigger: "step-end", chunk: "lab--s-one--desktop", hash: H2 }
    ];
    const verdicts = new Map([
      ["a.jpg", { keep: true }],
      ["b.jpg", { keep: false }]
    ]);
    const obs = runTriggerObservations({ frames, verdictByName: verdicts, pageIds: ["lab"] });
    expect(obs[0].decision).toBe("mixed");
  });

  it("applyCaptureRules re-engages on a finding for the page", () => {
    const page = {
      spotter: {
        rules: [{ trigger: "step-end", action: "keep", annotation: "x", importance: "normal", hashProfile: [H1], drift: null }]
      }
    };
    const frames = [{ name: "a.jpg", trigger: "step-end", hash: H1 }];
    expect(applyCaptureRules({ page, frames, runHasFindingForPage: true })).toMatchObject({ reengage: "finding" });
    const ok = applyCaptureRules({ page, frames, runHasFindingForPage: false });
    expect(ok.reengage).toBeNull();
    expect(ok.verdicts.get("a.jpg")).toMatchObject({ keep: true, ruleApplied: true });
    // Drifted rules are inert.
    const drifted = { spotter: { rules: [{ ...page.spotter.rules[0], drift: { reason: "finding" } }] } };
    expect(applyCaptureRules({ page: drifted, frames, runHasFindingForPage: false }).verdicts.size).toBe(0);
  });
});

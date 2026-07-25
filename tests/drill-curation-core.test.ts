// Drill curation core (Evidence V2, S2): frame-path confinement, the batch
// prompt contract, tolerant reply parsing, and the drill-side candidate
// selection + config gates. No servers, no model.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-curation-home-"));
process.env.GARRISON_HOME = ghome;

import {
  CURATION_MAX_FRAMES,
  CURATION_ANNOTATION_MAX,
  validateCurationFrames,
  buildCurationPrompt,
  parseCurationReply,
  drillEvidenceRoot
} from "@/lib/drill-curation";
// @ts-ignore — pure ESM .mjs, no .d.ts
import { selectCurationCandidates, curationConfig, effectiveMaxCurated, applyReelFloor, CURATION_DEFAULTS } from "../fittings/seed/drill/lib/curation.mjs";

const runDir = path.join(ghome, "drill", "evidence", "abc123def456", "01RUN");
const outsideDir = mkdtempSync(path.join(tmpdir(), "garrison-curation-outside-"));

beforeAll(() => {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "frame-0001.jpg"), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  writeFileSync(path.join(runDir, "frame-0002.jpg"), Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]));
  writeFileSync(path.join(runDir, "empty.jpg"), Buffer.alloc(0));
  writeFileSync(path.join(outsideDir, "frame-9999.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  // A symlink inside the evidence root pointing outside it must not pass.
  symlinkSync(path.join(outsideDir, "frame-9999.jpg"), path.join(runDir, "frame-link.jpg"));
});

afterAll(() => {
  rmSync(ghome, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe("validateCurationFrames", () => {
  const frame = (name: string, p?: string) => ({ name, path: p ?? path.join(runDir, name), trigger: "phash", tMs: 10 });

  it("accepts confined frames and normalizes fields", async () => {
    const frames = await validateCurationFrames([frame("frame-0001.jpg"), frame("frame-0002.jpg")]);
    expect(frames).toHaveLength(2);
    expect(frames[0].path.startsWith(drillEvidenceRoot())).toBe(true);
    expect(frames[0].trigger).toBe("phash");
  });

  it("rejects traversal, symlink escapes, foreign paths, and name mismatches", async () => {
    await expect(validateCurationFrames([frame("frame-0001.jpg", path.join(runDir, "..", "frame-0001.jpg"))])).rejects.toThrow();
    await expect(validateCurationFrames([frame("frame-link.jpg")])).rejects.toThrow(/escapes/);
    await expect(validateCurationFrames([frame("frame-9999.jpg", path.join(outsideDir, "frame-9999.jpg"))])).rejects.toThrow(/escapes/);
    await expect(validateCurationFrames([{ name: "frame-0001.jpg", path: path.join(runDir, "frame-0002.jpg") }])).rejects.toThrow(/invalid frame path/);
  });

  it("rejects bad names, empty files, and oversized batches", async () => {
    await expect(validateCurationFrames([frame("../../etc/passwd")])).rejects.toThrow(/invalid frame name/);
    await expect(validateCurationFrames([frame("frame.zip", path.join(runDir, "frame.zip"))])).rejects.toThrow(/invalid frame name/);
    await expect(validateCurationFrames([frame("empty.jpg")])).rejects.toThrow(/missing, empty/);
    await expect(validateCurationFrames([])).rejects.toThrow(/required/);
    const many = Array.from({ length: CURATION_MAX_FRAMES + 1 }, () => frame("frame-0001.jpg"));
    await expect(validateCurationFrames(many)).rejects.toThrow(/too many/);
  });
});

describe("buildCurationPrompt", () => {
  it("lists every frame with its coordinates and demands the JSON contract", async () => {
    const frames = await validateCurationFrames([
      { name: "frame-0001.jpg", path: path.join(runDir, "frame-0001.jpg"), trigger: "console-burst", chunk: "home--s1--desktop", tMs: 4200 },
      { name: "frame-0002.jpg", path: path.join(runDir, "frame-0002.jpg"), trigger: "step-start", tMs: 100 }
    ]);
    const prompt = buildCurationPrompt(frames, { app: "ekoa", runId: "01RUN" });
    expect(prompt).toContain('"ekoa"');
    expect(prompt).toContain("2 frames follow");
    expect(prompt).toContain("frame-0001.jpg");
    expect(prompt).toContain("home--s1--desktop");
    expect(prompt).toContain("console-burst");
    expect(prompt).toContain("4.2s");
    expect(prompt).toContain(path.join(runDir, "frame-0002.jpg"));
    expect(prompt).toContain("Read tool");
    expect(prompt).toContain('"keep"');
    expect(prompt).toContain('"highlight"');
    expect(prompt).toContain("JSON array");
  });
});

describe("parseCurationReply", () => {
  const entry = (name: string, extra = "") =>
    `{"name":"${name}","keep":true,"importance":"normal","annotation":"a fine frame","highlight":null${extra}}`;

  it("parses a plain array and one wrapped in prose/fences", () => {
    expect(parseCurationReply(`[${entry("frame-0001.jpg")}]`)).toHaveLength(1);
    const wrapped = "Here you go:\n```json\n[" + entry("frame-0001.jpg") + "," + entry("frame-0002.jpg") + "]\n```\nDone!";
    const parsed = parseCurationReply(wrapped);
    expect(parsed.map((v) => v.name)).toEqual(["frame-0001.jpg", "frame-0002.jpg"]);
  });

  it("clamps annotations, normalizes highlights, drops junk entries and duplicates", () => {
    const long = "x".repeat(CURATION_ANNOTATION_MAX * 2);
    const parsed = parseCurationReply(JSON.stringify([
      { name: "frame-0001.jpg", keep: "yes", importance: "HIGH", annotation: long, highlight: { x: 0.5, y: 0.5, w: 0.9, h: 0.9 } },
      { name: "frame-0001.jpg", keep: true, annotation: "duplicate — dropped" },
      { name: "frame-0002.jpg", keep: true, importance: "high", annotation: "err", highlight: { x: 120, y: 40, w: 300, h: 80 } },
      { name: "unlisted-but-valid.jpg", keep: false, annotation: "" },
      { noName: true },
      { name: "bad/../name.jpg", keep: true }
    ]));
    // frame-0001 + frame-0002 + unlisted-but-valid survive; the duplicate,
    // the nameless, and the traversal-shaped name are dropped.
    expect(parsed).toHaveLength(3);
    const first = parsed[0];
    expect(first.keep).toBe(false); // "yes" is not true — coercion stays strict
    expect(first.importance).toBe("normal"); // "HIGH" is not the contract literal
    expect(first.annotation).toHaveLength(CURATION_ANNOTATION_MAX);
    // Highlight clamped into the frame: w shrinks to fit x+w <= 1.
    expect(first.highlight).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    const second = parsed[1];
    expect(second.importance).toBe("high");
    expect(second.highlight).toBeNull(); // pixel-looking values are unrepairable
  });

  it("repairs PTY-damaged JSON (control bytes in strings)", () => {
    const damaged = `[{"name":"frame-0001.jpg","keep":true,"importance":"normal","annotation":"line one\nline two","highlight":null}]`;
    const parsed = parseCurationReply(damaged);
    expect(parsed[0].annotation).toContain("line one");
  });

  it("throws on replies with no array or no usable entries", () => {
    expect(() => parseCurationReply("I could not judge the frames.")).toThrow(/no complete JSON array/);
    expect(() => parseCurationReply("[]")).toThrow(/no usable entries/);
    expect(() => parseCurationReply(42)).toThrow(/not text/);
  });
});

describe("selectCurationCandidates + curationConfig (drill side)", () => {
  const frames = [
    { name: "f0", trigger: "step-start", tMs: 0 },
    { name: "f1", trigger: "phash", tMs: 100 },
    { name: "f2", trigger: "step-end", tMs: 200 },
    { name: "f3", trigger: "console-burst", tMs: 300 },
    { name: "f4", trigger: "step-start", tMs: 400 },
    { name: "f5", trigger: "message-growth", tMs: 500 }
  ];

  it("prioritizes signal triggers under the budget, preserves time order", () => {
    const three = selectCurationCandidates(frames, 3);
    expect(three.map((f: any) => f.name)).toEqual(["f1", "f3", "f5"]);
    const five = selectCurationCandidates(frames, 5);
    expect(five.map((f: any) => f.name)).toEqual(["f0", "f1", "f2", "f3", "f5"]);
    expect(selectCurationCandidates(frames, 10)).toHaveLength(6);
  });

  it("curationConfig merges book under body and honors disable flags", () => {
    expect(curationConfig({}, undefined)).toEqual({
      maxCurated: CURATION_DEFAULTS.maxCurated,
      maxCuratedExplicit: false,
      batchSize: CURATION_DEFAULTS.batchSize
    });
    expect(curationConfig({ spotter: { curation: { maxCurated: 10 } } }, { curation: { batchSize: 5 } }))
      .toEqual({ maxCurated: 10, maxCuratedExplicit: true, batchSize: 5 });
    expect(curationConfig({ spotter: { curation: false } }, undefined)).toBeNull();
    expect(curationConfig({}, { curation: false })).toBeNull();
    expect(curationConfig({ spotter: { curation: { maxCurated: 9999, batchSize: 0 } } }, undefined))
      .toEqual({ maxCurated: CURATION_DEFAULTS.maxCuratedCeiling, maxCuratedExplicit: true, batchSize: 1 });
  });

  it("scales the vision budget with the run size unless the operator pinned one", () => {
    // A fixed 30-frame budget cannot give 36 checks even one frame each; that
    // starvation is what left 28 of 36 checks with an empty Debrief scope.
    const auto = curationConfig({}, undefined)!;
    expect(effectiveMaxCurated(auto, 36)).toBe(72);
    expect(effectiveMaxCurated(auto, 2)).toBe(CURATION_DEFAULTS.maxCurated); // never below the floor
    expect(effectiveMaxCurated(auto, 5000)).toBe(CURATION_DEFAULTS.maxCuratedCeiling); // never runs away
    const pinned = curationConfig({ spotter: { curation: { maxCurated: 10 } } }, undefined)!;
    expect(effectiveMaxCurated(pinned, 36)).toBe(10);
  });

  it("allocates the budget fairly across checks instead of front-loading it", () => {
    // 3 checks; the first is phash-heavy. Time-ordered signal-first selection
    // spent the whole budget on it and starved the other two.
    const frames = [
      ...Array.from({ length: 8 }, (_, i) => ({ name: `a${i}`, trigger: "phash", chunk: "p--a--desktop", tMs: i * 10 })),
      { name: "b0", trigger: "step-start", chunk: "p--b--desktop", tMs: 100 },
      { name: "b1", trigger: "step-end", chunk: "p--b--desktop", tMs: 110 },
      { name: "c0", trigger: "step-start", chunk: "p--c--desktop", tMs: 200 },
      { name: "c1", trigger: "step-end", chunk: "p--c--desktop", tMs: 210 }
    ];
    const picked = selectCurationCandidates(frames, 3);
    expect(new Set(picked.map((f: any) => f.chunk)).size).toBe(3);
    // Within a chunk, step-end (the settled state) outranks step-start, which
    // fires before this check's navigation and shows the PREVIOUS check's page.
    expect(picked.map((f: any) => f.name)).toContain("b1");
    expect(picked.map((f: any) => f.name)).not.toContain("b0");
  });

  it("floors every check to at least one frame when curation kept none", () => {
    const rows = [
      { name: "a0", trigger: "step-start", chunk: "p--a--desktop", tMs: 0, uncurated: true },
      { name: "a1", trigger: "phash", chunk: "p--a--desktop", tMs: 5, uncurated: true },
      { name: "b0", trigger: "step-end", chunk: "p--b--desktop", tMs: 10, keep: true }
    ] as any[];
    const floored = applyReelFloor(rows);
    expect(floored).toBe(1); // only the chunk with no keep is floored
    const a = rows.find((r) => r.name === "a1");
    expect(a.keep).toBe(true);
    expect(a.floor).toBe(true); // flagged, so the UI never passes it off as a choice
    expect(a.uncurated).toBeUndefined();
    expect(a.annotation).toMatch(/Auto-selected/);
    expect(rows.find((r) => r.name === "b0").floor).toBeUndefined(); // untouched
    // The guarantee: every chunk now has a frame.
    const chunks = new Set(rows.map((r) => r.chunk));
    const covered = new Set(rows.filter((r) => r.keep === true).map((r) => r.chunk));
    expect(covered.size).toBe(chunks.size);
  });
});

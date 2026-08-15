import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendStep,
  attachMedia,
  Conflict,
  finalizeRun,
  isSafeMediaName,
  listRuns,
  mediaKindFor,
  newRunId,
  NotFound,
  openRun,
  readRun,
  resultsDir,
  runDir,
  RUN_LEVEL,
  safeRunId,
  summarize,
  type ReportStep
} from "@/lib/results-store";
import { renderIndexHtml, renderReportHtml } from "@/lib/results-report";
import { sanitizeMediaName, writeMedia, MediaTooLarge, capForKind, extractKeyframes } from "@/lib/results-media";
import { execFileSync } from "node:child_process";

// Every test runs against a throwaway GARRISON_HOME. The store resolves its
// root per call (garrisonDir() reads the env each time), so setting it in
// beforeEach is enough - and it keeps the suite from writing into the LIVE
// ~/.garrison, which other tests in this repo have historically done.
let home: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  home = mkdtempSync(path.join(os.tmpdir(), "garrison-results-"));
  process.env.GARRISON_HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

describe("ids and names are confined", () => {
  it("rejects a run id that could escape the results dir", () => {
    expect(() => safeRunId("../../etc")).toThrow();
    expect(() => safeRunId("a/b")).toThrow();
    expect(() => safeRunId("")).toThrow();
    expect(safeRunId("abc-123_X")).toBe("abc-123_X");
  });

  it("rejects a media name with a separator, a leading dot, or a traversal", () => {
    expect(isSafeMediaName("shot.png")).toBe(true);
    expect(isSafeMediaName("../shot.png")).toBe(false);
    expect(isSafeMediaName("a/b.png")).toBe(false);
    expect(isSafeMediaName(".env")).toBe(false);
  });

  it("sanitizes a hostile filename into one safe segment rather than failing the report", () => {
    expect(sanitizeMediaName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeMediaName("a b/c;rm -rf.png")).toBe("c-rm--rf.png");
    // Nothing usable left -> a generated name, never an empty or dotted one.
    expect(sanitizeMediaName("../..")).toMatch(/^media-[a-z0-9]+\.bin$/);
  });

  it("mints sortable ids so the newest run lists first without stat()ing anything", () => {
    const early = newRunId(1_000_000_000_000);
    const late = newRunId(1_900_000_000_000);
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe("a run is reported evidence unless it explicitly says otherwise", () => {
  it("defaults to reported, and only an explicit 'executed' claims a real drill run", async () => {
    expect((await openRun({ title: "a" })).origin).toBe("reported");
    expect((await openRun({ title: "b", origin: "" })).origin).toBe("reported");
    expect((await openRun({ title: "c", origin: "EXECUTED" })).origin).toBe("reported");
    expect((await openRun({ title: "d", origin: "executed" })).origin).toBe("executed");
  });

  it("says so in words on the page, not only in a colour", async () => {
    const reported = await openRun({ title: "Reported thing" });
    const html = renderReportHtml(reported);
    expect(html).toContain("Reported evidence");
    expect(html).toContain("Nothing here was executed or checked by Drill");
    expect(html).not.toContain("Executed drill run");

    const executed = await openRun({ title: "Real thing", origin: "executed" });
    expect(renderReportHtml(executed)).toContain("Executed drill run");
  });
});

describe("incremental reporting", () => {
  it("appends steps, derives the tally, and re-renders the page on every write", async () => {
    const run = await openRun({ title: "Login flow", session: "sess-1" });
    const reportPath = path.join(runDir(run.id), "report.html");

    // The page exists from the moment the run is opened - it is viewable mid-run.
    expect(await fs.readFile(reportPath, "utf8")).toContain("Login flow");

    await appendStep(run.id, { name: "opens the login page", status: "pass" });
    await appendStep(run.id, { name: "rejects a bad password", status: "fail", logs: "expected 401, got 200" });
    await appendStep(run.id, { name: "SSO path", status: "skipped" });

    const mid = await readRun(run.id);
    expect(mid?.summary).toEqual({ pass: 1, fail: 1, skipped: 1, info: 0 });
    expect(mid?.status).toBe("running");
    expect(mid?.endedAt).toBeNull();

    const html = await fs.readFile(reportPath, "utf8");
    expect(html).toContain("rejects a bad password");
    expect(html).toContain("expected 401, got 200");
  });

  it("gives each step a unique id even when the caller reuses one", async () => {
    const run = await openRun({ title: "dupes" });
    const a = await appendStep(run.id, { name: "one", status: "pass", id: "check" });
    const b = await appendStep(run.id, { name: "two", status: "pass", id: "check" });
    expect(a.step.id).toBe("check");
    expect(b.step.id).not.toBe("check");
  });

  it("keeps only the core mandatory - a run of bare steps is a complete report", async () => {
    const run = await openRun({});
    await appendStep(run.id, { name: "did the thing", status: "pass" });
    const record = await readRun(run.id);
    const step = record!.steps[0];
    expect(step.logs).toBeUndefined();
    expect(step.notes).toBeUndefined();
    expect(step.media).toEqual([]);
    expect(renderReportHtml(record!)).toContain("did the thing");
  });

  it("refuses to append to a finalized run rather than silently reopening it", async () => {
    const run = await openRun({ title: "closed" });
    await appendStep(run.id, { name: "one", status: "pass" });
    await finalizeRun(run.id, {});
    await expect(appendStep(run.id, { name: "late", status: "pass" })).rejects.toBeInstanceOf(Conflict);
  });

  it("404s on an unknown run instead of creating one", async () => {
    await expect(appendStep("nosuchrun", { name: "x", status: "pass" })).rejects.toBeInstanceOf(NotFound);
  });

  it("does not drop a step when several are appended concurrently", async () => {
    // Steps arrive as independent HTTP requests; a read-modify-write race here
    // would lose one silently, which is the worst possible failure for an
    // evidence store.
    const run = await openRun({ title: "race" });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => appendStep(run.id, { name: `step ${i}`, status: "pass" }))
    );
    const record = await readRun(run.id);
    expect(record?.steps).toHaveLength(12);
    expect(new Set(record?.steps.map((s) => s.id)).size).toBe(12);
    expect(record?.summary.pass).toBe(12);
  });
});

describe("finalize", () => {
  it("derives failed / passed / partial from the steps", async () => {
    const mk = (statuses: string[]) => statuses.map((s, i) => ({ status: s, n: i } as unknown as ReportStep));
    expect(summarize(mk(["pass", "fail"])).terminal).toBe("failed");
    expect(summarize(mk(["pass", "pass"])).terminal).toBe("passed");
    expect(summarize(mk(["skipped", "info"])).terminal).toBe("partial");
    expect(summarize([]).terminal).toBe("partial");
  });

  it("keeps a zero fail count visible but drops the empty counters that carry no verdict", async () => {
    const run = await openRun({ title: "clean" });
    await appendStep(run.id, { name: "one", status: "pass" });
    const html = renderReportHtml((await readRun(run.id))!);
    expect(html).toContain(">0</b>fail"); // the headline of a clean run
    expect(html).not.toContain(">0</b>info");
    expect(html).not.toContain(">0</b>skipped");
  });

  it("lets the caller override the derived status and records a conclusion", async () => {
    const run = await openRun({ title: "override" });
    await appendStep(run.id, { name: "one", status: "pass" });
    const done = await finalizeRun(run.id, { status: "partial", conclusion: "ran only the smoke subset" });
    expect(done.status).toBe("partial");
    expect(done.endedAt).not.toBeNull();
    expect(renderReportHtml(done)).toContain("ran only the smoke subset");
  });
});

describe("media", () => {
  it("attaches to the newest step when no step is named", async () => {
    const run = await openRun({ title: "media" });
    await appendStep(run.id, { name: "first", status: "pass" });
    await appendStep(run.id, { name: "second", status: "pass" });
    const ref = await writeMedia(run.id, { name: "shot.png", bytes: Buffer.from("png-bytes") });
    const { record } = await attachMedia(run.id, ref, null);
    expect(record.steps[0].media).toHaveLength(0);
    expect(record.steps[1].media[0].name).toBe("shot.png");
  });

  it("files a full-run recording on the RUN, not on whatever step happened to be last", async () => {
    // The recording arrives after the last step, where the newest-step default
    // would attribute it to that step's evidence.
    const run = await openRun({ title: "run video" });
    await appendStep(run.id, { name: "first", status: "pass" });
    await appendStep(run.id, { name: "last", status: "pass" });
    const ref = await writeMedia(run.id, { name: "run.webm", bytes: Buffer.from("v") });
    const { record } = await attachMedia(run.id, ref, RUN_LEVEL);
    expect(record.steps.every((s) => s.media.length === 0)).toBe(true);
    expect(record.media[0].name).toBe("run.webm");
    expect(renderReportHtml(record)).toContain("Run evidence");
  });

  it("uses the first keyframe as the video poster so the player is not a black rectangle", async () => {
    const run = await openRun({ title: "poster" });
    await appendStep(run.id, { name: "one", status: "pass" });
    const ref = await writeMedia(run.id, { name: "clip.webm", bytes: Buffer.from("v") });
    ref.keyframes = ["clip-frame-01.jpg"];
    const { record } = await attachMedia(run.id, ref, null);
    expect(renderReportHtml(record)).toContain(`poster="/results/${record.id}/media/clip-frame-01.jpg"`);
  });

  it("never overwrites an earlier file of the same name", async () => {
    const run = await openRun({ title: "dupes" });
    const a = await writeMedia(run.id, { name: "shot.png", bytes: Buffer.from("one") });
    const b = await writeMedia(run.id, { name: "shot.png", bytes: Buffer.from("two") });
    expect(a.name).toBe("shot.png");
    expect(b.name).toBe("shot-1.png");
    expect(await fs.readFile(path.join(runDir(run.id), "media", "shot.png"), "utf8")).toBe("one");
  });

  it("enforces a bigger cap for video than for images, and rejects over it", async () => {
    expect(capForKind("video")).toBeGreaterThan(capForKind("image"));
    const run = await openRun({ title: "big" });
    const oversized = Buffer.alloc(capForKind("image") + 1);
    await expect(writeMedia(run.id, { name: "huge.png", bytes: oversized })).rejects.toBeInstanceOf(MediaTooLarge);
  });

  it("classifies by extension unless told otherwise", () => {
    expect(mediaKindFor("a.png")).toBe("image");
    expect(mediaKindFor("a.webm")).toBe("video");
    expect(mediaKindFor("a.txt")).toBe("file");
    expect(mediaKindFor("a.txt", "image")).toBe("image");
  });

  it("renders media as ROOT-relative urls so the page works over the tailnet", async () => {
    const run = await openRun({ title: "urls" });
    await appendStep(run.id, { name: "one", status: "pass" });
    const ref = await writeMedia(run.id, { name: "shot.png", bytes: Buffer.from("x") });
    const { record } = await attachMedia(run.id, ref, null);
    const html = renderReportHtml(record);
    expect(html).toContain(`/results/${record.id}/media/shot.png`);
    // A machine-local absolute URL is unreachable AND mixed content from a
    // phone on the tailnet - it must never reach the client.
    expect(html).not.toMatch(/http:\/\/(127\.0\.0\.1|localhost)/);
  });
});

describe("the listing", () => {
  it("lists newest first and survives a corrupt run directory", async () => {
    const a = await openRun({ title: "first" });
    const b = await openRun({ title: "second" });
    await fs.mkdir(path.join(resultsDir(), "broken"), { recursive: true });
    await fs.writeFile(path.join(resultsDir(), "broken", "run.json"), "{not json");

    const rows = await listRuns();
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(renderIndexHtml(rows)).toContain("second");
  });

  it("returns an empty list before anything has been reported", async () => {
    expect(await listRuns()).toEqual([]);
    expect(renderIndexHtml([])).toContain("No results reported yet");
  });
});

describe("the record is a drillbook-compatible superset", () => {
  it("carries the page-shaped fields a drill page file has, plus the evidence ones", async () => {
    const run = await openRun({ title: "Muster", path: "/muster", project: "/home/x/repo" });
    await appendStep(run.id, { name: "renders", status: "pass", description: "The page renders", tags: ["smoke"] });
    const record = await readRun(run.id);

    // What a drills/pages/<id>.yml carries: id, title, path, mode, steps[] of
    // {id, description, enabled, tags}.
    expect(record).toMatchObject({ id: run.id, title: "Muster", path: "/muster", mode: "steps" });
    expect(record!.steps[0]).toMatchObject({
      id: expect.any(String),
      description: "The page renders",
      enabled: true,
      tags: ["smoke"]
    });
    // The evidence extensions a drill page does not have.
    expect(record!.steps[0]).toMatchObject({ status: "pass", name: "renders", media: [] });
  });

  it("falls back to the step name as the description so a name-only step is still a valid page step", async () => {
    const run = await openRun({ title: "t" });
    await appendStep(run.id, { name: "just a name", status: "info" });
    const record = await readRun(run.id);
    expect(record!.steps[0].description).toBe("just a name");
  });
});

describe("video keyframes", () => {
  const ffmpeg = (() => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(ffmpeg)("extracts frames from a real video and renders them before the player", async () => {
    const run = await openRun({ title: "with video" });
    await appendStep(run.id, { name: "recorded the flow", status: "pass" });
    const source = path.join(home, "clip.webm");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=6:size=320x240:rate=10",
      "-y",
      source
    ]);

    const ref = await writeMedia(run.id, { name: "clip.webm", bytes: await fs.readFile(source) });
    const { frames, note } = await extractKeyframes(run.id, ref.name);
    expect(frames.length).toBeGreaterThan(0);
    expect(note).toMatch(/keyframe/);
    ref.keyframes = frames.map((f) => f.name);
    ref.keyframeNote = note;
    for (const frame of frames) await attachMedia(run.id, frame, null);
    const { record } = await attachMedia(run.id, ref, null);

    const html = renderReportHtml(record);
    // The whole point: visual evidence is on the page before anyone presses play.
    expect(html.indexOf(frames[0].name)).toBeLessThan(html.indexOf("<video"));
    expect(html).toContain("clip.webm");
  });

  it("degrades honestly when the file is not a decodable video", async () => {
    const run = await openRun({ title: "not a video" });
    const ref = await writeMedia(run.id, { name: "broken.webm", bytes: Buffer.from("definitely not a video") });
    const { frames, note } = await extractKeyframes(run.id, ref.name);
    expect(frames).toEqual([]);
    expect(note).toMatch(/no keyframes|could not|no frames/i);
  });

  it("can be turned off entirely", async () => {
    const run = await openRun({ title: "off" });
    const ref = await writeMedia(run.id, { name: "clip.webm", bytes: Buffer.from("x") });
    const { frames, note } = await extractKeyframes(run.id, ref.name, 0);
    expect(frames).toEqual([]);
    expect(note).toContain("disabled");
  });
});

describe("the report escapes what it renders", () => {
  it("does not let a reported title or log inject markup", async () => {
    const run = await openRun({ title: "<script>alert(1)</script>" });
    await appendStep(run.id, { name: "x", status: "pass", logs: "</pre><img src=x onerror=alert(1)>" });
    const record = await readRun(run.id);
    const html = renderReportHtml(record!);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
});

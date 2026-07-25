// Run-video tightening (S1): turn the raw Playwright recording into a watchable
// highlight cut.
//
// WHY: the recorder rolls continuously from capture/start to capture/stop, but a
// check spends most of its wall-clock inside an untimed vision model call with
// the page frozen. Measured on a real 36-check run: 24.6 of 27.3 minutes were
// dead air, so the "run video" was minutes of a static page. Nothing downstream
// can fix that — the dead time is in the bytes.
//
// HOW: the Spotter already tells us when the page actually CHANGED (it writes a
// frame on phash delta / console burst / message growth / chunk boundary). Those
// frame timestamps are the activity signal. We keep a short window around each
// one, merge windows that nearly touch, and drop everything else. Each check is
// also guaranteed one window at its start so every chapter still has a landing
// spot even if that check never changed a pixel.
//
// The math (windows + offset remap) is pure and unit-tested; only buildTightVideo
// touches ffmpeg or the filesystem. Like every other helper in the evidence path
// this is warn-never-throw: a failed tighten must never fail the run, it just
// leaves the original video as the only artifact.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// Window shape around a change. PRE catches the frame that CAUSED the change
// (the spotter samples on an interval, so the visual event slightly precedes the
// captured frame); POST lets the settled state stay on screen long enough to read.
export const TIGHTEN_DEFAULTS = {
  preSec: 1.0,
  postSec: 1.5,
  // Two adjacent windows closer than this merge rather than producing a visible
  // jump cut. Also the effective cap on how long a static stretch may survive.
  mergeGapSec: 2.0,
  // Every check gets this window at its start, so a chapter button always lands
  // on that check's first moment even when the check produced no spotter frames.
  checkAnchorPreSec: 0.3,
  checkAnchorPostSec: 1.2,
  // Above this many segments the select filter gets unwieldy for ffmpeg's arg
  // parsing, so we coarsen (raise the merge gap) until we fit.
  maxSegments: 400,
  // Not worth a re-encode if the cut barely saves anything.
  minReductionRatio: 0.25
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Merge overlapping / near-touching windows. Input need not be sorted.
function mergeWindows(windows, mergeGapSec) {
  const sorted = windows
    .filter((w) => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]) && w[1] > w[0])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start - last[1] <= mergeGapSec) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

// Build the kept-segment list from the activity signal.
//
// frames: [{ tMs }]        — spotter frames (the change signal)
// steps:  [{ startMs }]    — per-check rows, so every chapter keeps a landing spot
// durationSec              — the real video duration (from ffprobe, NOT wall clock)
export function computeActivityWindows({ frames = [], steps = [], durationSec, options = {} }) {
  const opt = { ...TIGHTEN_DEFAULTS, ...options };
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];

  const windows = [];
  for (const f of frames) {
    const t = Number(f?.tMs);
    if (!Number.isFinite(t)) continue;
    const sec = t / 1000;
    if (sec > durationSec) continue; // a frame past the recording can't be shown
    windows.push([clamp(sec - opt.preSec, 0, durationSec), clamp(sec + opt.postSec, 0, durationSec)]);
  }
  for (const s of steps) {
    const t = Number(s?.startMs);
    if (!Number.isFinite(t)) continue;
    const sec = t / 1000;
    if (sec > durationSec) continue;
    windows.push([
      clamp(sec - opt.checkAnchorPreSec, 0, durationSec),
      clamp(sec + opt.checkAnchorPostSec, 0, durationSec)
    ]);
  }

  // Coarsen until the segment count is something ffmpeg will happily take.
  let gap = opt.mergeGapSec;
  let merged = mergeWindows(windows, gap);
  while (merged.length > opt.maxSegments && gap < durationSec) {
    gap *= 2;
    merged = mergeWindows(windows, gap);
  }
  return merged;
}

export function segmentsDuration(segments) {
  return (segments ?? []).reduce((acc, [start, end]) => acc + (end - start), 0);
}

// Map an offset in the ORIGINAL recording to its offset in the tightened cut.
// A time inside a kept segment maps to (kept time before it) + (offset into it);
// a time in a dropped gap maps to the start of the next kept segment, which is
// where a viewer seeking to that moment should actually land.
export function remapOffset(segments, originalSec) {
  if (!Number.isFinite(originalSec)) return null;
  let acc = 0;
  for (const [start, end] of segments ?? []) {
    if (originalSec >= end) {
      acc += end - start;
      continue;
    }
    if (originalSec > start) return acc + (originalSec - start);
    return acc; // fell in the gap before this segment
  }
  return acc; // past the last kept segment
}

// The ffmpeg select expression. Frame-exact (evaluated per frame), so it does
// not depend on keyframe placement — which matters because the recordings carry
// a keyframe only every ~5s, far coarser than our windows.
export function buildSelectFilter(segments) {
  return (segments ?? [])
    .map(([start, end]) => `between(t,${start.toFixed(3)},${end.toFixed(3)})`)
    .join("+");
}

function run(cmd, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, error: err.message, stdout: "", stderr: "" });
      return;
    }
    const timer = timeoutMs > 0 ? setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, timeoutMs) : null;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, error: err.message, stdout, stderr });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

export async function ffmpegAvailable() {
  const probe = await run("ffmpeg", ["-version"], { timeoutMs: 10_000 });
  return probe.ok;
}

// Real duration of the recording. Wall-clock deltas are NOT a substitute: the
// video timeline starts when the recording tab opens, and the two clocks drift.
export async function probeDurationSec(file) {
  const res = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    { timeoutMs: 30_000 }
  );
  if (!res.ok) return null;
  const dur = Number(String(res.stdout).trim());
  return Number.isFinite(dur) && dur > 0 ? dur : null;
}

function warn(message) {
  console.warn(`[drill] video-tighten: ${message}`);
}

// Produce `video-tight.webm` + `video-index.json` next to the source recording.
//
// video-index.json is what the UI reads: it carries the segment list, the
// original/tight durations, and per-check offsets in BOTH timelines, so the
// player can offer the tight cut by default and still deep-link into the full
// recording without recomputing anything.
export async function buildTightVideo({
  dir,
  source = "video.webm",
  frames = [],
  steps = [],
  options = {},
  timeoutMs = 15 * 60 * 1000
}) {
  const opt = { ...TIGHTEN_DEFAULTS, ...options };
  const sourcePath = path.join(dir, source);
  try {
    await fs.access(sourcePath);
  } catch {
    return { ok: false, reason: "no-source" };
  }

  if (!(await ffmpegAvailable())) {
    warn("ffmpeg not on PATH — leaving the full recording as the only artifact");
    return { ok: false, reason: "no-ffmpeg" };
  }

  const durationSec = await probeDurationSec(sourcePath);
  if (!durationSec) {
    warn("could not probe the recording duration");
    return { ok: false, reason: "no-duration" };
  }

  const segments = computeActivityWindows({ frames, steps, durationSec, options: opt });
  if (!segments.length) {
    return { ok: false, reason: "no-activity" };
  }
  const tightSec = segmentsDuration(segments);
  if (tightSec >= durationSec * (1 - opt.minReductionRatio)) {
    // Already dense — a re-encode would cost minutes to save seconds.
    return { ok: false, reason: "not-worth-it", durationSec, tightSec };
  }

  const outName = "video-tight.webm";
  const outPath = path.join(dir, outName);
  const tmpPath = `${outPath}.${process.pid}.tmp.webm`;
  const select = buildSelectFilter(segments);
  const startedAt = Date.now();
  const res = await run(
    "ffmpeg",
    [
      "-v", "error", "-y",
      "-i", sourcePath,
      // setpts renumbers the surviving frames onto a continuous 25fps timeline;
      // without it the kept frames keep their original PTS and the player shows
      // the original duration with long frozen stretches — i.e. no improvement.
      "-vf", `select='${select}',setpts=N/25/TB`,
      "-an",
      "-c:v", "libvpx",
      "-b:v", "1M",
      "-crf", "33",
      "-deadline", "realtime",
      "-cpu-used", "8",
      "-auto-alt-ref", "0",
      tmpPath
    ],
    { timeoutMs }
  );
  if (!res.ok) {
    warn(`ffmpeg failed: ${String(res.stderr || res.error).slice(0, 400)}`);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, reason: "ffmpeg-failed" };
  }
  await fs.rename(tmpPath, outPath);
  const encodeMs = Date.now() - startedAt;

  let bytes = null;
  try {
    bytes = (await fs.stat(outPath)).size;
  } catch { /* size is informational only */ }

  const chapters = (steps ?? []).map((s) => ({
    pageId: s.pageId,
    stepId: s.stepId,
    viewportId: s.viewportId,
    status: s.status ?? null,
    originalMs: Number.isFinite(Number(s?.startMs)) ? Number(s.startMs) : null,
    tightMs: Number.isFinite(Number(s?.startMs))
      ? Math.round(remapOffset(segments, Number(s.startMs) / 1000) * 1000)
      : null
  }));

  const index = {
    version: 1,
    source,
    tight: outName,
    originalDurationMs: Math.round(durationSec * 1000),
    tightDurationMs: Math.round(tightSec * 1000),
    removedMs: Math.round((durationSec - tightSec) * 1000),
    bytes,
    encodeMs,
    segments: segments.map(([start, end]) => ({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) })),
    chapters,
    generatedAt: new Date().toISOString()
  };
  const indexPath = path.join(dir, "video-index.json");
  const tmpIndex = `${indexPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpIndex, JSON.stringify(index, null, 2));
  await fs.rename(tmpIndex, indexPath);

  return { ok: true, ...index };
}

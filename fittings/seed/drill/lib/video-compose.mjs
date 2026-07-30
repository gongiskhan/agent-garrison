// Composed run video (walkthrough merge): turn the raw Playwright recording
// into a watchable, scrubbable mp4 without dropping a single moment.
//
// WHY: the tighten pass (video-tighten.mjs) CUT the dead air, which made the
// highlight watchable but threw the idle stretches away, and the artifact
// stayed a vp8 webm with ~5s keyframes — miserable to scrub. The walkthrough
// skill's videos are better for exactly transferable reasons: h264 mp4 with
// +faststart and dense keyframes (smooth scrubbing), honest TIMELAPSE of long
// operations instead of cuts, burned-in captions saying what is happening,
// and a title card. This module ports that assembly onto drill's real
// captured footage — no re-recording, so the video stays evidence of the run
// that actually happened.
//
// HOW: the Spotter's frame timestamps are the activity signal (same as
// tighten). Active windows play at 1×; the gaps between them play as a
// timelapse at an adaptive speed, so nothing is hidden — a 90s hang is
// visibly a 90s hang, just compressed. Each check's title is burned in as a
// caption (SRT via libass), timelapse stretches are labelled with their
// speed, and a short title card fronts the video. Chapters ride
// video-index.json exactly like the tighten cut did (`tight` still names the
// watchable artifact so the UI contract holds), with per-check offsets in
// both timelines.
//
// The math (segment plan + offset remap + SRT) is pure and unit-tested; only
// buildRunVideo touches ffmpeg or the filesystem. Warn-never-throw: a failed
// compose must never fail the run — the caller falls back to the tighten cut
// or the raw recording.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeActivityWindows, probeDurationSec, ffmpegAvailable } from "./video-tighten.mjs";

export const COMPOSE_DEFAULTS = {
  // Coarser than tighten's 400: every segment is its own encode invocation
  // here (the walkthrough per-clip architecture), so keep the count sane.
  // Coverage does not suffer — gaps are sped up, never dropped.
  maxSegments: 60,
  // A gap shorter than this plays at 1× (a visible cut-in/out for 2s of idle
  // costs more attention than it saves).
  minGapSec: 3.0,
  // Timelapse pacing: each gap is compressed to play in about this long.
  gapPlaySec: 2.0,
  minSpeed: 4,
  maxSpeed: 40,
  titleSec: 2.2,
  fps: 25,
  crf: 22,
  // Keyframe every 2s — the whole point of the re-encode is scrubbing.
  gopFrames: 50,
  // How long a chapter caption stays up (clamped to the next caption).
  captionSec: 10,
  minCaptionSec: 1.5
};

function clampSpeed(factor, opt) {
  return Math.min(opt.maxSpeed, Math.max(opt.minSpeed, factor));
}

// Full-coverage segment plan over [0, durationSec]: active windows at speed 1,
// gaps as timelapse. Adjacent 1× segments merge; sub-minGap gaps fold into 1×.
export function buildComposePlan({ windows, durationSec, options = {} }) {
  const opt = { ...COMPOSE_DEFAULTS, ...options };
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const active = (windows ?? [])
    .filter((w) => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]) && w[1] > w[0])
    .sort((a, b) => a[0] - b[0]);
  if (!active.length) return [{ start: 0, end: durationSec, speed: 1 }];

  const raw = [];
  let cursor = 0;
  for (const [start, end] of active) {
    if (start > cursor) raw.push({ start: cursor, end: start, speed: null }); // gap, speed decided below
    raw.push({ start: Math.max(start, cursor), end: Math.min(end, durationSec), speed: 1 });
    cursor = Math.max(cursor, end);
    if (cursor >= durationSec) break;
  }
  if (cursor < durationSec) raw.push({ start: cursor, end: durationSec, speed: null });

  const plan = [];
  for (const seg of raw) {
    if (seg.end - seg.start <= 0) continue;
    const dur = seg.end - seg.start;
    const speed = seg.speed === 1 || dur < opt.minGapSec
      ? 1
      : Math.round(clampSpeed(dur / opt.gapPlaySec, opt));
    const last = plan[plan.length - 1];
    if (last && last.speed === speed) last.end = seg.end;
    else plan.push({ start: seg.start, end: seg.end, speed });
  }
  return plan;
}

export function composedDurationSec(plan) {
  return (plan ?? []).reduce((acc, s) => acc + (s.end - s.start) / s.speed, 0);
}

// Map an offset in the ORIGINAL recording to the composed timeline (excluding
// any title card — the caller adds that shift). A time inside a segment maps
// proportionally to its speed; past the end maps to the composed end.
export function remapComposedOffset(plan, originalSec) {
  if (!Number.isFinite(originalSec)) return null;
  let acc = 0;
  for (const seg of plan ?? []) {
    if (originalSec >= seg.end) {
      acc += (seg.end - seg.start) / seg.speed;
      continue;
    }
    if (originalSec > seg.start) return acc + (originalSec - seg.start) / seg.speed;
    return acc;
  }
  return acc;
}

export function srtTimestamp(sec) {
  // Derive everything from whole milliseconds so a fractional part that
  // rounds up carries into the seconds field (59.9996 → 00:01:00,000, never
  // the malformed 00:00:59,1000).
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (v, n = 2) => String(v).padStart(n, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// Caption entries on the COMPOSED timeline (title offset included): one per
// chapter (check title, FAILED-prefixed on failure) plus a speed label for
// every timelapse stretch. Ends clamp to the next entry so nothing stacks.
export function buildCaptions({ plan, steps = [], titleSec = 0, options = {} }) {
  const opt = { ...COMPOSE_DEFAULTS, ...options };
  const entries = [];
  for (const s of steps) {
    const t = Number(s?.startMs);
    if (!Number.isFinite(t)) continue;
    const at = titleSec + (remapComposedOffset(plan, t / 1000) ?? 0);
    const failed = s.status && s.status !== "completed";
    const label = (s.title ?? "").trim() || `${s.pageId ?? "?"} · ${s.stepId ?? "?"}`;
    entries.push({ start: at, end: at + opt.captionSec, text: `${failed ? "FAILED: " : ""}${label}` });
  }
  let acc = titleSec;
  for (const seg of plan ?? []) {
    const dur = (seg.end - seg.start) / seg.speed;
    if (seg.speed > 1 && dur >= 1.2) {
      entries.push({ start: acc, end: acc + dur, text: `idle · fast-forward ${seg.speed}x` });
    }
    acc += dur;
  }
  entries.sort((a, b) => a.start - b.start);
  for (let i = 0; i < entries.length; i += 1) {
    const next = entries[i + 1];
    if (next) entries[i].end = Math.min(entries[i].end, next.start);
    entries[i].end = Math.max(entries[i].end, entries[i].start + opt.minCaptionSec);
    if (next && entries[i].end > next.start) next.start = entries[i].end;
  }
  return entries.filter((e) => e.end > e.start);
}

export function captionsToSrt(entries) {
  return entries
    .map((e, i) => `${i + 1}\n${srtTimestamp(e.start)} --> ${srtTimestamp(e.end)}\n${e.text}\n`)
    .join("\n");
}

function run(cmd, args, { timeoutMs = 0, cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd });
    } catch (err) {
      resolve({ ok: false, error: err.message, stdout: "", stderr: "" });
      return;
    }
    const timer = timeoutMs > 0 ? setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs) : null;
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

function warn(message) {
  console.warn(`[drill] video-compose: ${message}`);
}

async function probeSize(file) {
  const res = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0", file
  ], { timeoutMs: 30_000 });
  if (!res.ok) return null;
  const [w, h] = String(res.stdout).trim().split(",").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  // h264/yuv420p wants even dimensions.
  return { width: Math.floor(w / 2) * 2, height: Math.floor(h / 2) * 2 };
}

async function hasFilter(name) {
  const res = await run("ffmpeg", ["-hide_banner", "-filters"], { timeoutMs: 15_000 });
  return res.ok && new RegExp(`\\b${name}\\b`).test(res.stdout);
}


// Produce `video-final.mp4` + `video-index.json` next to the source recording.
//
// video-index.json keeps the tighten contract (`tight` names the watchable
// artifact, chapters carry originalMs/tightMs) and adds the compose fields:
// mode, per-segment speed, titleMs, captions. Intermediates live in a temp
// dir OUTSIDE the evidence dir (everything flat in the run dir is servable
// and retention-exempt — work files must not become that).
export async function buildRunVideo({
  dir,
  source = "video.webm",
  frames = [],
  steps = [],
  title = null,
  options = {},
  timeoutMs = 20 * 60 * 1000
}) {
  const opt = { ...COMPOSE_DEFAULTS, ...options };
  const sourcePath = path.join(dir, source);
  try {
    await fs.access(sourcePath);
  } catch {
    return { ok: false, reason: "no-source" };
  }
  if (!(await ffmpegAvailable())) {
    warn("ffmpeg not on PATH — leaving the raw recording as the only artifact");
    return { ok: false, reason: "no-ffmpeg" };
  }
  const durationSec = await probeDurationSec(sourcePath);
  if (!durationSec) return { ok: false, reason: "no-duration" };
  const size = await probeSize(sourcePath);
  if (!size) return { ok: false, reason: "no-size" };

  const windows = computeActivityWindows({ frames, steps, durationSec, options: { maxSegments: opt.maxSegments } });
  const plan = buildComposePlan({ windows, durationSec, options: opt });
  if (!plan.length) return { ok: false, reason: "no-plan" };

  const startedAt = Date.now();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "drill-video-"));
  try {
    const encodeArgs = (extra) => [
      "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(opt.crf),
      "-pix_fmt", "yuv420p", "-g", String(opt.gopFrames),
      ...extra
    ];
    const clips = [];

    // Title card: optional and non-blocking — drawtext needs libfreetype and
    // a resolvable font; a failure here just means no intro. The text goes
    // through textfile= (relative to cwd=work), which keeps newlines and
    // needs no filter-syntax escaping.
    let titleSec = 0;
    if (title && (await hasFilter("drawtext"))) {
      const titleClip = path.join(work, "clip-title.mp4");
      await fs.writeFile(path.join(work, "title.txt"), String(title));
      const res = await run("ffmpeg", [
        "-v", "error", "-y",
        "-f", "lavfi", "-i", `color=c=0x0b0e14:s=${size.width}x${size.height}:r=${opt.fps}:d=${opt.titleSec}`,
        "-vf", `drawtext=textfile=title.txt:fontcolor=0xE8E4D8:fontsize=${Math.max(20, Math.round(size.width / 42))}:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=14`,
        ...encodeArgs([titleClip])
      ], { timeoutMs: 60_000, cwd: work });
      if (res.ok) {
        clips.push(titleClip);
        titleSec = opt.titleSec;
      } else {
        warn(`title card skipped: ${String(res.stderr || res.error).slice(0, 200)}`);
      }
    }

    // Per-segment clips, walkthrough-style: normalize everything to one
    // canonical fps/size/codec so the concat stage is uniform; timelapse
    // segments are setpts-compressed (sped up, never dropped).
    const deadline = startedAt + timeoutMs;
    for (let i = 0; i < plan.length; i += 1) {
      if (Date.now() > deadline) return { ok: false, reason: "timeout" };
      const seg = plan[i];
      const clip = path.join(work, `clip-${String(i).padStart(4, "0")}.mp4`);
      const speedFilter = seg.speed > 1 ? `setpts=(PTS-STARTPTS)/${seg.speed},` : "setpts=PTS-STARTPTS,";
      const res = await run("ffmpeg", [
        "-v", "error", "-y",
        "-ss", seg.start.toFixed(3), "-t", (seg.end - seg.start).toFixed(3),
        "-i", sourcePath,
        "-vf", `${speedFilter}fps=${opt.fps},scale=${size.width}:${size.height}`,
        ...encodeArgs([clip])
      ], { timeoutMs: Math.max(30_000, deadline - Date.now()), cwd: work });
      if (!res.ok) {
        warn(`segment ${i} failed: ${String(res.stderr || res.error).slice(0, 300)}`);
        return { ok: false, reason: "segment-failed" };
      }
      clips.push(clip);
    }

    // Captions on the composed timeline. libass absent → compose uncaptioned.
    const captionEntries = buildCaptions({ plan, steps, titleSec, options: opt });
    let srtName = null;
    if (captionEntries.length && (await hasFilter("subtitles"))) {
      srtName = "captions.srt";
      await fs.writeFile(path.join(work, srtName), captionsToSrt(captionEntries));
    }

    const listFile = path.join(work, "clips.txt");
    await fs.writeFile(listFile, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"));
    const outName = "video-final.mp4";
    const outPath = path.join(dir, outName);
    const tmpOut = path.join(work, "final.mp4");
    const style = "FontSize=13,PrimaryColour=&H00E8E4D8,BackColour=&H66000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=16";
    const concatOnce = async (withCaptions) => run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listFile,
      ...(withCaptions && srtName ? ["-vf", `subtitles=${srtName}:force_style='${style}'`] : []),
      ...encodeArgs(["-movflags", "+faststart", tmpOut])
    ], { timeoutMs: Math.max(60_000, deadline - Date.now()), cwd: work });
    let concat = await concatOnce(true);
    let captioned = !!srtName;
    if (!concat.ok && srtName) {
      warn(`captioned concat failed, retrying bare: ${String(concat.stderr || concat.error).slice(0, 200)}`);
      captioned = false;
      concat = await concatOnce(false);
    }
    if (!concat.ok) {
      warn(`concat failed: ${String(concat.stderr || concat.error).slice(0, 300)}`);
      return { ok: false, reason: "concat-failed" };
    }
    await fs.copyFile(tmpOut, `${outPath}.${process.pid}.tmp`);
    await fs.rename(`${outPath}.${process.pid}.tmp`, outPath);
    const encodeMs = Date.now() - startedAt;

    let bytes = null;
    try { bytes = (await fs.stat(outPath)).size; } catch { /* informational */ }

    const composedSec = titleSec + composedDurationSec(plan);
    const chapters = (steps ?? []).map((s) => ({
      pageId: s.pageId,
      stepId: s.stepId,
      viewportId: s.viewportId,
      status: s.status ?? null,
      title: s.title ?? null,
      originalMs: Number.isFinite(Number(s?.startMs)) ? Number(s.startMs) : null,
      tightMs: Number.isFinite(Number(s?.startMs))
        ? Math.round((titleSec + (remapComposedOffset(plan, Number(s.startMs) / 1000) ?? 0)) * 1000)
        : null
    }));

    const index = {
      version: 2,
      mode: "composed",
      source,
      // `tight` stays the name of the watchable artifact — the UI contract
      // from the tighten era; `final` is the same value under its real name.
      tight: outName,
      final: outName,
      originalDurationMs: Math.round(durationSec * 1000),
      tightDurationMs: Math.round(composedSec * 1000),
      removedMs: Math.round(Math.max(0, durationSec - composedSec) * 1000),
      titleMs: Math.round(titleSec * 1000),
      captions: captioned,
      bytes,
      encodeMs,
      segments: plan.map((s) => ({ startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), speed: s.speed })),
      chapters,
      generatedAt: new Date().toISOString()
    };
    const indexPath = path.join(dir, "video-index.json");
    const tmpIndex = `${indexPath}.${process.pid}.tmp`;
    await fs.writeFile(tmpIndex, JSON.stringify(index, null, 2));
    await fs.rename(tmpIndex, indexPath);
    return { ok: true, ...index };
  } catch (err) {
    warn(err.message);
    return { ok: false, reason: "compose-crashed", error: err.message };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

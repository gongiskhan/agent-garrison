import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { contentTypeFor, isSafeMediaName, mediaDir, mediaKindFor, type MediaKind, type MediaRef } from "./results-store";

// Media ingest for the Results store: write the bytes under the run's media/
// dir, then (for a video) extract a small set of keyframes so the report shows
// visual evidence before anyone presses play.
//
// Defaults, documented because the brief left them to the implementer:
//   video cap      100 MB  (GARRISON_RESULTS_VIDEO_MAX_MB)
//   image/file cap  25 MB  (GARRISON_RESULTS_MEDIA_MAX_MB)
//   keyframes            4  (GARRISON_RESULTS_KEYFRAMES, 0 disables)
// 100 MB holds several minutes of a Chrome screen recording at the bitrate
// Playwright/CDP produce, which is the shape of video that actually arrives
// here; four frames is enough to read a flow at a glance without turning a
// step into a contact sheet. Both are env-tunable because the cap is enforced
// in the Garrison app (where the bytes land), not in the reporting session.

export const DEFAULT_VIDEO_MAX_MB = 100;
export const DEFAULT_MEDIA_MAX_MB = 25;
export const DEFAULT_KEYFRAMES = 4;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function videoMaxBytes(): number {
  return envInt("GARRISON_RESULTS_VIDEO_MAX_MB", DEFAULT_VIDEO_MAX_MB) * 1024 * 1024;
}
export function mediaMaxBytes(): number {
  return envInt("GARRISON_RESULTS_MEDIA_MAX_MB", DEFAULT_MEDIA_MAX_MB) * 1024 * 1024;
}
export function keyframeCount(): number {
  return envInt("GARRISON_RESULTS_KEYFRAMES", DEFAULT_KEYFRAMES);
}

export function capForKind(kind: MediaKind): number {
  return kind === "video" ? videoMaxBytes() : mediaMaxBytes();
}

export class MediaTooLarge extends Error {}
export class MediaRejected extends Error {}

// Sanitize an arbitrary caller-supplied filename into one media-dir segment.
// Never throws: a hostile or empty name degrades to a generated one rather
// than failing an otherwise-good report.
export function sanitizeMediaName(raw: string, fallbackExt = ".bin"): string {
  const base = path.basename(String(raw ?? "")).replace(/[^A-Za-z0-9._-]/g, "-");
  const trimmed = base.replace(/^[.-]+/, "").slice(0, 120);
  if (trimmed && isSafeMediaName(trimmed)) return trimmed;
  return `media-${Date.now().toString(36)}${fallbackExt}`;
}

// Claim a free name in the run's media dir (a second `screenshot.png` on the
// same run must not silently overwrite the first).
async function uniqueName(runId: string, name: string): Promise<string> {
  const dir = mediaDir(runId);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || "media";
  for (let i = 0; i < 200; i += 1) {
    const candidate = i === 0 ? name : `${stem}-${i}${ext}`;
    try {
      await fs.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now().toString(36)}${ext}`;
}

export interface WriteMediaInput {
  name: string;
  bytes: Buffer;
  kind?: string;
  caption?: string;
}

export async function writeMedia(runId: string, input: WriteMediaInput): Promise<MediaRef> {
  const name = sanitizeMediaName(input.name);
  const kind = mediaKindFor(name, input.kind);
  const cap = capForKind(kind);
  if (input.bytes.byteLength > cap) {
    throw new MediaTooLarge(
      `${name} is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the ${kind} cap is ${(cap / 1024 / 1024).toFixed(0)} MB`
    );
  }
  const dir = mediaDir(runId);
  await fs.mkdir(dir, { recursive: true });
  const final = await uniqueName(runId, name);
  await fs.writeFile(path.join(dir, final), input.bytes);
  return {
    name: final,
    kind,
    ...(input.caption ? { caption: String(input.caption).slice(0, 400) } : {}),
    bytes: input.bytes.byteLength,
    contentType: contentTypeFor(final),
    at: new Date().toISOString()
  };
}

function run(bin: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? "") });
    });
  });
}

export async function probeDurationSec(file: string): Promise<number | null> {
  const res = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file
  ]);
  if (!res.ok) return null;
  const dur = Number(res.stdout.trim());
  return Number.isFinite(dur) && dur > 0 ? dur : null;
}

export interface KeyframeResult {
  frames: MediaRef[];
  note: string;
}

// Extract up to `count` evenly-spread frames from a video already written into
// the run's media dir. Degrades honestly: no ffmpeg, an unprobeable container,
// or a failed decode returns zero frames plus a note that says why, and the
// video itself is still attached and playable.
export async function extractKeyframes(runId: string, videoName: string, count = keyframeCount()): Promise<KeyframeResult> {
  if (count <= 0) return { frames: [], note: "keyframe extraction disabled" };
  const dir = mediaDir(runId);
  const source = path.join(dir, videoName);
  const stem = videoName.slice(0, videoName.length - path.extname(videoName).length) || "video";

  const duration = await probeDurationSec(source);
  const frames: MediaRef[] = [];
  let note = "";

  if (duration) {
    // Spread across the body of the clip; the very first and last frames of a
    // screen recording are usually a blank or half-painted page.
    for (let i = 0; i < count; i += 1) {
      const at = duration * ((i + 0.5) / count);
      const name = await uniqueName(runId, `${stem}-frame-${String(i + 1).padStart(2, "0")}.jpg`);
      const res = await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        at.toFixed(3),
        "-i",
        source,
        "-frames:v",
        "1",
        "-vf",
        "scale=960:-2",
        "-q:v",
        "4",
        "-y",
        path.join(dir, name)
      ]);
      if (!res.ok) continue;
      try {
        const stat = await fs.stat(path.join(dir, name));
        if (stat.size > 0) {
          frames.push({
            name,
            kind: "image",
            caption: `${videoName} at ${at.toFixed(1)}s`,
            bytes: stat.size,
            contentType: "image/jpeg",
            at: new Date().toISOString()
          });
        }
      } catch {
        // frame never landed - skip it
      }
    }
    note = frames.length ? `${frames.length} keyframe${frames.length === 1 ? "" : "s"} extracted` : "keyframe extraction produced no frames";
  } else {
    // A Chrome/CDP webm frequently carries no duration in its header. Sampling
    // at a fixed interval needs no duration at all, so it still yields
    // evidence instead of giving up.
    const pattern = path.join(dir, `${stem}-frame-%02d.jpg`);
    const res = await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-vf",
      "fps=1/5,scale=960:-2",
      "-frames:v",
      String(count),
      "-q:v",
      "4",
      "-y",
      pattern
    ]);
    if (!res.ok) return { frames: [], note: "ffmpeg unavailable or could not decode the video - no keyframes" };
    for (let i = 1; i <= count; i += 1) {
      const name = `${stem}-frame-${String(i).padStart(2, "0")}.jpg`;
      try {
        const stat = await fs.stat(path.join(dir, name));
        if (stat.size > 0) {
          frames.push({
            name,
            kind: "image",
            caption: `${videoName} sample ${i}`,
            bytes: stat.size,
            contentType: "image/jpeg",
            at: new Date().toISOString()
          });
        }
      } catch {
        break;
      }
    }
    note = frames.length
      ? `${frames.length} keyframe${frames.length === 1 ? "" : "s"} sampled (duration unknown)`
      : "video duration unknown and no frames could be sampled";
  }
  return { frames, note };
}

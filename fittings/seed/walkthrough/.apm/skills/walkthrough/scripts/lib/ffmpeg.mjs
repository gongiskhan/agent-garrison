// ffmpeg compositing: normalize every segment to one canonical format, then
// concat. This ffmpeg build lacks drawtext, so all text is rendered upstream as
// PNGs (title cards, caption bars) and composited with core overlay/vstack.
import { exec } from './util.mjs';

const V = (w, h, fps) => `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0b0e14,fps=${fps},format=yuv420p`;

// Normalize a clip (browser webm / title mp4) to canonical WxH/fps/h264.
export async function normalize(input, output, { width, height, fps }) {
  const r = await exec('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', input,
    '-vf', V(width, height, fps),
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', output,
  ]);
  return r;
}

// A still PNG -> a clip of the given duration (title/outro cards, evidence panels).
export async function pngToClip(png, output, { width, height, fps, duration }) {
  const r = await exec('ffmpeg', [
    '-y', '-loglevel', 'error', '-loop', '1', '-t', String(duration), '-i', png,
    '-vf', `scale=${width}:${height},fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', output,
  ]);
  return r;
}

// Concat normalized clips (identical codec/params) into the final, streamable mp4.
export async function concat(clips, listFile, output) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(listFile, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'));
  const r = await exec('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
  ]);
  return r;
}

// Speed up a clip by `factor` (e.g. 8 -> 8x faster) for a timelapse of a long,
// honest operation (a build running, a job processing). Video has no audio, so
// only setpts is needed; re-resample to the canonical fps so the concat step
// gets a uniform stream.
export async function speedUp(input, output, factor, { fps = 30 } = {}) {
  const r = await exec('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', input,
    '-filter:v', `setpts=PTS/${factor},fps=${fps},format=yuv420p`,
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', output,
  ]);
  return r;
}

// Extract a single frame at timestamp t (seconds) into out.png.
export async function extractFrame(video, t, out) {
  const r = await exec('ffmpeg', [
    '-y', '-loglevel', 'error', '-ss', String(t), '-i', video,
    '-frames:v', '1', '-q:v', '2', out,
  ]);
  return r;
}

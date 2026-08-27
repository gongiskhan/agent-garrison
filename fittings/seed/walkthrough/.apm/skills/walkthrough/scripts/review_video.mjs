#!/usr/bin/env node
// review_video.mjs — drive the SECOND verification gate: a holistic "does this
// video actually show the feature end-to-end to a developer?" review, powered by
// the claude-video (`/watch`) skill. The per-beat frame gate (extract_frames.mjs)
// proves each beat rendered the right thing; THIS gate proves the whole video
// tells a complete, sensible story.
//
// It locates claude-video's watch.py, ingests final.mp4 (no audio -> --no-whisper),
// and prints the exact rubric the verifier must apply when Reading the frames the
// tool produces. The judgment itself is done by the calling Claude (per SKILL.md).
//
// Usage: node review_video.mjs <runDir>
//   env WALKTHROUGH_WATCH_PY may point directly at watch.py.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from './lib/util.mjs';

const runDir = process.argv[2];
if (!runDir || !existsSync(path.join(runDir, 'manifest.json'))) {
  console.error('Usage: node review_video.mjs <runDir>   (runDir must contain manifest.json)');
  process.exit(2);
}

// ---- locate claude-video watch.py -----------------------------------------
export function findWatchPy() {
  if (process.env.WALKTHROUGH_WATCH_PY && existsSync(process.env.WALKTHROUGH_WATCH_PY)) {
    return process.env.WALKTHROUGH_WATCH_PY;
  }
  const home = os.homedir();
  const direct = [
    path.join(home, '.claude', 'skills', 'watch', 'scripts', 'watch.py'),
    path.join(home, '.codex', 'skills', 'watch', 'scripts', 'watch.py'),
  ];
  for (const p of direct) if (existsSync(p)) return p;
  // Plugin installs land somewhere under ~/.claude/plugins/ — find watch.py whose
  // path mentions the watch skill.
  for (const base of [path.join(home, '.claude', 'plugins'), path.join(home, '.claude', 'skills')]) {
    const hit = findFile(base, 'watch.py', 6);
    if (hit) return hit;
  }
  return null;
}
function findFile(dir, name, depth) {
  if (depth < 0 || !existsSync(dir)) return null;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name && /watch/i.test(full)) return full;
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.git')) {
      const r = findFile(full, name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

// ---- build the review rubric from the storyboard's stated intent ----------
const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
const finalMp4 = path.join(runDir, 'final.mp4');
const captions = (manifest.beats || []).map((b, i) => `  ${i + 1}. ${b.caption}${b.expectFailure ? '  [expected failure]' : ''}`).join('\n');
const dur = manifest.duration ? `${Math.round(manifest.duration)}s` : 'unknown length';

const question = [
  `This is a screen-recorded product walkthrough whose JOB is to PROVE a finished change by showing it working end-to-end to a developer who has never seen it.`,
  `Claimed title: "${manifest.title || manifest.project}". Length: ${dur}.`,
  `The video claims to show, in order:`,
  captions || '  (no captions on record)',
  ``,
  `Watch the WHOLE video and judge it strictly:`,
  `1. STORY: does it show the real end-to-end arc — the starting point, the action that exercises the feature, and the REAL result (data/artifact), not just a page rendering?`,
  `2. LONG OPS: if it kicks off a build/generation/job, does it show the start, that it actually runs, and the COMPLETED artifact — and ideally a follow-up change being made and reflected?`,
  `3. GAPS: what essential part of the story is MISSING, only implied, or never actually shown on screen?`,
  `4. INTEGRITY: any dead/blank/broken stretches, error states presented as success, or captions that do not match what is on screen?`,
  `5. VERDICT: reply "PASS" only if a developer who never saw this feature would, from this video alone, understand what it does and see it genuinely working end-to-end. Otherwise reply "FAIL" and list the specific, concrete fixes (which beat/flow to add, what to show, what to cut).`,
].join('\n');

const watchPy = findWatchPy();
if (!watchPy) {
  console.error(JSON.stringify({
    ok: false,
    error: 'claude-video (watch.py) not found — the holistic review gate is REQUIRED.',
    install: ['/plugin marketplace add bradautomates/claude-video', '/plugin install watch@claude-video'],
    hint: 'Or set WALKTHROUGH_WATCH_PY to an existing watch.py. Then re-run preflight.',
  }, null, 2));
  process.exit(3);
}

const outDir = path.join(runDir, 'watch');
const py = process.env.PYTHON || 'python3';
console.error(`[review] ingesting ${path.basename(finalMp4)} via ${watchPy} (silent video -> --no-whisper)`);

// watch.py takes only the video positional + flags; the rubric below is for the
// VERIFIER to apply when Reading the frames it produces (the /watch *skill*
// passes a question to Claude, but the script itself does not accept one).
const r = await exec(py, [
  watchPy, finalMp4,
  '--no-whisper',        // walkthrough videos have no audio track
  '--resolution', '768', // legible captions/UI text
  '--out-dir', outDir,
], { timeoutMs: 300000 });

// watch.py writes chronological frames to <outDir>/frames/frame_NNNN.jpg
const framesDir = path.join(outDir, 'frames');
const frames = existsSync(framesDir)
  ? readdirSync(framesDir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => path.join(framesDir, f))
  : [];

console.log(JSON.stringify({
  ok: r.code === 0 && frames.length > 0,
  watchPy, video: finalMp4, framesDir,
  frameCount: frames.length,
  frames,
  question,
  toolStderrTail: (r.stderr || '').slice(-600),
  next: (r.code === 0 && frames.length > 0)
    ? 'Read the frames listed in `frames` IN ORDER (they are chronological), then answer the 5-point rubric in `question`. Treat a FAIL like a failed beat: diagnose, re-plan the storyboard, re-record both gates.'
    : 'claude-video produced no frames / exited non-zero — see toolStderrTail. Fix and retry; do NOT skip this gate.',
}, null, 2));
process.exit((r.code === 0 && frames.length > 0) ? 0 : 1);

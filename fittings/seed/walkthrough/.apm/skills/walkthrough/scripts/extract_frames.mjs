#!/usr/bin/env node
// extract_frames.mjs — pull verification frames from final.mp4 using the
// MEASURED manifest: one targeted frame at each beat's midpoint (primary), plus
// an optional interval safety net. Writes frames/<beat>.png and frames/index.json
// so the agent can Read each frame and assert caption + screen per beat.
//
// Usage: node extract_frames.mjs <runDir> [--interval]   (--interval adds ~10/min)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { extractFrame } from './lib/ffmpeg.mjs';

const runDir = process.argv[2];
if (!runDir) { console.error('Usage: node extract_frames.mjs <runDir> [--interval]'); process.exit(2); }
const withInterval = process.argv.includes('--interval');

const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
const finalMp4 = path.join(runDir, 'final.mp4');
const framesDir = path.join(runDir, 'frames');
mkdirSync(framesDir, { recursive: true });

const index = { video: finalMp4, beats: [], interval: [] };

// Primary: one frame per beat at its measured midpoint.
let n = 0;
for (const b of manifest.beats) {
  const name = `beat-${String(n).padStart(2, '0')}-${b.id}.png`;
  const out = path.join(framesDir, name);
  const r = await extractFrame(finalMp4, b.tMid, out);
  index.beats.push({
    id: b.id, t: b.tMid, frame: `frames/${name}`,
    expectCaption: b.caption, expectScreen: b.expectedScreen, expectFailure: b.expectFailure,
    extracted: r.code === 0,
  });
  n++;
}

// Safety net: interval frames (~10/min) for catching anything between beats.
if (withInterval) {
  const step = 6; // seconds -> 10 per minute
  for (let t = 1, k = 0; t < manifest.duration; t += step, k++) {
    const name = `interval-${String(k).padStart(2, '0')}-t${Math.round(t)}.png`;
    const out = path.join(framesDir, name);
    const r = await extractFrame(finalMp4, t, out);
    index.interval.push({ t, frame: `frames/${name}`, extracted: r.code === 0 });
  }
}

writeFileSync(path.join(framesDir, 'index.json'), JSON.stringify(index, null, 2));
console.log(JSON.stringify({
  ok: true, framesDir,
  beatFrames: index.beats.length, intervalFrames: index.interval.length,
  beats: index.beats.map((b) => ({ id: b.id, t: b.t, frame: b.frame, expectCaption: b.expectCaption, expectScreen: b.expectScreen, expectFailure: b.expectFailure })),
}, null, 2));

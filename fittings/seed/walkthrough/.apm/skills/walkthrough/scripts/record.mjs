#!/usr/bin/env node
// record.mjs — consume a declarative storyboard.json, record + normalize each
// segment, stitch one streamable MP4, and emit a MEASURED manifest mapping every
// caption beat to its timestamp range in the final video (plus a pass-record).
//
// Usage: node record.mjs <storyboard.json> [--out <runDir>]
//
// The agent writes the storyboard and captions; this runner does the mechanics.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ffprobeDuration, fmtTimestamp } from './lib/util.mjs';
import { normalize, pngToClip, concat, speedUp } from './lib/ffmpeg.mjs';
import { recordBrowserSegment } from './lib/browser.mjs';
import { recordEvidenceSegment } from './lib/evidence.mjs';
import { titleCardHtml, renderHtmlToPng } from './lib/render.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const storyboardPath = process.argv[2];
if (!storyboardPath || !existsSync(storyboardPath)) {
  console.error('Usage: node record.mjs <storyboard.json> [--out <runDir>]');
  process.exit(2);
}

const sb = JSON.parse(readFileSync(storyboardPath, 'utf8'));

// Legacy migration: the old `terminal` segment recorded a real PTY (VHS) and
// TYPED commands on camera — useless as human evidence and unusable for a public
// walkthrough. It is replaced by `evidence`, which shows only the captured
// RESULT (a file / API response / log / output) as a clean still, no typing. Map
// any old terminal segment onto an evidence segment so committed storyboards keep
// working, and warn so they get rewritten.
const toMs = (v, def) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const m = /([\d.]+)\s*(ms|s)?/.exec(v); if (m) return m[2] === 's' ? +m[1] * 1000 : +m[1]; }
  return def;
};
for (const seg of sb.segments || []) {
  if (seg.type !== 'terminal') continue;
  console.error(`[record] DEPRECATED: terminal segment "${seg.id}" → auto-migrated to an evidence panel (no on-camera terminal). Rewrite it as {"type":"evidence", ...}; see references/storyboard-schema.md.`);
  seg.type = 'evidence';
  if (seg.mode === 'live-tail') {
    seg.hold = toMs(seg.duration, 9000);
  } else {
    if ((seg.commands || []).length) seg.command = seg.commands.join(' && ');
    seg.hold = toMs(seg.hold, 4500);
  }
  // live-tail keeps its logFile (the evidence reader tails it); scripted has none.
  delete seg.mode; delete seg.commands; delete seg.commandPause;
  delete seg.duration; delete seg.activity; delete seg.activityStop;
}

// Hard gate: test runs are NEVER proof and must never appear on camera. A
// walkthrough demonstrates real behavior (drive the UI, curl the live API, read
// the real log) — an evidence panel that runs a test suite is refused outright.
const TEST_CMD_RE = new RegExp([
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\S*`,
  String.raw`\bnpx\s+(?:vitest|jest|mocha|ava|cypress)\b`,
  String.raw`\b(?:vitest|jest|mocha|ava|pytest|tox|rspec|phpunit|ctest)\b`,
  String.raw`\bgo\s+test\b`,
  String.raw`\bcargo\s+test\b`,
  String.raw`\bplaywright\s+test\b`,
  String.raw`\bcypress\s+(?:run|open)\b`,
  String.raw`\b(?:mvn|gradle|\.?/?gradlew)\s+\S*test\S*`,
  String.raw`\bmake\s+test\b`,
].join('|'), 'i');
for (const seg of sb.segments || []) {
  if (seg.type !== 'evidence') continue;
  if (seg.command && TEST_CMD_RE.test(seg.command)) {
    console.error(`[record] REFUSED: evidence segment "${seg.id}" runs a test command: ${seg.command.trim()}`);
    console.error('[record] Test output is not proof of implementation. Show real behavior instead: the actual API response, the real record in a file, or the live server log.');
    process.exit(2);
  }
}

// Validate session-continuity: a `continue` browser segment reuses the session
// the previous segment left open, so it cannot be first and needs an earlier
// browser segment to have opened one.
for (let i = 0; i < (sb.segments || []).length; i++) {
  const seg = sb.segments[i];
  if (seg.type === 'browser' && seg.continue) {
    const priorBrowser = sb.segments.slice(0, i).some((s) => s.type === 'browser');
    if (!priorBrowser) {
      console.error(`[record] REFUSED: browser segment "${seg.id}" has continue:true but no earlier browser segment opened a session to continue.`);
      process.exit(2);
    }
  }
}
// The next browser segment in play order (titles/terminals don't touch the
// Playwright browser, so the session survives across them).
const nextBrowserSeg = (i) => {
  for (let k = i + 1; k < sb.segments.length; k++) if (sb.segments[k].type === 'browser') return sb.segments[k];
  return null;
};

const video = { width: 1280, height: 800, fps: 30, ...(sb.video || {}) };
const calibrationMs = sb.calibrationMs ?? 0;
const project = sb.project || 'project';
// Optional folder layer so a project's videos organize by feature/topic instead
// of a flat pile of timestamps: runs/<project>/<folder>/<timestamp>/. Sanitised
// to a safe path segment; nested folders allowed via "/" (each part sanitised).
const folder = (sb.folder || '')
  .split('/')
  .map((s) => s.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, ''))
  .filter(Boolean)
  .join('/');

// Atomically claim a unique run dir. fmtTimestamp is second-resolution, so two
// runs of the SAME project started in the same second would otherwise land on
// the same path — clobbering each other's output AND (since the playwright
// daemon id is derived from workDir) re-sharing one browser namespace. mkdir of
// the leaf is atomic: the first run wins the clean name, a colliding run gets
// EEXIST and takes `-2`, `-3`, … No collision (different second/project, the
// common case) keeps the clean timestamp name. Skipped when --out is explicit
// (the caller owns uniqueness then).
function uniqueRunRoot(base) {
  mkdirSync(path.dirname(base), { recursive: true });
  for (let n = 0; ; n++) {
    const cand = n === 0 ? base : `${base}-${n + 1}`;
    try { mkdirSync(cand); return cand; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

const explicitOut = arg('--out', null);
const runRoot = explicitOut || uniqueRunRoot(
  path.join(os.homedir(), '.walkthrough', 'runs', project, ...(folder ? [folder] : []), fmtTimestamp(new Date())));
const workDir = path.join(runRoot, 'work');
mkdirSync(workDir, { recursive: true });
mkdirSync(path.join(runRoot, 'frames'), { recursive: true });

const log = (m) => console.log(`[record] ${m}`);

// ---- Phase 1: record browser/terminal segments (these decide the flag) -------
const ctx = { workDir, video, barHeight: 110 };
const slots = []; // { index, clip?, deferred?, beats:[], results:[] }

for (let i = 0; i < sb.segments.length; i++) {
  const seg = sb.segments[i];
  if (seg.type === 'browser') {
    const nb = nextBrowserSeg(i);
    const keepOpen = !!(nb && nb.continue);
    const speed = (typeof seg.speed === 'number' && seg.speed > 1) ? seg.speed : 1;
    log(`browser segment "${seg.id}" (${(seg.beats || []).length} beats${seg.continue ? ', continue' : ''}${speed > 1 ? `, ${speed}x` : ''}${keepOpen ? ', keep-open' : ''})`);
    const { raw, offsets, results, warnings } = await recordBrowserSegment(seg, ctx, { keepOpen });
    for (const w of (warnings || [])) log(`${seg.id}: ${w}`);
    let clip = path.join(workDir, `clip-${i}-${seg.id}.mp4`);
    const nr = await normalize(raw, clip, video);
    if (nr.code !== 0) throw new Error(`normalize ${seg.id} failed: ${nr.stderr}`);
    if (speed > 1) {
      // Timelapse the whole (honest, real-time) recording. Measured offsets are
      // scaled by the same factor below so the manifest stays accurate.
      const fast = path.join(workDir, `clip-${i}-${seg.id}.fast.mp4`);
      const sr = await speedUp(clip, fast, speed, { fps: video.fps });
      if (sr.code !== 0) throw new Error(`speedUp ${seg.id} failed: ${sr.stderr}`);
      clip = fast;
    }
    const offMap = new Map(offsets.map((o) => [o.id, o.offsetMs]));
    const beats = (seg.beats || []).map((b) => {
      const off = offMap.get(b.id);
      return {
        id: b.id,
        caption: b.caption || '',
        expectedScreen: b.expectedScreen || '',
        expectFailure: !!b.expectFailure,
        _offsetMs: off == null ? null : off / speed,
      };
    });
    slots.push({ index: i, clip, beats, results });
  } else if (seg.type === 'evidence') {
    log(`evidence segment "${seg.id}" (${seg.file ? 'file' : seg.command ? 'command' : seg.logFile ? 'log' : 'text'})`);
    // Content is captured OFF-camera; the panel is a clean still (no PTY, no
    // typing). Render it, then loop the PNG for the hold duration like a title.
    const { png, result } = await recordEvidenceSegment(seg, ctx);
    const clip = path.join(workDir, `clip-${i}-${seg.id}.mp4`);
    const durSec = Math.max(2.5, (seg.hold ?? 4500) / 1000);
    const cr = await pngToClip(png, clip, { ...video, duration: durSec });
    if (cr.code !== 0) throw new Error(`evidence clip ${seg.id} failed: ${cr.stderr}`);
    slots.push({
      index: i, clip,
      beats: [{ id: seg.id, caption: seg.caption || '', expectedScreen: seg.expectedScreen || '', expectFailure: !!seg.expectFailure, _whole: true, _posFrac: 0.5 }],
      results: [result],
    });
  } else if (seg.type === 'title') {
    // Defer: the intro card may need to reflect the run-wide failure flag.
    slots.push({ index: i, deferred: seg, beats: [], results: [] });
  } else {
    throw new Error(`unknown segment type: ${seg.type}`);
  }
}

// ---- run-wide honesty flag --------------------------------------------------
const allResults = slots.flatMap((s) => s.results);
const flagged = allResults.some((r) => !r.ok);
const unexpectedFailures = allResults.filter((r) => !r.ok && !r.expectFailure);

// ---- Phase 2: render deferred title cards (now that `flagged` is known) ------
for (const slot of slots) {
  if (!slot.deferred) continue;
  const seg = slot.deferred;
  const useFlag = !!seg.reflectFlag && flagged;
  const png = await renderHtmlToPng(
    titleCardHtml(seg.text || '', seg.subtitle || '', { ...video, flag: useFlag }),
    { workDir, width: video.width, height: video.height, name: `title-${slot.index}-${seg.id}` });
  const clip = path.join(workDir, `clip-${slot.index}-${seg.id}.mp4`);
  const cr = await pngToClip(png, clip, { ...video, duration: seg.duration || 2.6 });
  if (cr.code !== 0) throw new Error(`title clip ${seg.id} failed: ${cr.stderr}`);
  slot.clip = clip;
  slot.beats = [{ id: seg.id, caption: seg.text || '', expectedScreen: seg.expectedScreen || `title card reading "${seg.text}"`, expectFailure: false, _whole: true, _posFrac: 0.5 }];
}

// ---- measure durations & build the MEASURED manifest ------------------------
slots.sort((a, b) => a.index - b.index);
let cursor = 0;
const manifestBeats = [];
for (const slot of slots) {
  const dur = await ffprobeDuration(slot.clip);
  const segStart = cursor;
  const segEnd = cursor + dur;
  // intra-segment offsets for browser beats; whole-clip for title/terminal
  const browserOffsets = slot.beats.filter((b) => b._offsetMs != null).map((b) => b._offsetMs);
  for (let j = 0; j < slot.beats.length; j++) {
    const b = slot.beats[j];
    let tStart, tEnd;
    if (b._whole || b._offsetMs == null) {
      tStart = segStart; tEnd = segEnd;
      const tPos = segStart + dur * (b._posFrac ?? 0.5);
      manifestBeats.push({
        id: b.id, segId: path.basename(slot.clip),
        caption: b.caption, expectedScreen: b.expectedScreen, expectFailure: b.expectFailure,
        tStart: +tStart.toFixed(3), tMid: +tPos.toFixed(3), tEnd: +tEnd.toFixed(3),
      });
      continue;
    } else {
      tStart = segStart + b._offsetMs / 1000;
      const next = browserOffsets.find((o) => o > b._offsetMs);
      tEnd = next != null ? segStart + next / 1000 : segEnd;
    }
    // Sample inside the result-hold window (right after the caption+highlight go
    // up), not at the geometric midpoint — which can land in the NEXT beat's
    // action phase, after the highlight has already faded.
    const tMid = Math.min(segEnd - 0.05, Math.max(segStart, tStart + Math.min((tEnd - tStart) / 2, 1.4) + calibrationMs / 1000));
    manifestBeats.push({
      id: b.id, segId: path.basename(slot.clip),
      caption: b.caption, expectedScreen: b.expectedScreen, expectFailure: b.expectFailure,
      tStart: +tStart.toFixed(3), tMid: +tMid.toFixed(3), tEnd: +tEnd.toFixed(3),
    });
  }
  cursor = segEnd;
}

// ---- stitch -----------------------------------------------------------------
const finalMp4 = path.join(runRoot, 'final.mp4');
const cr = await concat(slots.map((s) => s.clip), path.join(workDir, 'concat.txt'), finalMp4);
if (cr.code !== 0) throw new Error(`concat failed: ${cr.stderr}`);
const totalDur = await ffprobeDuration(finalMp4);

// ---- write artifacts --------------------------------------------------------
const manifest = {
  project, folder: folder || null, title: sb.title || '', createdAt: new Date().toISOString(),
  video, duration: +totalDur.toFixed(3), calibrationMs,
  flagged, beats: manifestBeats,
};
writeFileSync(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
copyFileSync(storyboardPath, path.join(runRoot, 'storyboard.json'));
writeFileSync(path.join(runRoot, 'pass-record.json'), JSON.stringify({
  verifiedAt: null, // filled by the verifier after vision check
  flagged, unexpectedFailures, results: allResults, beats: manifestBeats,
}, null, 2));

console.log(JSON.stringify({
  ok: true, runDir: runRoot, final: finalMp4, duration: +totalDur.toFixed(3),
  beats: manifestBeats.length, flagged, unexpectedFailures: unexpectedFailures.length,
}, null, 2));

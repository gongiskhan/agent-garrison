#!/usr/bin/env node
// discover.mjs — find recent Claude Code sessions worth mining for skill feedback.
//
// Emits candidates.json: sessions that (A) invoked a skill, and/or (B) contain a
// user message that references a known skill or reads like corrective feedback.
// These are TWO INDEPENDENT streams: feedback about a skill often lands in a
// session that never ran it (e.g. a follow-up the next day), so we never require
// the two to co-occur. This is a cheap pre-filter; the nightly agent does the
// real judgement on the sessions surfaced here.
//
// Usage: node discover.mjs [--hours 24] [--projects <dir>] [--out <file>]
//        [--skills-dir <dir>]
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const HOURS = parseFloat(arg('--hours', '24'));
const PROJECTS = arg('--projects', path.join(os.homedir(), '.claude', 'projects'));
const SKILLS_DIR = arg('--skills-dir', path.join(os.homedir(), '.claude', 'skills'));
const OUT = arg('--out', path.join(os.homedir(), '.claude', 'skill-improver', 'state', 'candidates.json'));
const SINCE = Date.now() - HOURS * 3600 * 1000;

// ---- known skill names (user skills + their real homes) ---------------------
function knownSkills() {
  const map = {}; // name -> { home, isSymlink }
  if (!existsSync(SKILLS_DIR)) return map;
  for (const name of readdirSync(SKILLS_DIR)) {
    const p = path.join(SKILLS_DIR, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue; // skips loose files like SKILL_CONTRACT.md
    let home = p, isSymlink = false;
    try { home = realpathSync(p); isSymlink = (home !== p); } catch {}
    map[name] = { home, isSymlink };
  }
  return map;
}

// corrective-feedback cues (lowercased substring match) — deliberately broad;
// the nightly agent filters false positives. Better to over-surface than miss.
const CUES = [
  'flacky', 'flaky', 'broken', "doesn't work", 'does not work', 'not working',
  'still fails', 'failing', 'wrong', 'should have', "shouldn't", 'should not',
  'missed', 'did not', "didn't", 'instead of', 'bug', 'annoying', 'confusing',
  'highlight', 'too slow', 'hangs', 'incorrect', 'not what i', 'fix the', 'improve the',
];

// redact secrets at WRITE time — candidates.json sits on disk, so don't persist raw tokens
const redact = (s) => s
  .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]')
  .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]')
  .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]')
  .replace(/xox[bp]-[A-Za-z0-9-]{8,}/g, 'xox-[REDACTED]');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  return '';
}

function scanSession(file, skills) {
  const skillNames = Object.keys(skills);
  let used = new Set();       // stream A: skills invoked
  const feedback = [];        // stream B: user msgs referencing a skill or cueing correction
  let cwd = null;             // build repo, so the improver can find e.g. autothing friction-logs
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.cwd) cwd = ev.cwd;
    const msg = ev.message;
    // Stream A — Skill tool_use + slash-command markers
    const blocks = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (b && b.type === 'tool_use' && b.name === 'Skill' && b.input && b.input.skill) used.add(String(b.input.skill));
    }
    const anyText = textOf(msg && msg.content);
    const cmd = anyText.match(/<command-name>\/([a-z0-9:-]+)<\/command-name>/gi);
    if (cmd) for (const m of cmd) { const n = m.replace(/<\/?command-name>/gi, '').replace(/^\//, ''); if (skills[n]) used.add(n); }
    // Stream B — genuine USER-TYPED messages only. The discriminator: real typed
    // prompts carry a `promptSource`; injected skill bodies set `isMeta:true`;
    // command echoes/task-notifications/compiler prompts have neither — so we
    // require promptSource and reject isMeta. This is what kills the noise.
    if (msg && msg.role === 'user' && ev.type === 'user' && ev.promptSource && !ev.isMeta) {
      const isToolResult = blocks.some((b) => b && b.type === 'tool_result');
      if (isToolResult) continue;
      const t = textOf(msg.content).trim();
      if (!t || t.includes('<command-name>')) continue;
      // drop messages that are wholly a system/tool wrapper, not human prose
      if (/^<(system-reminder|task-notification|local-command|command-message|user-prompt-submit-hook)/.test(t) || t.includes('[Interrupted')) continue;
      const lt = t.toLowerCase();
      const named = skillNames.filter((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t));
      const cued = CUES.some((c) => lt.includes(c));
      if (named.length || (cued && used.size)) {
        feedback.push({ refersTo: named, cued, snippet: redact(t.slice(0, 400)) });
      }
    }
  }
  return { used: [...used], feedback, cwd };
}

function listJsonl(dir) {
  const out = [];
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p));
    else if (e.name.endsWith('.jsonl')) { try { if (statSync(p).mtimeMs >= SINCE) out.push(p); } catch {} }
  }
  return out;
}

const skills = knownSkills();
const files = listJsonl(PROJECTS);
const candidates = [];
for (const f of files) {
  const r = scanSession(f, skills);
  if (!r) continue;
  if (r.used.includes('skill-improver')) continue; // never mine our own nightly runs (self-reference loop)
  const referenced = [...new Set(r.feedback.flatMap((fb) => fb.refersTo))];
  if (r.used.length === 0 && r.feedback.length === 0) continue; // pre-filter
  candidates.push({
    sessionId: path.basename(f, '.jsonl'),
    file: f,
    cwd: r.cwd,
    mtime: new Date(statSync(f).mtimeMs).toISOString(),
    skillsUsed: r.used,
    skillsReferencedInFeedback: referenced,
    feedbackCount: r.feedback.length,
    feedback: r.feedback,
  });
}
candidates.sort((a, b) => (b.mtime).localeCompare(a.mtime));

const report = {
  scannedAt: new Date().toISOString(),
  windowHours: HOURS,
  filesScanned: files.length,
  knownSkills: Object.fromEntries(Object.entries(skills).map(([n, v]) => [n, { home: v.home, isSymlink: v.isSymlink }])),
  candidateCount: candidates.length,
  candidates,
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  ok: true, out: OUT, filesScanned: files.length, candidateCount: candidates.length,
  candidates: candidates.map((c) => ({ sessionId: c.sessionId, skillsUsed: c.skillsUsed, refs: c.skillsReferencedInFeedback, fb: c.feedbackCount })),
}, null, 2));

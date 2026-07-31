#!/usr/bin/env node
// snapshot.mjs — the revert net for skill edits. Skills live in mixed homes
// (real dirs in ~/.claude, symlinks to non-git external dirs, plugins), so we do
// NOT rely on git for revertibility. Before ANY edit, snapshot the REAL file into
// the improver's own store; revert restores it byte-for-byte. This is what makes
// "auto-apply all" safe regardless of where the skill lives.
//
//   node snapshot.mjs backup <file> [--label "<why>"]   → snapshot + print revert cmd
//   node snapshot.mjs revert <backupFile>               → restore original
//   node snapshot.mjs list [--date YYYY-MM-DD]          → list snapshots
//
// HARD RULE for callers: if `backup` does not print ok:true, DO NOT edit the file
// — there is no revert path, so an auto-applied change could not be undone.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, readdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.claude', 'skill-improver', 'backups');
const cmd = process.argv[2];
const arg = (n) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : null; };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const today = () => new Date().toISOString().slice(0, 10);

function backup(file) {
  if (!file || !existsSync(file)) { console.log(JSON.stringify({ ok: false, error: `no such file: ${file}` })); process.exit(1); }
  const real = realpathSync(file); // follow symlinks → back up the REAL file
  const dir = path.join(ROOT, today());
  mkdirSync(dir, { recursive: true });
  const safe = real.replace(/[/\\]/g, '__').replace(/^__/, '');
  const dest = path.join(dir, `${safe}.${stamp()}.bak`);
  copyFileSync(real, dest);
  const rec = { ts: new Date().toISOString(), original: real, requested: file, backup: dest, sha: sha(real), label: arg('--label') || '' };
  appendFileSync(path.join(dir, 'manifest.jsonl'), JSON.stringify(rec) + '\n');
  console.log(JSON.stringify({ ok: true, ...rec, revert: `node ${process.argv[1]} revert "${dest}"` }, null, 2));
}

function revert(bak) {
  if (!bak || !existsSync(bak)) { console.log(JSON.stringify({ ok: false, error: `no such backup: ${bak}` })); process.exit(1); }
  // find the manifest record to learn the original path
  const dir = path.dirname(bak);
  let original = null;
  try {
    for (const line of readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue; const r = JSON.parse(line); if (r.backup === bak) original = r.original;
    }
  } catch {}
  if (!original) { console.log(JSON.stringify({ ok: false, error: 'original path not found in manifest' })); process.exit(1); }
  copyFileSync(bak, original);
  console.log(JSON.stringify({ ok: true, restored: original, from: bak }, null, 2));
}

function list() {
  const date = arg('--date') || today();
  const dir = path.join(ROOT, date);
  if (!existsSync(dir)) { console.log(JSON.stringify({ ok: true, date, snapshots: [] })); return; }
  const snaps = [];
  try { for (const line of readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8').split('\n')) { if (line.trim()) snaps.push(JSON.parse(line)); } } catch {}
  console.log(JSON.stringify({ ok: true, date, count: snaps.length, snapshots: snaps }, null, 2));
}

if (cmd === 'backup') backup(process.argv[3]);
else if (cmd === 'revert') revert(process.argv[3]);
else if (cmd === 'list') list();
else { console.log('usage: snapshot.mjs <backup|revert|list> ...'); process.exit(2); }

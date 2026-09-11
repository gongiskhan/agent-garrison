#!/usr/bin/env node
// Restores into a fresh temporary directory, boots only the restored state
// service, compares counts through the live API, and retains a bounded report.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createStateClient } from '../packages/garrison-state-client/index.mjs';
import { listConversations } from '../packages/claude-pty/src/conversation-store.mjs';

export const TOLERANCES = Object.freeze({
  cards: 5, // Permit at most five cards created after the snapshot.
  cardDocs: 20, // Permit at most twenty new card documents since the snapshot.
  conversations: 5, // Permit at most five new ledgers per node since the snapshot.
  maxAgeHours: 30 // Daily backups must remain within one day plus six hours.
});
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'services/state');
const SCRIPTS = path.join(ROOT, 'fittings/seed/snapshots-default/scripts');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const homeFor = env => env.GARRISON_HOME || path.join(env.HOME || os.homedir(), '.garrison');
const age = (at, now) => (now - new Date(at).getTime()) / 3600000;

function execute(command, args, { env, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    const force = setTimeout(() => child.kill('SIGKILL'), timeout + 3000);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-8000); });
    child.on('error', error => { clearTimeout(timer); clearTimeout(force); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(force);
      if (code !== 0 || timedOut) reject(new Error(`${path.basename(command)} ${args[0] || ''}: ${timedOut ? 'timed out' : `exit ${code}`} ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}
async function restic(args, env) {
  // Arguments remain positional; no caller values are interpolated into code.
  return execute('bash', ['-c', '. "$1"; shift; exec restic "$@"', 'restore-drill', path.join(SCRIPTS, 'env.sh'), ...args], { env, timeout: 30 * 60000 });
}
export function countConversations(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'log.jsonl'))).length;
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
function meshCounts(dir) {
  try { return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => [d.name, countConversations(path.join(dir, d.name))])); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export async function liveCounts(env = process.env) {
  const garrison = homeFor(env);
  const client = createStateClient({ env: { ...env, GARRISON_HOME: garrison }, readFileSync: fs.readFileSync });
  const stats = await client.request('GET', '/v1/stats');
  let shared = null;
  try { shared = readJson(path.join(garrison, 'user-composition/shared-state.json')).byRuntime; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { cards: stats.cards, cardDocs: stats.cardDocs, conversations: listConversations({ ...env, GARRISON_HOME: garrison }).filter(c => c.mtime !== null).length, meshConversations: meshCounts(path.join(garrison, 'mesh-conversations')), shared };
}
async function bootState(dbPath, tmp, env) {
  const child = spawn(process.execPath, [path.join(STATE, 'src/server.mjs')], {
    env: { ...env, HOME: tmp, GARRISON_HOME: path.join(tmp, '.garrison'), GARRISON_CLAUDE_HOME: path.join(tmp, '.claude'), GARRISON_STATE_HOME: tmp, GARRISON_STATE_DB: dbPath, GARRISON_STATE_PORT: '0', GARRISON_STATE_BIND: '127.0.0.1', GARRISON_STATE_MASTER_KEY_HEX: randomBytes(32).toString('hex'), GARRISON_STATE_URL: '', GARRISON_STATE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('restored state service did not start within 15s')), 15000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`restored state service exited ${code}: ${output.slice(-1500)}`)); });
      const collect = data => {
        output += data;
        const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
    });
    const response = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || !(await response.json()).ok) throw new Error('restored state service health failed');
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
}
export function markdownReport(report) {
  const s = report.state, r = report.restic;
  return [
    '# Restore drill', '', `Last run: ${report.at} · ${report.ok ? 'ok' : 'failed'}`,
    `Cards ${s.restored?.cards ?? '?'} (live ${s.live?.cards ?? '?'}) · Card docs ${s.restored?.cardDocs ?? '?'} (live ${s.live?.cardDocs ?? '?'}) · Conversations ${r.conversations?.restored ?? '?'} (live ${r.conversations?.live ?? '?'})`,
    `State snapshot ${s.ageHours?.toFixed(1) ?? '?'}h old · Restic snapshot ${r.ageHours?.toFixed(1) ?? '?'}h old`,
    `State service: ${report.boot.stateService}`, '',
    ...report.lines.map(line => `- ${line}`),
    ...(report.failures.length ? ['', 'Failures:', ...report.failures.map(f => `- ${f}`)] : []), ''
  ].join('\n');
}
export async function runDrill({ env = process.env, log = console.log, notify = false } = {}) {
  const now = Date.now(), garrison = homeFor(env);
  const stateHome = env.GARRISON_STATE_HOME || path.join(env.HOME || os.homedir(), '.garrison-state');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'garrison-restore-drill-'));
  const report = { at: new Date(now).toISOString(), ok: false, state: {}, restic: {}, boot: { stateService: 'not run' }, tolerances: TOLERANCES, failures: [], lines: [] };
  const line = text => { report.lines.push(text); log(text); };
  const fail = text => { report.failures.push(text); line(`FAILED: ${text}`); };
  let restoredDb;
  try {
    try {
      const backups = path.join(stateHome, 'backups');
      const name = fs.readdirSync(backups).filter(n => /^garrison-daily-\d{4}-.*\.db$/.test(n)).sort().at(-1);
      if (!name) throw new Error('no daily state snapshot found');
      const source = path.join(backups, name);
      const stamp = name.match(/^garrison-daily-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/);
      report.state = { snapshot: name, ageHours: age(stamp ? `${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z` : fs.statSync(source).mtime, now) };
      const verified = JSON.parse(await execute(process.execPath, [path.join(STATE, 'scripts/verify-restore.mjs'), source], { env }));
      Object.assign(report.state, { schemaVersion: verified.schemaVersion, integrity: verified.integrity, restored: { cards: verified.counts.cards, cardDocs: verified.counts.card_docs } });
      if (verified.integrity !== 'ok') throw new Error(`integrity: ${verified.integrity}`);
      restoredDb = path.join(tmp, 'garrison.db');
      fs.copyFileSync(source, restoredDb);
      line(`Verified state snapshot ${name}: schema ${verified.schemaVersion}, integrity ${verified.integrity}`);
    } catch (error) { fail(`state snapshot: ${error.message}`); }
    try {
      const destination = path.join(tmp, 'restored');
      let snapshot;
      if (env.RESTIC_RESTORE_OVERRIDE) {
        // Fixture metadata carries a real time; stale fixture backups still fail.
        snapshot = readJson(path.join(env.RESTIC_RESTORE_OVERRIDE, 'snapshot.json'));
        fs.cpSync(env.RESTIC_RESTORE_OVERRIDE, destination, { recursive: true });
      } else {
        const snapshots = JSON.parse(await restic(['snapshots', '--json', '--host', os.hostname()], env));
        snapshot = snapshots.filter(s => s.paths?.some(p => path.resolve(p) === path.resolve(garrison))).sort((a, b) => new Date(a.time) - new Date(b.time)).at(-1);
        if (!snapshot) throw new Error('no restic snapshot for this node and Garrison home');
        await restic(['restore', snapshot.id, '--target', destination, ...['conversations', 'mesh-conversations', 'kanban-loop'].flatMap(p => ['--include', path.join(garrison, p)])], env);
      }
      const restoredHome = path.join(destination, path.resolve(garrison).slice(path.parse(path.resolve(garrison)).root.length));
      report.restic = { snapshotId: snapshot.id, ageHours: age(snapshot.time, now), conversations: { restored: countConversations(path.join(restoredHome, 'conversations')) }, meshConversations: meshCounts(path.join(restoredHome, 'mesh-conversations')) };
      line(`Restored restic snapshot ${snapshot.id}: ${report.restic.conversations.restored} conversations`);
    } catch (error) { fail(`restic restore: ${error.message}`); }
    try {
      const live = await liveCounts(env);
      report.state.live = { cards: live.cards, cardDocs: live.cardDocs };
      report.restic.conversations = { ...report.restic.conversations, live: live.conversations };
      report.restic.meshLive = live.meshConversations;
      report.state.delta = {};
      for (const key of ['cards', 'cardDocs']) {
        const restored = report.state.restored?.[key];
        if (!Number.isInteger(restored) || !Number.isInteger(live[key])) { fail(`${key}: missing count`); continue; }
        report.state.delta[key] = restored - live[key];
        if (live[key] - restored > TOLERANCES[key]) fail(`${key}: live minus restored ${live[key] - restored} exceeds tolerance ${TOLERANCES[key]}`);
      }
      const restored = report.restic.conversations.restored;
      if (!Number.isInteger(restored)) fail('conversations: missing restored count');
      else if (live.conversations - restored > TOLERANCES.conversations) fail(`conversations: live minus restored ${live.conversations - restored} exceeds tolerance ${TOLERANCES.conversations}`);
      for (const [node, count] of Object.entries(live.meshConversations)) {
        const delta = count - (report.restic.meshConversations?.[node] ?? 0);
        if (delta > TOLERANCES.conversations) fail(`mesh conversations ${node}: live minus restored ${delta} exceeds tolerance ${TOLERANCES.conversations}`);
      }
      line(`Compared live counts: ${live.cards} cards, ${live.cardDocs} card docs, ${live.conversations} conversations`);
    } catch (error) { fail(`live comparison: ${error.message}`); }
    for (const key of ['state', 'restic']) {
      const hours = report[key].ageHours;
      if (!Number.isFinite(hours)) fail(`${key}: snapshot age unavailable`);
      else if (hours > TOLERANCES.maxAgeHours) fail(`${key}: snapshot age ${hours.toFixed(1)}h exceeds ${TOLERANCES.maxAgeHours}h`);
    }
    if (restoredDb) {
      try { await bootState(restoredDb, tmp, env); report.boot.stateService = 'ok'; line('Booted restored state service on an ephemeral loopback port; /v1/health ok; stopped it'); }
      catch (error) { report.boot.stateService = 'failed'; fail(`boot check: ${error.message}`); }
    } else fail('boot check: no verified state snapshot');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  report.ok = report.failures.length === 0;
  const dir = path.join(garrison, 'snapshots');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = () => {
    for (const [name, body] of [['restore-drill.json', JSON.stringify(report, null, 2) + '\n'], ['restore-drill.md', markdownReport(report)]]) {
      const temporary = path.join(dir, `.${name}.${process.pid}`);
      fs.writeFileSync(temporary, body, { mode: 0o600 }); fs.renameSync(temporary, path.join(dir, name));
    }
  };
  line(`Restore drill ${report.ok ? 'ok' : 'failed'}; report: ${path.join(dir, 'restore-drill.json')}`);
  write();
  if (notify) {
    try {
      const client = createStateClient({ env: { ...env, GARRISON_HOME: garrison }, readFileSync: fs.readFileSync });
      const title = report.ok ? `Restore drill ok: ${report.state.restored.cards} cards, ${report.restic.conversations.restored} conversations` : `Restore drill failed on ${client.node || 'dev-madrid'}`;
      const body = markdownReport(report);
      const notification = await client.createNotification({ kind: 'system', body: { title, body, href: '/fitting/snapshots-default' } });
      // Core Improver's durable notice list is the existing shell notice UI.
      // The state notification table has no browser consumer of its own.
      await client.putConfig(`improver.notice.${notification.id}`, 'global', { id: notification.id, title, text: body, at: report.at, link: '/fitting/snapshots-default', source: 'restore-drill' }, { ifMatchRev: 0 });
      log('Posted restore drill notification and shell notice');
    } catch (error) { fail(`notification: ${error.message}`); report.ok = false; write(); }
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--counts-only')) liveCounts().then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; });
  else runDrill({ notify: process.argv.includes('--notify') }).then(r => { process.exitCode = r.ok ? 0 : 1; }).catch(e => { console.error(e.message); process.exitCode = 1; });
}

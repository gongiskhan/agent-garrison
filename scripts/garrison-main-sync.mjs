#!/usr/bin/env node
// An OS-owned, bounded main catch-up job. It never runs beneath a Conversation.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { checkDeployment } from './garrison-deployment-guard.mjs';
import { localConversationActivity, processExists } from '../packages/claude-pty/src/deployment-guard.mjs';

const script = fileURLToPath(import.meta.url);
const repo = path.dirname(path.dirname(script));
const home = process.env.GARRISON_HOME || path.join(os.homedir(), '.garrison');
const receipt = path.join(home, 'main-sync.json');
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 }).trim();
const save = (data) => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(`${receipt}.tmp`, JSON.stringify({ ...read(receipt), ...data, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(`${receipt}.tmp`, receipt);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function needsRuntimeDeployment(files) {
  return files.some((file) => file && !/^(docs\/|tests\/|ios\/|\.codex\/|\.claude\/|\.agents\/)/.test(file)
    // These commands read their current source when invoked; no running app
    // or fitting holds them. Catch-up must not interrupt voice for their edits.
    && !/^scripts\/(garrison-main-sync\.mjs$|garrison-redeploy\.sh$|remote-shell\/node-supervisor\.sh$|spike\/)/.test(file)
    && !/\.md$/.test(file) && file !== 'roadmap.json');
}

function appUrl() {
  const env = execFileSync('bash', ['scripts/garrison-instance.sh', 'node', 'env'], { cwd: repo, encoding: 'utf8', timeout: 10_000 });
  const port = /^GARRISON_APP_PORT=(\d+)$/m.exec(env)?.[1];
  if (!port) throw new Error('No node app port in the instance profile');
  return `http://127.0.0.1:${port}`;
}

export async function recordDeployment(head, app, destinationHome = home) {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('A full deployment commit is required');
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch(`${app}/api/mesh/self`, { signal: AbortSignal.timeout(5000) });
      const self = await response.json();
      if (response.ok && self.composition?.running && !self.degraded && self.views?.total > 0 && self.views.healthy === self.views.total) {
        const file = path.join(destinationHome, 'main-sync.json');
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...read(file), deployedHead: head, status: 'healthy', at: new Date().toISOString() }, null, 2), { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
        return;
      }
    } catch { /* readiness is asynchronous after up */ }
    await pause(2000);
  }
  throw new Error('Deployment did not reach a running composition with all views healthy');
}

async function syncMain() {
  if (!fs.existsSync(path.join(home, 'node.json'))) return;
  if (process.env.GARRISON_CONVERSATION_ID || localConversationActivity({ ...process.env, GARRISON_HOME: home }).length) {
    save({ status: 'deferred', reason: 'working Conversation' }); return;
  }
  if (git('branch', '--show-current') !== 'main') { save({ status: 'deferred', reason: 'checkout must use main' }); return; }
  if (git('status', '--porcelain')) { save({ status: 'deferred', reason: 'uncommitted work' }); return; }
  git('fetch', '--quiet', 'origin', 'main');
  const oldHead = git('rev-parse', 'HEAD');
  const upstream = git('rev-parse', 'origin/main');
  try { git('merge-base', '--is-ancestor', oldHead, upstream); }
  catch { save({ status: 'needs-attention', reason: 'main has unpublished or divergent commits; integrate without resetting' }); return; }
  const app = appUrl();
  // Includes in-flight quick replies and proof of another healthy node.
  await checkDeployment({ env: { ...process.env, GARRISON_HOME: home }, app });
  // Recheck after asynchronous probes. Git itself refuses conflicting changes.
  if (git('status', '--porcelain') || localConversationActivity({ ...process.env, GARRISON_HOME: home }).length) return;
  if (oldHead !== upstream) git('merge', '--ff-only', 'origin/main');
  const head = git('rev-parse', 'HEAD');
  const previous = read(receipt);
  if (previous.deployedHead === head) return;
  if (previous.deployedHead) {
    const files = git('diff', '--name-only', previous.deployedHead, head).split('\n');
    if (!needsRuntimeDeployment(files)) { save({ deployedHead: head, status: 'healthy' }); return; }
  }
  if (previous.attemptedHead === head && Date.now() - Number(previous.attemptedAt) < 10 * 60_000) return;
  save({ attemptedHead: head, attemptedAt: Date.now(), status: 'deploying' });
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'node:redeploy'], { cwd: repo, env: { ...process.env, GARRISON_HOME: home }, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (exitCode !== 0) { save({ status: 'deferred', reason: `guarded deployment exited ${exitCode}`, ...(exitCode === 75 ? { attemptedAt: 0 } : {}) }); return; }
  // The redeploy script records the revision only after live acceptance.
}

const xml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const workerPid = path.join(home, 'main-sync-worker.pid');
function ensureWorker() {
  if (processExists(Number(read(workerPid).pid))) return;
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  const log = fs.openSync(path.join(home, 'logs/main-sync.log'), 'a', 0o600);
  try {
    execFileSync('flock', ['--version'], { stdio: 'ignore' });
    const child = spawn('flock', ['--nonblock', `${workerPid}.lock`, process.execPath, script, 'serve'], {
      cwd: repo, detached: true, stdio: ['ignore', log, log], env: { ...process.env, GARRISON_MAIN_SYNC_WORKER: '1' }
    });
    child.unref();
  } finally { fs.closeSync(log); }
}
async function serve() {
  // flock owns exclusion across concurrent tether recoveries and automatically
  // releases on exit/reboot. The PID file is an observation, never the lock.
  if (process.env.GARRISON_MAIN_SYNC_WORKER !== '1') throw new Error('Start the synchronization worker through daemon');
  fs.writeFileSync(workerPid, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const cleanup = () => { if (read(workerPid).pid === process.pid) fs.unlinkSync(workerPid); };
  process.once('exit', cleanup);
  process.once('SIGTERM', () => process.exit(0));
  process.once('SIGINT', () => process.exit(0));
  // Leave initial enrollment/recovery time to finish before the first check.
  while (true) {
    await pause(60_000);
    try { await syncMain(); }
    catch (error) { save({ status: 'deferred', reason: error.message }); }
  }
}
async function install() {
  if (!fs.existsSync(path.join(home, 'node.json'))) throw new Error('Only an enrolled node may install main synchronization');
  const nodePath = path.dirname(process.execPath);
  const envPath = `${nodePath}:${process.env.PATH || '/usr/bin:/bin'}`;
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  if (process.platform === 'darwin') {
    const label = 'io.garrison.main-sync';
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const text = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string></array><key>WorkingDirectory</key><string>${xml(repo)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string><key>GARRISON_HOME</key><string>${xml(home)}</string></dict><key>StartInterval</key><integer>60</integer><key>StandardOutPath</key><string>${xml(path.join(home, 'logs/main-sync.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(home, 'logs/main-sync.log'))}</string></dict></plist>`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); } catch {}
    fs.writeFileSync(file, text, { mode: 0o600 });
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
  } else {
    let systemd = false;
    try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }); systemd = true; } catch {}
    if (!systemd) {
      if (!fs.existsSync(path.join(home, 'node-supervisor.sh'))) throw new Error('Main synchronization needs an installed node supervisor');
      ensureWorker();
      console.log('Main synchronization installed under the tether recovery supervisor.');
      return;
    }
    const dir = path.join(os.homedir(), '.config/systemd/user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'garrison-main-sync.service'), `[Unit]\nDescription=Garrison main synchronization\n[Service]\nType=oneshot\nWorkingDirectory=${repo}\nEnvironment="PATH=${envPath}"\nEnvironment="GARRISON_HOME=${home}"\nExecStart=${process.execPath} ${script}\nTimeoutStartSec=30min\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'garrison-main-sync.timer'), '[Unit]\nDescription=Keep Garrison main synchronized\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=60s\nRandomizedDelaySec=20s\n[Install]\nWantedBy=timers.target\n', { mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', 'garrison-main-sync.timer']);
  }
  console.log('Main synchronization installed: idle nodes catch up automatically; restarts use the mesh guard.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'install') await install();
    else if (mode === 'daemon') ensureWorker();
    else if (mode === 'serve') await serve();
    else if (mode === 'record') await recordDeployment(...args);
    else await syncMain();
  } catch (error) { save({ status: 'deferred', reason: error.message }); console.error(error.message); process.exitCode = 1; }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const base = path.join(os.homedir(), '.garrison', 'cursor-probe');
const hooksFile = path.join(os.homedir(), '.cursor', 'hooks.json');
const marker = 'garrison-cursor-phase0-20260911';
const events = ['sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'preToolUse', 'afterAgentResponse', 'afterAgentThought', 'afterShellExecution', 'afterMCPExecution', 'afterFileEdit', 'postToolUse', 'stop'];
const mode = process.argv[2];
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const read = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const record = (data) => fs.appendFileSync(path.join(base, 'events.jsonl'), JSON.stringify({ at: Date.now(), pid: process.pid, platform: process.platform, ...data }) + '\n', { mode: 0o600 });
const allowed = (event, scratch = false) => {
  if (!scratch) return {};
  if (event === 'beforeSubmitPrompt') return { continue: true };
  if (['beforeReadFile', 'beforeShellExecution', 'beforeMCPExecution', 'preToolUse'].includes(event)) return { permission: 'allow' };
  return {};
};
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

if (mode === 'install') {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(hooksFile);
  const raw = existed ? fs.readFileSync(hooksFile, 'utf8') : null;
  const config = raw === null ? { version: 1, hooks: {} } : JSON.parse(raw);
  if (config.version !== 1 || !config.hooks || Array.isArray(config.hooks)) throw new Error('Unsupported user hooks configuration');
  if (!fs.existsSync(path.join(base, 'before.json'))) write(path.join(base, 'before.json'), { existed, raw });
  const script = path.join(base, 'probe.mjs');
  fs.copyFileSync(process.argv[1], script);
  fs.chmodSync(script, 0o700);
  for (const event of events) {
    const list = config.hooks[event] ?? [];
    if (!Array.isArray(list)) throw new Error('Unsupported hook event shape');
    config.hooks[event] = [...list.filter(h => h?._garrison !== marker), { command: `${quote(process.execPath)} ${quote(script)} hook`, _garrison: marker, failClosed: false, timeout: event === 'stop' ? 30000 : 2, ...(event === 'stop' ? { loop_limit: null } : {}) }];
  }
  for (const name of ['alpha', 'beta']) {
    const root = path.join(base, 'scratch', name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'probe.txt'), `Garrison scratch ${name}. Synthetic test data only.\n`);
  }
  write(path.join(base, 'probe.code-workspace'), { folders: ['alpha', 'beta'].map(name => ({ path: path.join(base, 'scratch', name) })), settings: {} });
  write(hooksFile, config);
  console.log(JSON.stringify({ installed: true, base, workspace: path.join(base, 'probe.code-workspace'), preservedEntries: Object.values(config.hooks).flat().filter(h => h?._garrison !== marker).length }));
} else if (mode === 'uninstall') {
  const current = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const before = read(path.join(base, 'before.json'));
  const original = before.raw === null ? { version: 1, hooks: {} } : JSON.parse(before.raw);
  for (const event of Object.keys(current.hooks)) {
    current.hooks[event] = current.hooks[event].filter(h => h?._garrison !== marker);
    if (!current.hooks[event].length && !Object.hasOwn(original.hooks, event)) delete current.hooks[event];
  }
  const restored = JSON.stringify(current) === JSON.stringify(original);
  if (restored && before.existed) fs.writeFileSync(hooksFile, before.raw);
  else if (restored && !before.existed) fs.unlinkSync(hooksFile);
  else write(hooksFile, current);
  console.log(JSON.stringify({ removed: true, originalPreserved: restored }));
} else if (mode === 'hook') {
  let done = false;
  let event = '';
  let payload;
  const finish = (response = {}, reason = 'returned') => {
    if (done) return;
    done = true;
    try { if (payload) record({ kind: 'return', event, conversation_id: payload.conversation_id, reason, response }); } catch {}
    process.stdout.write(JSON.stringify(response) + '\n', () => process.exit(0));
  };
  process.on('SIGTERM', () => finish({}, 'SIGTERM'));
  process.on('SIGINT', () => finish({}, 'SIGINT'));
  process.on('uncaughtException', error => {
    try { record({ kind: 'probe_error', code: error.code ?? error.name }); } catch {}
    finish({}, 'probe_error');
  });
  process.on('unhandledRejection', () => finish({}, 'probe_error'));
  const watchdog = setTimeout(() => finish(allowed(event), 'input_timeout'), 1500);
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 4 * 1024 * 1024) finish(allowed(event), 'input_limit'); });
  process.stdin.on('end', () => {
    try {
      payload = JSON.parse(input);
      event = payload.hook_event_name;
      const scratchRoots = ['alpha', 'beta'].map(name => path.join(base, 'scratch', name));
      const scratch = Array.isArray(payload.workspace_roots) && payload.workspace_roots.some(root => scratchRoots.includes(root));
      const id = payload.conversation_id;
      if (!scratch || !/^[a-zA-Z0-9_-]{1,200}$/.test(id ?? '')) { payload = null; return finish(allowed(event)); }
      record({ kind: 'payload', payload, cwd: process.cwd() });
      clearTimeout(watchdog);
      const planFile = path.join(base, `${id}.json`);
      if (event === 'beforeSubmitPrompt') {
        const match = /Garrison probe hold=(\d+)/.exec(payload.prompt ?? '');
        if (match) write(planFile, { seconds: Math.min(28800, Number(match[1])), followup: /followup=yes/.test(payload.prompt) });
      }
      if (event !== 'stop' || payload.status !== 'completed') return finish(allowed(event, true));
      const plan = read(planFile);
      if (!plan.seconds) return finish();
      write(planFile, {});
      const nonce = randomUUID();
      record({ kind: 'hold', conversation_id: id, seconds: plan.seconds, nonce });
      setTimeout(() => finish(plan.followup ? { followup_message: 'Garrison probe followup. Reply with the single word acknowledged.' } : {}, 'deadline'), plan.seconds * 1000);
    } catch (error) {
      try { record({ kind: 'probe_error', code: error.code ?? error.name }); } catch {}
      finish(allowed(event), 'probe_error');
    }
  });
} else if (mode === 'report') {
  const rows = fs.existsSync(path.join(base, 'events.jsonl')) ? fs.readFileSync(path.join(base, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  console.log(JSON.stringify(rows.map(row => row.kind === 'payload' ? { at: row.at, event: row.payload.hook_event_name, id: row.payload.conversation_id, generation: row.payload.generation_id, fields: Object.keys(row.payload), prompt: row.payload.prompt, text: row.payload.text, status: row.payload.status, roots: row.payload.workspace_roots, transcript: row.payload.transcript_path, platform: row.platform, cwd: row.cwd } : row), null, 2));
}

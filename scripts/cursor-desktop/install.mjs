import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CURSOR_DEFAULTS } from '../../packages/talk/src/cursor/store.mjs';
import { readCursorToken } from '../../packages/talk/src/cursor/http.mjs';

export const CURSOR_HOOK_MARKER = 'garrison-cursor-desktop-v1';
export const CURSOR_HOOK_EVENTS = ['sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution', 'afterFileEdit', 'stop'];
const here = path.dirname(fileURLToPath(import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function atomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, data, { mode, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
function loadHooks(file) {
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, hooks: {} };
  if (config.version !== 1 || !config.hooks || Array.isArray(config.hooks) || typeof config.hooks !== 'object') throw new Error('Unsupported user hooks configuration');
  for (const entries of Object.values(config.hooks)) if (!Array.isArray(entries)) throw new Error('Unsupported user hook entries');
  return config;
}

export function installCursorHooks({ userHome = os.homedir(), home = path.join(userHome, '.garrison'), nodeId, nodeUrl, nodeBinary = process.execPath, settings = {} }) {
  const target = new URL(nodeUrl);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || !['/', '/api', '/api/'].includes(target.pathname) || target.search || target.hash) throw new Error('Cursor node URL must be loopback HTTP');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(nodeId ?? '')) throw new Error('Invalid Cursor node identity');
  const token = readCursorToken(path.join(home, 'internal-token'));
  const file = path.join(userHome, '.cursor', 'hooks.json');
  const config = loadHooks(file);
  const script = path.join(home, 'bin', 'cursor-hook.mjs');
  const envFile = path.join(userHome, '.garrison', 'cursor-hook.env');
  atomic(script, fs.readFileSync(path.join(here, 'hook.mjs')), 0o700);
  atomic(envFile, `GARRISON_CURSOR_URL=${target.origin}${target.pathname === '/' ? '' : '/api'}\nGARRISON_CURSOR_NODE_ID=${nodeId}\nGARRISON_CURSOR_TOKEN=${token}\n`);
  for (const event of CURSOR_HOOK_EVENTS) {
    config.hooks[event] = [...(config.hooks[event] ?? []).filter(entry => entry?._garrison !== CURSOR_HOOK_MARKER), {
      command: `${quote(nodeBinary)} ${quote(script)} ${event === 'stop' ? 'stop' : 'event'}`,
      _garrison: CURSOR_HOOK_MARKER, timeout: event === 'stop' ? 30000 : 2, failClosed: false,
      ...(event === 'stop' ? { loop_limit: null } : {}),
    }];
  }
  const settingsFile = path.join(home, 'cursor', 'settings.json');
  const previous = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  atomic(settingsFile, JSON.stringify({ ...CURSOR_DEFAULTS, ...previous, ...settings }, null, 2) + '\n');
  atomic(file, JSON.stringify(config, null, 2) + '\n');
  return { installed: true, hooks: file, script, envFile, preservedEntries: Object.values(config.hooks).flat().filter(entry => entry?._garrison !== CURSOR_HOOK_MARKER).length };
}

export function uninstallCursorHooks({ userHome = os.homedir(), home = path.join(userHome, '.garrison') } = {}) {
  const file = path.join(userHome, '.cursor', 'hooks.json');
  if (fs.existsSync(file)) {
    const config = loadHooks(file);
    for (const event of Object.keys(config.hooks)) {
      const entries = config.hooks[event];
      const kept = entries.filter(entry => entry?._garrison !== CURSOR_HOOK_MARKER);
      if (kept.length !== entries.length) {
        if (kept.length) config.hooks[event] = kept;
        else delete config.hooks[event];
      }
    }
    atomic(file, JSON.stringify(config, null, 2) + '\n');
  }
  for (const owned of [path.join(home, 'bin', 'cursor-hook.mjs'), path.join(userHome, '.garrison', 'cursor-hook.env')]) {
    try { fs.unlinkSync(owned); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { removed: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.env.GARRISON_HOME ?? path.join(os.homedir(), '.garrison');
  if (process.argv[2] === 'uninstall') console.log(JSON.stringify(uninstallCursorHooks({ home })));
  else if (process.argv[2] === 'install') {
    const node = JSON.parse(fs.readFileSync(path.join(home, 'node.json'), 'utf8'));
    const nodeUrl = process.env.GARRISON_CURSOR_NODE_URL;
    if (!nodeUrl) throw new Error('Set GARRISON_CURSOR_NODE_URL to the existing localhost app API');
    console.log(JSON.stringify(installCursorHooks({ home, nodeId: node.id ?? node.name, nodeUrl })));
  } else throw new Error('Use install or uninstall');
}

#!/usr/bin/env node
// Explicit user sharing installs only runtime primitives. Vault enrollment and
// scheduler duties belong to the Garrison setup pass and must not run twice.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { install as installArchiveGuard } from './archive-guard.mjs';

const runtimes = new Set((process.env.GARRISON_SHARE_RUNTIMES || '').split(',').filter(Boolean));
const bm = process.env.BASIC_MEMORY_BIN || 'basic-memory';
const backend = process.env.BASIC_MEMORY_BACKEND || 'local';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function selectSharedSkill() {
  if (!runtimes.has('claude-code') || backend === 'local') return;
  const home = process.env.GARRISON_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const ref = 'skills/garrison-memory/SKILL.md', file = path.join(home, ref);
  const bytes = await fs.readFile(file);
  const root = await fs.realpath(home), parent = await fs.realpath(path.dirname(file));
  if ((await fs.lstat(file)).isSymbolicLink() || !parent.startsWith(root + path.sep)) throw new Error('Shared memory skill escapes its home');
  const provenance = process.env.GARRISON_USER_PROVENANCE;
  const ledger = provenance ? JSON.parse(await fs.readFile(provenance, 'utf8')) : {};
  const owner = ledger[`file:claude-code:${ref}`];
  if (owner?.fittingId !== 'basic-memory' || hash(bytes) !== owner.lastWrittenHash?.replace(/^sha256:/, '')) throw new Error('Shared memory variant requires an unchanged Garrison-owned skill; your file was left untouched');
  const variant = await fs.readFile(new URL('../skill-variants/cortex/SKILL.md', import.meta.url));
  if (bytes.equals(variant)) return;
  const temp = `${file}.garrison-${randomUUID()}`;
  try {
    await fs.writeFile(temp, variant, { mode: (await fs.stat(file)).mode & 0o777, flag: 'wx' });
    if (!(await fs.readFile(file)).equals(bytes)) throw new Error('Shared memory skill changed; retry');
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
await selectSharedSkill();
async function addJsonMcp(file) {
  let bytes = null;
  try { bytes = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes !== null && (await fs.lstat(file)).isSymbolicLink()) throw new Error(`Sharing refuses a symlinked config file: ${file}`);
  const root = bytes === null ? {} : JSON.parse(bytes);
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error(`Invalid config object: ${file}`);
  if (root.mcpServers && (typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers))) throw new Error(`Invalid MCP config: ${file}`);
  root.mcpServers ??= {};
  // An existing registration is the user's unless the separate ownership
  // reconciler says otherwise. Never overwrite it merely because names match.
  if (Object.hasOwn(root.mcpServers, 'basic-memory')) return;
  root.mcpServers['basic-memory'] = { command: bm, args: ['mcp'] };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.garrison-${randomUUID()}`;
  const mode = bytes === null ? 0o600 : (await fs.stat(file)).mode & 0o777;
  try {
    await fs.writeFile(temp, JSON.stringify(root, null, 2) + '\n', { mode, flag: 'wx' });
    const current = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current !== bytes) throw new Error(`Config changed while sharing Basic Memory: ${file}`);
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
if (backend !== 'local') {
  console.log('[basic-memory-setup] shared remote backend uses its skill; no local MCP registration added');
} else {
  if (runtimes.has('claude-code')) await addJsonMcp(process.env.GARRISON_CLAUDE_JSON || path.join(process.env.GARRISON_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.claude.json'));
  if (runtimes.has('gemini')) await addJsonMcp(path.join(process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini'), 'settings.json'));
  if (runtimes.has('codex')) {
    const existing = spawnSync('codex', ['mcp', 'get', 'basic-memory'], { env: process.env, encoding: 'utf8' });
    if (existing.error) throw existing.error;
    if (existing.status !== 0) {
      const added = spawnSync('codex', ['mcp', 'add', 'basic-memory', '--', bm, 'mcp'], { env: process.env, encoding: 'utf8' });
      if (added.error || added.status !== 0) throw new Error(`Could not share Basic Memory with Codex: ${added.error?.message || added.stderr}`);
    }
  }
  console.log(`[basic-memory-setup] shared runtime registrations: ${[...runtimes].join(', ')}`);
}

if (runtimes.has('claude-code')) {
  const home = process.env.GARRISON_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settings = process.env.GARRISON_CLAUDE_SETTINGS_PATH || path.join(home, 'settings.json');
  const state = process.env.GARRISON_HOME || path.join(os.homedir(), '.garrison');
  const vault = (process.env.BASIC_MEMORY_VAULT_DIR || '~/ObsidianVault').replace(/^~(?=\/|$)/, os.homedir());
  installArchiveGuard(settings, vault, state, fileURLToPath(new URL('./archive-guard.mjs', import.meta.url)));
}

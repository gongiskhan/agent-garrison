// The actual CLI normalizes settings and drops unknown hook owner tags.
// Verify shared ownership and cleanup against that rewrite in a temporary home.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
async function main() {
  const root = process.env.TWO_HOMES_SANDBOX;
  if (!root || !(await fs.realpath(root)).startsWith(await fs.realpath(os.tmpdir()) + path.sep)) throw new Error('A temporary home is required');
  const gh = path.join(root, '.garrison-dev');
  for (const key of Object.keys(process.env)) if (key.startsWith('GARRISON_') || ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME'].includes(key)) delete process.env[key];
  Object.assign(process.env, { HOME: root, GARRISON_HOME: gh, GARRISON_CLAUDE_HOME: path.join(gh, 'runtime-homes/claude'), GARRISON_ASSUME_INSTALLED: '1', BASIC_MEMORY_CONFIG_DIR: path.join(gh, 'basic-memory'), BASIC_MEMORY_HOME: path.join(gh, 'basic-memory/default') });
  const { getUserQuartersState } = await import('../../src/lib/quarters-user');
  const { checkHomeLeaks } = await import('../../src/lib/home-leaks');
  const sharedHooks = async () => (await getUserQuartersState('claude-code')).rows.filter(row => row.kind === 'hook' && row.sharedOwner === 'basic-memory');
  const before = await sharedHooks();
  if (before.length !== 1) throw new Error('Shared hook missing before CLI normalization');
  const result = await promisify(execFile)('claude', ['mcp', 'list'], { cwd: root, env: process.env, timeout: 120000 });
  if (!result.stdout.includes('basic-memory') || !result.stdout.includes('Connected')) throw new Error('Shared Basic Memory did not connect');
  const after = await sharedHooks();
  const leaks = await checkHomeLeaks();
  if (after.length !== before.length || !leaks.ok) throw new Error('CLI normalization lost shared ownership');
  const receipt = { at: new Date().toISOString(), ok: true, sharedHooksBefore: before.length, sharedHooksAfter: after.length, basicMemory: 'Connected', leaks: leaks.leaks.length };
  await fs.writeFile(path.join(root, 'cli-acceptance.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

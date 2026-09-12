import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const script = path.resolve('scripts/cursor-desktop/probe.mjs');
const homes: string[] = [];
const setup = () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cursor-probe-test-'));
  homes.push(home);
  mkdirSync(path.join(home, '.cursor'));
  const original = '{\n  "version": 1, "hooks": { "stop": [{ "command": "foreign-hook", "failClosed": true }], "beforeSubmitPrompt": [{ "command": "foreign-prompt-hook", "timeout": 4 }] }, "extra": { "keep": true }\n}\n';
  writeFileSync(path.join(home, '.cursor/hooks.json'), original);
  const env = { ...process.env, HOME: home };
  const install = spawnSync(process.execPath, [script, 'install'], { env, encoding: 'utf8' });
  expect(install.status, install.stderr).toBe(0);
  return { home, env, original, base: path.join(home, '.garrison/cursor-probe') };
};
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true }); });

describe('temporary Cursor desktop measurement probe', () => {
  it('installs idempotently and removes only its entries, restoring the original bytes', () => {
    const { home, env, original } = setup();
    const file = path.join(home, '.cursor/hooks.json');
    const once = readFileSync(file, 'utf8');
    expect(spawnSync(process.execPath, [script, 'install'], { env }).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(once);
    const current = JSON.parse(once);
    expect(current.hooks.stop[0]).toEqual({ command: 'foreign-hook', failClosed: true });
    expect(current.hooks.beforeSubmitPrompt[0]).toEqual({ command: 'foreign-prompt-hook', timeout: 4 });
    expect(spawnSync(process.execPath, [script, 'uninstall'], { env }).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('preserves foreign changes made after installation', () => {
    const { home, env } = setup();
    const file = path.join(home, '.cursor/hooks.json');
    const current = JSON.parse(readFileSync(file, 'utf8'));
    current.hooks.stop.push({ command: 'new-foreign-hook' });
    writeFileSync(file, JSON.stringify(current));
    expect(spawnSync(process.execPath, [script, 'uninstall'], { env }).status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.stop).toEqual([
      { command: 'foreign-hook', failClosed: true }, { command: 'new-foreign-hook' }
    ]);
  });

  it.each(['beforeSubmitPrompt', 'beforeShellExecution', 'beforeReadFile', 'stop'])('returns no permission decision for non-scratch %s', event => {
    const { env, home } = setup();
    const start = Date.now();
    const run = spawnSync(process.execPath, [script, 'hook'], { env, encoding: 'utf8', timeout: 2000,
      input: JSON.stringify({ conversation_id: 'foreign-chat', hook_event_name: event, workspace_roots: ['/client/repo'], status: 'completed' }) });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('{}\n');
    expect(Date.now() - start).toBeLessThan(2000);
    expect(() => readFileSync(path.join(home, '.garrison/cursor-probe/events.jsonl'))).toThrow();
  });

  it('fails open on malformed payloads', () => {
    const { env } = setup();
    const run = spawnSync(process.execPath, [script, 'hook'], { env, encoding: 'utf8', timeout: 2000, input: '{bad' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('{}\n');
  });

  it.each(['beforeSubmitPrompt', 'beforeReadFile', 'beforeShellExecution', 'beforeMCPExecution', 'preToolUse'])('uses the documented allow response only for scratch %s', event => {
    const { env, base } = setup();
    const run = spawnSync(process.execPath, [script, 'hook'], { env, encoding: 'utf8', timeout: 2000,
      input: JSON.stringify({ conversation_id: 'scratch-chat', hook_event_name: event, workspace_roots: [path.join(base, 'scratch/alpha')] }) });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(event === 'beforeSubmitPrompt' ? { continue: true } : { permission: 'allow' });
  });

  it('does not capture a different workspace sharing the scratch path prefix', () => {
    const { env, base } = setup();
    const run = spawnSync(process.execPath, [script, 'hook'], { env, encoding: 'utf8', input: JSON.stringify({
      conversation_id: 'other-chat', hook_event_name: 'beforeSubmitPrompt',
      workspace_roots: [path.join(base, 'scratch/alpha-other')], prompt: 'private input'
    }) });
    expect(run.stdout).toBe('{}\n');
    expect(() => readFileSync(path.join(base, 'events.jsonl'))).toThrow();
  });

  it('returns a followup only after the configured scratch deadline', () => {
    const { env, base } = setup();
    writeFileSync(path.join(base, 'scratch-chat.json'), JSON.stringify({ seconds: 0.08, followup: true }));
    const run = spawnSync(process.execPath, [script, 'hook'], { env, encoding: 'utf8', timeout: 2000, input: JSON.stringify({
      conversation_id: 'scratch-chat', hook_event_name: 'stop', status: 'completed', workspace_roots: [path.join(base, 'scratch/alpha')]
    }) });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ followup_message: 'Garrison probe followup. Reply with the single word acknowledged.' });
    const records = readFileSync(path.join(base, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.find(r => r.reason === 'deadline').at - records.find(r => r.kind === 'hold').at).toBeGreaterThanOrEqual(70);
  });

  it('returns exactly one empty object when a held scratch hook receives SIGTERM', async () => {
    const { env, base } = setup();
    writeFileSync(path.join(base, 'scratch-chat.json'), JSON.stringify({ seconds: 100 }));
    const child = spawn(process.execPath, [script, 'hook'], { env });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const closed = new Promise(resolve => child.on('close', resolve));
    child.stdin.end(JSON.stringify({ conversation_id: 'scratch-chat', generation_id: 'turn-one', hook_event_name: 'stop', status: 'completed', workspace_roots: [path.join(base, 'scratch/alpha')] }));
    await new Promise(resolve => setTimeout(resolve, 250));
    child.kill('SIGTERM');
    expect(await closed).toBe(0);
    expect(output).toBe('{}\n');
    const records = readFileSync(path.join(base, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.filter(record => record.kind === 'hold')).toHaveLength(1);
    expect(records.filter(record => record.reason === 'SIGTERM'), JSON.stringify(records)).toHaveLength(1);
  });
});

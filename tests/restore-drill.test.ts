import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { startStateService } from "./state-service-harness";
let service: Awaited<ReturnType<typeof startStateService>>;
let home: string;
let env: NodeJS.ProcessEnv;
const root = path.resolve(__dirname, '..');
function command(script: string, args: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function put(file: string, text = '') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function id(i: number) { return `01RESTOREFIXTURE${String(i).padStart(11, '0')}`; }
async function card(i: number) { await service.client.createCard({ id: id(i), list: 'todo', title: `Fixture ${i}` }); }
function report() { return JSON.parse(fs.readFileSync(`${home}/.garrison/snapshots/restore-drill.json`, 'utf8')); }
beforeEach(async () => {
  service = await startStateService({ nodes: ['dev-madrid'] });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-fixture-'));
  env = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, GARRISON_HOME: `${home}/.garrison`, GARRISON_CLAUDE_HOME: `${home}/.claude`, GARRISON_STATE_HOME: `${home}/.garrison-state`, GARRISON_STATE_DB: service.dbPath, GARRISON_STATE_URL: service.url, GARRISON_STATE_TOKEN: service.token, GARRISON_NODE_NAME: 'dev-madrid', RESTIC_RESTORE_OVERRIDE: `${home}/restic` };
  for (let i = 0; i < 3; i++) { await card(i); await service.client.putCardDoc(id(i), 'brief.md', 'Synthetic brief'); }
  put(`${home}/.garrison/conversations/chat-one/log.jsonl`);
  put(`${home}/.garrison/mesh-conversations/mac-mini/chat-peer/log.jsonl`);
  fs.mkdirSync(`${home}/restic`, { recursive: true });
  fs.cpSync(`${home}/.garrison`, path.join(`${home}/restic`, home.slice(1), '.garrison'), { recursive: true });
  put(`${home}/restic/snapshot.json`, JSON.stringify({ id: 'fixture-restic', time: new Date().toISOString() }));
  const snapshot = await command('services/state/scripts/backup.mjs', ['--daily']);
  expect(snapshot.code, snapshot.stderr).toBe(0);
});
afterEach(async () => { await service.stop(); fs.rmSync(home, { recursive: true, force: true }); });
it('verifies and boots the restored DB, matches ledgers, writes both reports and notifies', async () => {
  const run = await command('scripts/restore-drill.mjs', ['--notify']);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  expect(report()).toMatchObject({ ok: true, state: { integrity: 'ok', restored: { cards: 3, cardDocs: 3 }, live: { cards: 3, cardDocs: 3 }, delta: { cards: 0, cardDocs: 0 } }, restic: { snapshotId: 'fixture-restic', conversations: { restored: 1, live: 1 }, meshConversations: { 'mac-mini': 1 } }, boot: { stateService: 'ok' }, tolerances: { cards: 5, cardDocs: 20, conversations: 5, maxAgeHours: 30 }, failures: [] });
  expect(fs.readFileSync(`${home}/.garrison/snapshots/restore-drill.md`, 'utf8')).toContain('Cards 3 (live 3)');
  const notifications = await service.client.pendingNotifications();
  expect(notifications.at(-1)?.body.title).toBe('Restore drill ok: 3 cards, 1 conversations');
  expect(notifications.at(-1)?.body.body).toBe(fs.readFileSync(`${home}/.garrison/snapshots/restore-drill.md`, 'utf8'));
  expect((await service.client.getConfig(`improver.notice.${notifications.at(-1)?.id}`, 'global'))?.body.source).toBe('restore-drill');
  const counts = await command('scripts/restore-drill.mjs', ['--counts-only']);
  expect(counts.code).toBe(0);
  expect(JSON.parse(counts.stdout)).toMatchObject({ cards: 3, cardDocs: 3, conversations: 1, shared: null });
});
it('fails beyond the card tolerance without widening it', async () => {
  for (let i = 3; i < 9; i++) await card(i);
  const run = await command('scripts/restore-drill.mjs');
  expect(run.code, run.stdout + run.stderr).toBe(1);
  expect(report().failures).toContain('cards: live minus restored 6 exceeds tolerance 5');
  expect(report().boot.stateService).toBe('ok');
});
it('fails stale backups and missing peer ledgers', async () => {
  put(`${home}/restic/snapshot.json`, JSON.stringify({ id: 'fixture-restic', time: new Date(Date.now() - 31 * 3600000).toISOString() }));
  for (let i = 0; i < 6; i++) put(`${home}/.garrison/mesh-conversations/mac-mini/new-${i}/log.jsonl`);
  expect((await command('scripts/restore-drill.mjs')).code).toBe(1);
  expect(report().failures).toContain('mesh conversations mac-mini: live minus restored 6 exceeds tolerance 5');
  expect(report().failures.some((f: string) => f.startsWith('restic: snapshot age 31.0h exceeds 30h'))).toBe(true);
});
it('counts only undeleted cards and allows the restored count to exceed live', async () => {
  const current = await service.client.getCard(id(0));
  await service.client.deleteCard(id(0), { ifMatchRev: current.rev });
  const stats = await service.client.request('GET', '/v1/stats');
  expect(stats).toEqual({ cards: 2, cardDocs: 3, sessions: 0, nodes: 1 });
  expect((await fetch(`${service.url}/v1/stats`)).status).toBe(401);
  expect((await command('scripts/restore-drill.mjs')).code).toBe(0);
  expect(report().state.delta.cards).toBe(1);
});

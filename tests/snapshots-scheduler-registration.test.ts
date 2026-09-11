import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
let home: string;
let env: NodeJS.ProcessEnv;
const scripts = path.resolve("fittings/seed/snapshots-default/scripts");
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-schedule-"));
  fs.mkdirSync(`${home}/bin`);
  fs.writeFileSync(`${home}/bin/restic`, '#!/bin/sh\necho "restic fixture"\n', { mode: 0o755 });
  fs.writeFileSync(`${home}/bin/systemctl`, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  env = { NODE_ENV: "test", HOME: home, PATH: `${home}/bin:${process.env.PATH}`, GARRISON_HOME: `${home}/.garrison`, GARRISON_CLAUDE_HOME: `${home}/.claude`, GARRISON_NODE_NAME: 'dev-madrid', GARRISON_STATE_HOME: `${home}/.garrison-state`, GARRISON_SCHEDULER_JOBS: `${home}/jobs.json`, SNAPSHOTS_PEERS_JSON: JSON.stringify([{ name: 'mac-mini', sshTarget: 'fixture@mac-mini' }]) };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
it.each([false, true])('registers portable jobs and one local scheduling path (systemd %s)', (systemd) => {
  if (systemd) env.XDG_RUNTIME_DIR = `${home}/runtime`;
  const result = spawnSync('bash', [`${scripts}/setup.sh`], { env, encoding: 'utf8' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const jobs = JSON.parse(fs.readFileSync(`${home}/jobs.json`, 'utf8'));
  expect(jobs).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'snapshots.backup', cron: '0 3 * * *', target: 'all', enabled: !systemd }),
    expect.objectContaining({ id: 'snapshots.prune', cron: '0 4 * * 0', target: 'all', enabled: !systemd }),
    expect.objectContaining({ id: 'snapshots.state-ship', cron: '20 3 * * *', target: 'node:dev-madrid', enabled: false }),
    expect.objectContaining({ id: 'snapshots.restore-drill', cron: '0 5 * * 1', target: 'node:dev-madrid' }),
    expect.objectContaining({ id: 'snapshots.mesh-pull.mac-mini', cron: '40 3 * * *', target: 'node:dev-madrid' })
  ]));
  expect(jobs.every((j: any) => j.spec.kind === 'fitting-script')).toBe(true);
  expect(result.stdout).toContain('state DB is not shipped off-box: set state_ship_target');
  expect(JSON.parse(fs.readFileSync(`${home}/.garrison/snapshots/schedule.json`, 'utf8')).path).toBe(systemd ? 'systemd' : 'scheduler');
  jobs.find((j: any) => j.id === 'snapshots.restore-drill').enabled = false;
  fs.writeFileSync(`${home}/jobs.json`, JSON.stringify(jobs));
  expect(spawnSync('bash', [`${scripts}/setup.sh`], { env }).status).toBe(0);
  expect(JSON.parse(fs.readFileSync(`${home}/jobs.json`, 'utf8')).find((j: any) => j.id === 'snapshots.restore-drill').enabled).toBe(false);
  if (systemd) {
    const dispatch = spawnSync(process.execPath, [`${scripts}/scheduled.mjs`, 'backup'], { env, encoding: 'utf8' });
    expect(dispatch.status).toBe(0);
    expect(dispatch.stdout).toContain('skipped scheduler duplicate');
  }
});
it('enables configured state shipping initially and omits host-only jobs on peers', () => {
  env.SNAPSHOTS_DEFAULT_STATE_SHIP_TARGET = 'fixture@mac-pro';
  expect(spawnSync('bash', [`${scripts}/setup.sh`], { env }).status).toBe(0);
  expect(JSON.parse(fs.readFileSync(`${home}/jobs.json`, 'utf8')).find((j: any) => j.id === 'snapshots.state-ship').enabled).toBe(true);
  fs.unlinkSync(`${home}/jobs.json`);
  env.GARRISON_NODE_NAME = 'mac-mini';
  expect(spawnSync('bash', [`${scripts}/setup.sh`], { env }).status).toBe(0);
  expect(JSON.parse(fs.readFileSync(`${home}/jobs.json`, 'utf8')).map((j: any) => j.id)).toEqual(['snapshots.backup', 'snapshots.prune']);
});

it('keeps shared jobs enabled for Macs and publishes per-node timer receipts', async () => {
  const { startStateService } = await import('./state-service-harness');
  const service = await startStateService({ nodes: ['dev-madrid', 'mac-mini'] });
  try {
    const linux = { ...env, GARRISON_STATE_URL: service.url, GARRISON_STATE_TOKEN: service.tokens['dev-madrid'], XDG_RUNTIME_DIR: `${home}/runtime` };
    const first = spawnSync('bash', [`${scripts}/setup.sh`], { env: linux, encoding: 'utf8' });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const mac = { ...env, GARRISON_HOME: `${home}/mac/.garrison`, GARRISON_CLAUDE_HOME: `${home}/mac/.claude`, GARRISON_NODE_NAME: 'mac-mini', GARRISON_STATE_URL: service.url, GARRISON_STATE_TOKEN: service.tokens['mac-mini'] };
    const second = spawnSync('bash', [`${scripts}/setup.sh`], { env: mac, encoding: 'utf8' });
    expect(second.status, second.stdout + second.stderr).toBe(0);
    const jobs = await service.client.listSchedulerJobs();
    expect(jobs.find(j => j.id === 'snapshots.backup')).toMatchObject({ enabled: true, target: 'all', spec: { kind: 'fitting-script' } });
    const status = spawnSync(process.execPath, [`${scripts}/schedule-status.mjs`], { env: linux, encoding: 'utf8' });
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).nodes).toEqual(expect.arrayContaining([expect.objectContaining({ node: 'dev-madrid', path: 'systemd' }), expect.objectContaining({ node: 'mac-mini', path: 'scheduler' })]));
  } finally { await service.stop(); }
});

it('registers and reports when invoked through a symlinked fitting directory', () => {
  const linked = path.join(home, 'installed-scripts');
  fs.symlinkSync(scripts, linked, 'dir');
  const setup = spawnSync('bash', [path.join(linked, 'setup.sh')], { env, encoding: 'utf8' });
  expect(setup.status, setup.stderr).toBe(0);
  expect(setup.stdout).toContain('snapshots scheduling: scheduler');
  expect(JSON.parse(fs.readFileSync(`${home}/.garrison/snapshots/schedule.json`, 'utf8')).path).toBe('scheduler');
  const status = spawnSync(process.execPath, [path.join(linked, 'schedule-status.mjs')], { env, encoding: 'utf8' });
  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout).nodes).toEqual(expect.arrayContaining([expect.objectContaining({ node: 'dev-madrid', path: 'scheduler' })]));
});

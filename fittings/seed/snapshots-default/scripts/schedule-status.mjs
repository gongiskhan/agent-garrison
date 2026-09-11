import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobStore } from '../../scheduler/scripts/lib/job-store.mjs';
import { home, readSchedule } from './schedule.mjs';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export function localSchedulingStatus() {
  const schedule = readSchedule();
  if (!schedule) return { node: process.env.GARRISON_NODE_NAME || 'this node', path: 'unconfigured', backup: null, prune: null, jobs: [] };
  return { node: schedule.node, path: schedule.path, at: new Date().toISOString(), backup: read(path.join(home, 'snapshots/state.json')), prune: read(path.join(home, 'snapshots/prune.json')), jobs: schedule.jobs.map(j => ({ id: j.id, cron: j.cron, target: j.target, lastRun: read(path.join(home, 'snapshots/runs', `${j.id.replace(/^snapshots\./, '')}.json`)) })), warning: schedule.node === 'dev-madrid' && !schedule.stateShipTarget ? 'state DB is not shipped off-box: set state_ship_target' : null };
}
export async function publishSchedulingStatus() {
  const status = localSchedulingStatus();
  const store = createJobStore({ env: { ...process.env, GARRISON_HOME: home }, log: () => {}, timeoutMs: 5000 });
  if (!store.client) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prior = await store.client.getConfig('snapshots.schedule', `node:${status.node}`);
    try { await store.client.putConfig('snapshots.schedule', `node:${status.node}`, status, { ifMatchRev: prior?.rev ?? 0 }); return; }
    catch (error) { if (error.status !== 409 || attempt) throw error; }
  }
}
export async function schedulingStatus() {
  const local = localSchedulingStatus();
  const store = createJobStore({ env: { ...process.env, GARRISON_HOME: home }, log: () => {}, timeoutMs: 5000 });
  let nodes = [], error;
  if (store.client) {
    try {
      const refs = await store.client.listConfig('snapshots.schedule');
      nodes = (await Promise.all(refs.map(d => store.client.getConfig(d.namespace, d.scope)))).filter(Boolean).map(d => d.body);
    }
    catch (e) { error = e.message; }
  }
  return { nodes: [...nodes.filter(n => n?.node && n.node !== local.node), local], ...(error ? { error } : {}) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.includes('--publish') ? publishSchedulingStatus() : schedulingStatus().then(s => console.log(JSON.stringify(s)))).catch(e => { console.error(e.message); process.exitCode = 1; });
}

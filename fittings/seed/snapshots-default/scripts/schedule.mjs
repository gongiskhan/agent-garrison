// Portable scheduler entries: paths resolve on the executing node, never on
// the node which last registered a shared job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobStore } from '../../scheduler/scripts/lib/job-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const home = process.env.GARRISON_HOME || path.join(os.homedir(), '.garrison');
export const schedulePath = path.join(home, 'snapshots', 'schedule.json');
export function readSchedule() {
  try { return JSON.parse(fs.readFileSync(schedulePath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function repoRoot() {
  if (process.env.GARRISON_ROOT_DIR) return process.env.GARRISON_ROOT_DIR;
  let dir = fs.realpathSync(here);
  while (path.dirname(dir) !== dir) {
    if (fs.existsSync(path.join(dir, 'scripts/mesh-evidence-backup.sh'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('cannot locate Garrison checkout for snapshot jobs');
}
export async function registerSchedules({ systemd = false } = {}) {
  const store = createJobStore({ log: () => {} });
  const node = store.self || process.env.GARRISON_NODE_NAME || os.hostname();
  const stateHome = process.env.GARRISON_STATE_HOME || path.join(os.homedir(), '.garrison-state');
  const stateShipTarget = process.env.SNAPSHOTS_DEFAULT_STATE_SHIP_TARGET || process.env.GARRISON_SNAPSHOTSDEFAULT_STATE_SHIP_TARGET || process.env.SNAPSHOTS_STATE_SHIP_TARGET || '';
  const definitions = [
    { id: 'snapshots.backup', cron: '0 3 * * *', target: 'all', action: 'backup' },
    { id: 'snapshots.prune', cron: '0 4 * * 0', target: 'all', action: 'prune' }
  ];
  if (node === 'dev-madrid') {
    definitions.push(
      { id: 'snapshots.state-ship', cron: '20 3 * * *', target: 'node:dev-madrid', action: 'state-ship', disabled: !stateShipTarget },
      { id: 'snapshots.restore-drill', cron: '0 5 * * 1', target: 'node:dev-madrid', action: 'restore-drill' }
    );
    // Tests supply metadata only. Production uses the existing mesh registry.
    const peers = process.env.SNAPSHOTS_PEERS_JSON ? JSON.parse(process.env.SNAPSHOTS_PEERS_JSON) : store.client ? await store.client.listNodes() : [];
    for (const peer of peers.filter(p => p.name !== node)) {
      const target = peer.sshTarget || (peer.tailnetHost ? `${os.userInfo().username}@${peer.tailnetHost}` : peer.name);
      definitions.push({ id: `snapshots.mesh-pull.${peer.name}`, cron: '40 3 * * *', target: 'node:dev-madrid', action: 'mesh-pull', args: [target, peer.name] });
    }
  }
  for (const def of definitions) {
    const prior = await store.getJob(def.id);
    // A global enabled bit cannot encode different OS schedulers. Shared jobs
    // stay enabled and the local dispatcher skips systemd nodes. Standalone
    // registrations can use the requested disabled default directly.
    const disabled = def.disabled || (systemd && store.mode === 'file' && def.target === 'all');
    await store.saveJob(def.id, {
      id: def.id, cron: def.cron, target: def.target, type: 'cron',
      enabled: prior ? undefined : !disabled,
      spec: { kind: 'fitting-script', fitting: 'snapshots-default', script: 'scripts/scheduled.mjs', args: [def.action, ...(def.args || [])] },
      description: `Snapshots: ${def.action}`
    });
  }
  const receipt = { version: 1, at: new Date().toISOString(), node, path: systemd ? 'systemd' : 'scheduler', stateHome, stateShipTarget, repo: repoRoot(), jobs: definitions };
  fs.mkdirSync(path.dirname(schedulePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${schedulePath}.tmp`, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${schedulePath}.tmp`, schedulePath);
  console.log(`snapshots scheduling: ${receipt.path} (backup daily 03:00; prune Sunday 04:00)`);
  if (node === 'dev-madrid' && !stateShipTarget) console.log('state DB is not shipped off-box: set state_ship_target');
  return receipt;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  registerSchedules({ systemd: process.argv.includes('--systemd') }).catch(e => { console.error(e.message); process.exitCode = 1; });
}

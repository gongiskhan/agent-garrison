#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSchedule, home } from './schedule.mjs';
import { publishSchedulingStatus } from './schedule-status.mjs';

const receipt = readSchedule();
if (!receipt) throw new Error('Snapshots scheduling is not configured on this node; run its setup');
const action = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));
if (['backup', 'prune'].includes(action) && receipt.path === 'systemd') {
  console.log(`snapshots.${action}: systemd scheduling is active on ${receipt.node}; skipped scheduler duplicate`);
} else {
  const commands = {
    backup: ['bash', [path.join(here, 'backup.sh')]],
    prune: ['bash', [path.join(here, 'prune.sh')]],
    'state-ship': ['bash', [path.join(receipt.stateHome, 'current/scripts/ship-backup.sh'), receipt.stateShipTarget]],
    'mesh-pull': ['bash', [path.join(receipt.repo, 'scripts/mesh-evidence-backup.sh'), ...process.argv.slice(3)]],
    'restore-drill': [process.execPath, [path.join(receipt.repo, 'scripts/restore-drill.mjs'), '--notify']]
  };
  const command = commands[action];
  if (!command) throw new Error(`unknown snapshot action: ${action}`);
  if (action === 'state-ship' && !receipt.stateShipTarget) throw new Error('state DB is not shipped off-box: set state_ship_target');
  const start = new Date().toISOString();
  const child = spawn(command[0], command[1], { env: process.env, stdio: 'inherit' });
  let failure;
  child.on('error', e => { failure = e.message; });
  child.on('close', async code => {
    const dir = path.join(home, 'snapshots/runs');
    fs.mkdirSync(dir, { recursive: true });
    const id = action === 'mesh-pull' ? `${action}.${process.argv[4]}` : action;
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ startedAt: start, endedAt: new Date().toISOString(), ok: code === 0 && !failure, exitCode: code, ...(failure ? { error: failure } : {}) }) + '\n');
    await publishSchedulingStatus().catch(e => console.error(e.message));
    process.exitCode = code ?? 1;
  });
}

// Owner-local runtime receipts, like gateway PID records: no shared settings,
// secrets or offline authority cache. A normal Stop cancels restart recovery.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deploymentHome } from './deployment-guard.mjs';

const directory = (env) => path.join(deploymentHome(env), 'runtime-startup');
const receiptPath = (id, env) => path.join(directory(env), `${encodeURIComponent(id)}.json`);
export async function readStartupReceipt(id, env = process.env) {
  try {
    const receipt = JSON.parse(await fs.readFile(receiptPath(id, env), 'utf8'));
    return receipt.compositionId === id && typeof receipt.running === 'boolean' && typeof receipt.runId === 'string' ? receipt : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function readStartupReceipts(env = process.env) {
  let names;
  try { names = await fs.readdir(directory(env)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const receipts = [];
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const receipt = await readStartupReceipt(decodeURIComponent(name.slice(0, -5)), env);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}
export async function writeStartupReceipt(compositionId, running, env = process.env) {
  const receipt = { compositionId, running, runId: randomUUID(), at: new Date().toISOString() };
  const file = receiptPath(compositionId, env);
  await fs.mkdir(directory(env), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }); }
  return receipt;
}

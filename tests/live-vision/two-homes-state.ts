// A real state service for the live dev acceptance, confined to temp storage.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startStateService } from '../state-service-harness';
async function main() {
  const root = process.env.TWO_HOMES_SANDBOX;
  if (!root || !(await fs.realpath(root)).startsWith(await fs.realpath(os.tmpdir()) + path.sep)) throw new Error('Temporary TWO_HOMES_SANDBOX is required');
  const service = await startStateService({ nodes: ['two-homes-dev'] });
  const file = path.join(root, '.garrison-dev/state.json');
  await fs.writeFile(file, JSON.stringify({ url: service.url, token: service.token, node: 'two-homes-dev' }), { mode: 0o600 });
  console.log(`Isolated acceptance state ready at ${service.url}`);
  const stop = async () => { await service.stop(); await fs.rm(file, { force: true }); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

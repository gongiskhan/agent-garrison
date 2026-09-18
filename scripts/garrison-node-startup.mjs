#!/usr/bin/env node
// Runs beside the node app. Restore only compositions which actually reached
// running before this process started; explicit Stop leaves a cancelled receipt.
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readStartupReceipts } from '../packages/claude-pty/src/startup-receipt.mjs';
import { deploymentDraining, localConversationActivity } from '../packages/claude-pty/src/deployment-guard.mjs';

export async function restoreNodeStartup({ env = process.env, fetcher = fetch, signal } = {}) {
  if (env.GARRISON_DISABLE_HOST_DAEMONS === '1' || !['node', 'prod'].includes(env.GARRISON_INSTANCE_ID)) return { pending: false, restored: [] };
  const receipts = (await readStartupReceipts(env)).filter(row => row.running);
  if (!receipts.length) return { pending: false, restored: [] };
  if (deploymentDraining(env) || env.GARRISON_CONVERSATION_ID || localConversationActivity(env).length) {
    return { pending: true, restored: [], reason: 'deployment or active Conversation' };
  }
  const port = Number(env.GARRISON_APP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Node startup requires its profile app port');
  const base = `http://127.0.0.1:${port}`;
  const restored = [];
  let pending = false;
  for (const receipt of receipts) {
    const route = `${base}/api/runner/${encodeURIComponent(receipt.compositionId)}`;
    const probe = await fetcher(`${route}/state`, { signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) });
    if (!probe.ok) throw new Error(`Startup state read returned HTTP ${probe.status}`);
    const { state } = await probe.json();
    if (state?.status === 'running') continue;
    if (!['idle', 'stopped', 'failed'].includes(state?.status)) { pending = true; continue; }
    // The runner rechecks this generation under its operation lock. A Stop,
    // manual Run, or deployment since the probe wins over this stale request.
    const response = await fetcher(`${route}/up`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restoreRunId: receipt.runId }),
      signal: AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`Startup restore returned HTTP ${response.status}`);
    const result = await response.json();
    if (result.state?.status === 'running') restored.push(receipt.compositionId);
    else pending = true;
  }
  return { pending, restored };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  while (!controller.signal.aborted) {
    try {
      const result = await restoreNodeStartup({ signal: controller.signal });
      if (result.restored.length) console.log(`[node-startup] restored ${result.restored.join(', ')}`);
      if (!result.pending) break;
    } catch (error) {
      if (controller.signal.aborted) break;
      console.warn(`[node-startup] recovery pending: ${error.message}`);
    }
    await delay(15_000, undefined, { signal: controller.signal }).catch(() => {});
  }
}

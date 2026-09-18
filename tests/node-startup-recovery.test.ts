import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
// @ts-ignore Shared owner-local runtime modules.
import { readStartupReceipt, readStartupReceipts, writeStartupReceipt } from '../packages/claude-pty/src/startup-receipt.mjs';
// @ts-ignore The node launcher also invokes this executable directly.
import { restoreNodeStartup } from '../scripts/garrison-node-startup.mjs';

let home: string;
let env: Record<string, string>;
let server: http.Server | undefined;
const response = (state: string) => Response.json({ state: { status: state } });
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'garrison-startup-'));
  env = { GARRISON_HOME: home, GARRISON_INSTANCE_ID: 'node', GARRISON_APP_PORT: '12345' };
});
afterEach(async () => {
  if (server) { const current = server; server = undefined; current.closeAllConnections(); await new Promise<void>(resolve => current.close(() => resolve())); }
  vi.unstubAllEnvs();
  delete (globalThis as any).__agentGarrisonRunner;
  await fs.rm(home, { recursive: true, force: true });
});

describe('node startup restores prior running compositions', () => {
  it('persists private, generation-bound receipts and an explicit stop', async () => {
    expect(await readStartupReceipts(env)).toEqual([]);
    const running = await writeStartupReceipt('default', true, env);
    expect(await readStartupReceipt('default', env)).toEqual(running);
    const stopped = await writeStartupReceipt('default', false, env);
    expect(stopped.runId).not.toBe(running.runId);
    expect(stopped.running).toBe(false);
    expect((await fs.stat(path.join(home, 'runtime-startup/default.json'))).mode & 0o777).toBe(0o600);
    expect(await readStartupReceipts({ ...env, GARRISON_HOME: path.join(home, 'other-profile') })).toEqual([]);
    const fetcher = vi.fn();
    expect(await restoreNodeStartup({ env, fetcher })).toMatchObject({ pending: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recovers through the normal HTTP up endpoint after the app becomes ready', async () => {
    const receipt = await writeStartupReceipt('default', true, env);
    await writeStartupReceipt('manually-stopped', false, env);
    let running = false;
    const requests: { url: string; body: any }[] = [];
    server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push({ url: req.url!, body: body ? JSON.parse(body) : null });
      if (req.method === 'POST') running = true;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ state: { status: running ? 'running' : 'idle' } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    env.GARRISON_APP_PORT = String((server.address() as import('node:net').AddressInfo).port);
    const result = await restoreNodeStartup({ env });
    expect(result).toEqual({ pending: false, restored: ['default'] });
    expect(requests).toEqual([
      { url: '/api/runner/default/state', body: null },
      { url: '/api/runner/default/up', body: { restoreRunId: receipt.runId } },
    ]);
    requests.length = 0;
    expect(await restoreNodeStartup({ env })).toEqual({ pending: false, restored: [] });
    expect(requests).toHaveLength(1); // Never restarts an already running composition.
  });

  it('defers while deployment or live Conversation work owns the node', async () => {
    await writeStartupReceipt('default', true, env);
    const guard = path.join(home, 'deployment-guard.json');
    await fs.writeFile(guard, JSON.stringify({ pid: process.pid, expiresAt: Date.now() + 60_000 }));
    const fetcher = vi.fn();
    expect((await restoreNodeStartup({ env, fetcher })).pending).toBe(true);
    await fs.rm(guard);
    await fs.mkdir(path.join(home, 'conversations/live'), { recursive: true });
    await fs.writeFile(path.join(home, 'conversations/live/.current-stretch'), `stretch\n${process.pid}`);
    expect((await restoreNodeStartup({ env, fetcher })).pending).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('waits for an in-progress up and retries failures without losing recovery intent', async () => {
    const receipt = await writeStartupReceipt('default', true, env);
    const fetcher = vi.fn().mockResolvedValue(response('verifying'));
    expect((await restoreNodeStartup({ env, fetcher })).pending).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockReset().mockResolvedValueOnce(response('idle')).mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(restoreNodeStartup({ env, fetcher })).rejects.toThrow('HTTP 503');
    expect(await readStartupReceipt('default', env)).toEqual(receipt);
    fetcher.mockReset().mockResolvedValueOnce(response('idle')).mockResolvedValueOnce(response('running'));
    expect((await restoreNodeStartup({ env, fetcher })).restored).toEqual(['default']);
  });

  it('never restores sandbox or host-daemon-disabled launches', async () => {
    await writeStartupReceipt('default', true, env);
    const fetcher = vi.fn();
    for (const overrides of [{ GARRISON_INSTANCE_ID: 'dev' }, { GARRISON_INSTANCE_ID: 'codex' }, { GARRISON_DISABLE_HOST_DAEMONS: '1' }]) {
      expect((await restoreNodeStartup({ env: { ...env, ...overrides }, fetcher })).pending).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects stale restore requests in the runner after Stop or a newer Run', async () => {
    vi.stubEnv('GARRISON_HOME', home);
    const first = await writeStartupReceipt('default', true, env);
    await writeStartupReceipt('default', false, env);
    const { up } = await import('@/lib/runner');
    expect((await up('default', { restoreRunId: first.runId })).status).toBe('idle');
    const later = await writeStartupReceipt('default', true, env);
    expect((await up('default', { restoreRunId: first.runId })).status).toBe('idle');
    expect(await readStartupReceipt('default', env)).toEqual(later);
  });
});

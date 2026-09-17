import {describe, expect, it, vi} from 'vitest';
// @ts-ignore The file source is a plain ESM package.
import {createMachines, MACHINES_UNAVAILABLE} from '../packages/projects/src/machines.mjs';
// @ts-ignore The service is also exercised directly as ESM.
import {createProjectsService} from '../packages/projects/src/projects.mjs';
// @ts-ignore The limit is shared with local reads.
import {MAX_TEXT_BYTES} from '../packages/projects/src/fs.mjs';
import {ApiError, failureMessage} from '../packages/projects/ui/common';

const view = vi.hoisted(() => ({GET: vi.fn()}));
vi.mock('@/app/api/fittings/views/route', () => view);
import {projectsMachines} from '../src/lib/projects-machines';

describe('read-only machine binding', () => {
  it('discovers the healthy remote-shell view through the existing view contract', async () => {
    view.GET.mockImplementation(async () => Response.json({views: [{fittingId: 'remote-shell-runtime', healthy: true, url: 'http://shell.invalid'}]}));
    const fetcher = vi.fn(async () => Response.json({transports: [{name: 'sample', label: 'Sample machine', cwd: '~/synthetic'}]}));
    vi.stubGlobal('fetch', fetcher);
    try {
      expect(await projectsMachines().list()).toEqual([{transport: 'sample', label: 'Sample machine', root: '~/synthetic'}]);
      expect(fetcher).toHaveBeenCalledWith('http://shell.invalid/transports', expect.objectContaining({cache: 'no-store'}));
    } finally {vi.unstubAllGlobals();}
  });
  it('offers no machines and returns the exact outage body when the fitting is down', async () => {
    view.GET.mockImplementation(async () => Response.json({views: [{fittingId: 'remote-shell-runtime', healthy: false, url: 'http://shell.invalid'}]}));
    const machines = projectsMachines(); expect(await machines.list()).toEqual([]);
    await expect(machines.handle(new Request('http://app.invalid/tree'), 'sample', 'tree')).rejects.toMatchObject({status: 503, message: MACHINES_UNAVAILABLE});
    expect(failureMessage(new ApiError(503, {error: MACHINES_UNAVAILABLE}), 'Fixture A')).toBe(MACHINES_UNAVAILABLE);
  });
  it('keeps shared-state outages distinct from fitting outages and transport failures', () => {
    const message = 'Shared state is unreachable. Git actions need it; browsing still works.';
    expect(failureMessage(new ApiError(503, {error: message}), 'Fixture A')).toBe(message);
    expect(failureMessage(new TypeError('Failed to fetch'), 'Fixture A')).toBe('Fixture A did not answer.');
  });
  it('hides invalid transport identifiers from the picker contract', async () => {
    const machines = createMachines({discover: async () => 'http://shell.invalid', fetchImpl: async () => Response.json({transports: [{name: '../outside'}, {name: '.'}, {name: 'sample'}]})});
    expect(await machines.list()).toEqual([{transport: 'sample', label: 'sample', root: '~'}]);
  });
  it('sorts folders first, hides credentials and forwards relative paths without using a local resolver', async () => {
    const fetcher = vi.fn(async () => Response.json({path: 'docs', entries: [{name: 'z.txt', path: 'docs/z.txt', type: 'file', size: 9}, {name: '.env', path: 'docs/.env', type: 'file', size: 1}, {name: 'nested', path: 'docs/nested', type: 'dir', size: 0}]}));
    const machines = createMachines({discover: async () => 'http://shell.invalid', fetchImpl: fetcher});
    const resolver = vi.fn(() => {throw new Error('A machine must not resolve locally');});
    const service = createProjectsService({resolveProject: resolver, listProjects: () => [], devRoot: () => '/synthetic/dev', node: () => ({id: 'fixture-a'}), machines, env: {GARRISON_HOME: '/synthetic/home'}});
    const response = await service.handle(new Request('http://app.invalid/api/projects/machines/sample/tree?path=docs'), ['machines', 'sample', 'tree']);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({source: 'machine:sample', path: 'docs', writable: false, items: [{name: 'nested', path: 'docs/nested', type: 'dir', size: 0}, {name: 'z.txt', path: 'docs/z.txt', type: 'file', size: 9}]});
    expect(fetcher).toHaveBeenCalledWith('http://shell.invalid/transports/sample/files?path=docs', expect.objectContaining({cache: 'no-store'})); expect(resolver).not.toHaveBeenCalled();
  });
  it.each(['../outside', '/absolute', 'docs/.env.local', 'docs/id_rsa'])('refuses unsafe or credential path %s before forwarding it', async rel => {
    const fetcher = vi.fn(); const machines = createMachines({discover: async () => 'http://shell.invalid', fetchImpl: fetcher});
    await expect(machines.handle(new Request(`http://app.invalid/file?path=${encodeURIComponent(rel)}`), 'sample', 'file')).rejects.toMatchObject({status: 403});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps binary file contents intact and refuses oversized remote reads', async () => {
    const content = Buffer.from([0, 255, 1, 2]).toString('base64');
    const fetcher = vi.fn(async () => Response.json({path: 'pixel.png', size: 4, base64: content, truncated: false}));
    const machines = createMachines({discover: async () => 'http://shell.invalid', fetchImpl: fetcher});
    expect(await machines.handle(new Request('http://app.invalid/file?path=pixel.png'), 'sample', 'file')).toMatchObject({kind: 'image', encoding: 'base64', content, readOnly: true});
    fetcher.mockResolvedValueOnce(Response.json({size: MAX_TEXT_BYTES + 1, base64: '', truncated: true}));
    await expect(machines.handle(new Request('http://app.invalid/file?path=large.txt'), 'sample', 'file')).rejects.toMatchObject({status: 413, fields: {size: MAX_TEXT_BYTES + 1}});
  });
});

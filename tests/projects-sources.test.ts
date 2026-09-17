import {describe, expect, it, vi} from 'vitest';
// @ts-ignore
import {createMachines, MACHINES_UNAVAILABLE} from '../packages/projects/src/machines.mjs';
// @ts-ignore
import {createProjectsService} from '../packages/projects/src/projects.mjs';
import {listUrl, projectsUrl, setSelfNode, workspaceUrl} from '../packages/projects/src/urls.mjs';

describe('Projects sources', () => {
  it('routes each source through its own API namespace', () => {
    setSelfNode('fixture-a');
    expect(listUrl('fixture-a')).toBe('/api/projects');
    expect(projectsUrl({node: 'fixture-a', project: 'alpha'}, 'tree')).toBe('/api/projects/alpha/tree');
    expect(workspaceUrl('fixture-a', 'file')).toBe('/api/workspace/file');
    expect(projectsUrl({node: 'fixture-a', project: 'machines'}, 'sample/tree')).toBe('/api/projects/machines/sample/tree');
  });
  it('always offers the local source, even with no shell to ask', async () => {
    const service = createProjectsService({env: {GARRISON_HOME: '/synthetic/home'}, devRoot: () => '/synthetic/dev', node: () => ({id: 'fixture-a'}), listProjects: () => [], resolveProject: () => null, machines: createMachines()});
    const result = await (await service.handle(new Request('http://127.0.0.1/api/projects'))).json();
    expect(result.workspace).toEqual({root: '/synthetic/home/files', writable: true});
    expect(result.projects).toEqual([]); expect(result.machines).toEqual([]);
  });
  it('adds one read-only source per transport, discovered not guessed', async () => {
    const discover = vi.fn(async () => 'http://127.0.0.1:9999');
    const fetchImpl = vi.fn(async (_url: string) => Response.json({transports: [{name: 'sample', label: 'Sample work', cwd: '~/synthetic/project'}]}));
    const machines = createMachines({discover, fetchImpl});
    expect(await machines.list()).toEqual([{transport: 'sample', label: 'Sample work', root: '~/synthetic/project'}]);
    expect(discover).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:9999/transports');
  });
  it('degrades to local-only when the shell is unreachable, rather than failing to load', async () => {
    const machines = createMachines({discover: async () => {throw new Error('connection refused');}});
    expect(await machines.list()).toEqual([]);
  });
  it('never marks a remote source writable', async () => {
    const machines = createMachines({discover: async () => 'http://127.0.0.1:9999', fetchImpl: async (url: string) => Response.json(url.includes('/files?') ? {path: '', entries: [{name: 'guide.md', path: 'guide.md', type: 'file', size: 7}]} : {base64: Buffer.from('# Guide').toString('base64'), size: 7, truncated: false})});
    const tree = await machines.handle(new Request('http://127.0.0.1/tree'), 'sample', 'tree');
    expect(tree).toMatchObject({source: 'machine:sample', writable: false, items: [{name: 'guide.md', type: 'file'}]});
    const file = await machines.handle(new Request('http://127.0.0.1/file?path=guide.md'), 'sample', 'file');
    expect(file).toMatchObject({kind: 'markdown', encoding: 'utf8', content: '# Guide', readOnly: true});
    await expect(machines.handle(new Request('http://127.0.0.1/file', {method: 'PUT'}), 'sample', 'file')).rejects.toMatchObject({status: 405});
  });
  it('reports absent transports without attempting a local path resolution', async () => {
    await expect(createMachines().handle(new Request('http://127.0.0.1/tree'), 'sample', 'tree')).rejects.toMatchObject({status: 503, message: MACHINES_UNAVAILABLE});
  });
});

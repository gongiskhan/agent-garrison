import {describe, expect, it} from 'vitest';
import {allowListDescription, classifyPeerPath, projectsPeerTimeout} from '../src/lib/mesh/peer-proxy';
// @ts-ignore The package is exercised directly as ESM.
import {listUrl, projectsUrl, setSelfNode, workspaceUrl} from '../packages/projects/src/urls.mjs';

const rows = [
  'GET projects', 'GET projects/:id/summary', 'GET projects/:id/tree', 'GET projects/:id/file',
  'GET projects/:id/git/status', 'GET projects/:id/git/diff', 'GET projects/:id/git/log',
  'POST projects/:id/git/fetch', 'POST projects/:id/git/commit-push',
  'POST projects/:id/git/pull-from-others', 'POST projects/:id/git/push-to-others',
  'GET projects/machines/:id/tree', 'GET projects/machines/:id/file',
  'GET workspace/tree', 'GET workspace/file'
];
describe('Projects mesh contract', () => {
  it('describes exactly the fifteen Projects and workspace relay rows', () => {
    expect(allowListDescription().filter(row => /^(GET|POST|PUT|DELETE) (projects|workspace)(\/|$)/.test(row))).toEqual(rows);
  });
  it.each(rows)('classifies %s and refuses every other method', description => {
    const [method, resource] = description.split(' '), segments = resource.replaceAll(':id', 'synthetic-1').split('/');
    const result = classifyPeerPath(method, segments);
    expect(result).toEqual({ok: true, route: {upstream: 'app', path: `/api/${segments.join('/')}`, sse: false, threadId: null}});
    for (const other of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].filter(verb => verb !== method)) {
      expect(classifyPeerPath(other, segments)).toEqual({ok: false, status: 405, error: 'method-not-relayed'});
    }
  });
  it('REFUSES writes to a peer workspace', () => {
    expect(classifyPeerPath('PUT', ['workspace', 'file'])).toMatchObject({ok: false, status: 405});
    expect(classifyPeerPath('POST', ['workspace', 'mkdir'])).toMatchObject({ok: false, status: 403});
    expect(classifyPeerPath('PUT', ['projects', 'alpha', 'file'])).toMatchObject({ok: false, status: 405});
    expect(classifyPeerPath('POST', ['projects', 'alpha', 'mkdir'])).toMatchObject({ok: false, status: 403});
  });
  it.each(['..', '.', 'a/b', 'a%2fb', 'a?path=x', 'x'.repeat(513)])('refuses the invalid ID %s', id => {
    expect(classifyPeerPath('GET', ['projects', id, 'tree']).ok).toBe(false);
    expect(classifyPeerPath('GET', ['projects', 'machines', id, 'file']).ok).toBe(false);
  });
  it.each(rows)('selects the timeout from the classified path for %s', description => {
    const [method, resource] = description.split(' ');
    const result = classifyPeerPath(method, resource.replaceAll(':id', 'alpha').split('/'));
    if (!result.ok) throw new Error('Expected permitted fixture route');
    expect(projectsPeerTimeout(method, result.route)).toBe(resource.endsWith('/fetch') ? 60_000 : method === 'POST' ? 180_000 : undefined);
  });
  it('leaves stream, install and terminal connection budgets to their existing policy', () => {
    for (const [method, segments] of [['GET', ['threads', 'thread-1', 'live']], ['POST', ['install']], ['POST', ['remote-shell', 'sessions']]] as [string, string[]][]) {
      const result = classifyPeerPath(method, segments);
      if (!result.ok) throw new Error('Expected permitted fixture route');
      expect(projectsPeerTimeout(method, result.route)).toBeUndefined();
    }
  });
});

describe('relative Projects URLs', () => {
  it('short-circuits self and sends peer operations to the owning node', () => {
    setSelfNode('fixture-a');
    expect(listUrl()).toBe('/api/projects');
    expect(listUrl('fixture-a')).toBe('/api/projects');
    expect(listUrl('fixture-b')).toBe('/api/mesh/nodes/fixture-b/projects');
    expect(projectsUrl({node: 'fixture-a', project: 'alpha'}, 'git/status')).toBe('/api/projects/alpha/git/status');
    expect(projectsUrl({node: 'fixture-b', project: 'delta'}, 'git/fetch')).toBe('/api/mesh/nodes/fixture-b/projects/delta/git/fetch');
    expect(workspaceUrl('fixture-a', 'file?path=documents%2Fnote.md')).toBe('/api/workspace/file?path=documents%2Fnote.md');
    expect(workspaceUrl('fixture-b', 'tree')).toBe('/api/mesh/nodes/fixture-b/workspace/tree');
  });
  it('encodes both identity slots and keeps the query relative', () => {
    setSelfNode('fixture-a');
    expect(projectsUrl({node: 'peer name', project: 'project name'}, '/file?path=docs%2Fnote.md')).toBe('/api/mesh/nodes/peer%20name/projects/project%20name/file?path=docs%2Fnote.md');
    expect(workspaceUrl('peer name', 'tree')).toBe('/api/mesh/nodes/peer%20name/workspace/tree');
    expect(listUrl('peer name')).toBe('/api/mesh/nodes/peer%20name/projects');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {listProjectNames, resolveProjectName} from '../src/lib/dev-root';
import {seedProject} from './projects-fixture';
// @ts-ignore The package API is independent of Next.
import {createProjectsService} from '../packages/projects/src/projects.mjs';

let scratch: string, devRoot: string, root: string;
let service: ReturnType<typeof createProjectsService>;
const identity = {id: 'node-a', name: 'node-a', accentColor: '#4a7d5f', isSelf: true, state: 'online'};
const client = {health: async () => ({}), listSessions: async () => [], listNodes: async () => []};
beforeAll(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-git-api-'));
  devRoot = path.join(scratch, 'dev');
  root = await seedProject(devRoot, 'alpha', {'readme.md': '# Synthetic original\n', 'logo.bin': Buffer.from([0, 1, 2])});
  await fs.writeFile(path.join(root, 'readme.md'), '# Synthetic modified\n');
  await fs.writeFile(path.join(root, 'new.txt'), 'Synthetic untracked file\n');
  service = makeService();
});
afterAll(async () => {await fs.rm(scratch, {recursive: true, force: true});});

function makeService(withState = (callback: (value: typeof client) => unknown) => callback(client)) {
  return createProjectsService({env: {GARRISON_HOME: path.join(scratch, 'home')}, node: () => identity,
    devRoot: () => devRoot, listProjects: () => listProjectNames(devRoot), resolveProject: (project: string) => resolveProjectName(project, {devRoot}), withState, log: () => {}});
}
function call(action: string, method = 'GET', body?: unknown, target = service, headers = {}) {
  const request = new Request(`http://127.0.0.1/api/projects/alpha/git/${action}`, {method, headers: {host: '127.0.0.1', ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return target.handle(request, ['alpha', 'git', action.split('?')[0]]);
}

describe('Git route contract on the owning node', () => {
  it('serves status with root, project and normalized dirty rows', async () => {
    const response = await call('status');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({project: 'alpha', root, branch: 'main', dirtyCount: 2,
      dirty: expect.arrayContaining([expect.objectContaining({path: 'readme.md', state: 'modified', staged: false}), expect.objectContaining({path: 'new.txt', state: 'untracked', staged: false})])});
  });
  it('returns the public diff field names and the changed lines', async () => {
    const response = await call('diff?path=readme.md');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['binary', 'capBytes', 'path', 'project', 'staged', 'text', 'truncated']);
    expect(body).toMatchObject({project: 'alpha', path: 'readme.md', staged: false, capBytes: 500 * 1024, truncated: false, binary: []});
    expect(body.text).toContain('-# Synthetic original');
    expect(body.text).toContain('+# Synthetic modified');
  });
  it.each([['-2', 1], ['0', 1], ['1', 1], ['3.9', 3], ['99999', 200], ['invalid', 30], ['', 30]])('clamps the git/log route limit %s to %s', async (value, expected) => {
    const response = await call(`log${value ? `?limit=${value}` : ''}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({project: 'alpha', limit: expected});
    expect(body.commits[0]).toMatchObject({subject: 'Synthetic initial snapshot'});
  });
  it.each([['status', 'POST'], ['diff', 'PUT'], ['log', 'POST'], ['fetch', 'GET'], ['commit-push', 'GET'], ['pull-from-others', 'GET'], ['push-to-others', 'GET']])('allows only the declared method for %s', async (action, method) => {
    expect((await call(action, method)).status).toBe(405);
  });
  it('refuses undeclared git operations and cross-origin reads or actions', async () => {
    expect((await call('config')).status).toBe(404);
    expect((await call('status', 'GET', undefined, service, {origin: 'https://synthetic.invalid'})).status).toBe(403);
    expect((await call('commit-push', 'POST', {}, service, {origin: 'https://synthetic.invalid'})).status).toBe(403);
  });
  it('refuses a binary path with the exact 415 body', async () => {
    await fs.writeFile(path.join(root, 'logo.bin'), Buffer.from([0, 1, 3]));
    const response = await call('diff?path=logo.bin');
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({error: 'refusing to diff a binary file'});
  });
  it('rejects invalid action bodies before a commit', async () => {
    for (const body of [null, [], {message: ''}, {message: 9}, {force: 'yes'}]) expect((await call('commit-push', 'POST', body)).status).toBe(400);
    expect((await call('push-to-others', 'POST', {targets: ['../outside']})).status).toBe(400);
  });
  it('returns 503 for an unavailable shared-state binding while browsing and status keep working', async () => {
    const offline = makeService(() => {const error = new Error('Synthetic unavailable state'); error.name = 'StateUnavailableError'; throw error;});
    const response = await call('fetch', 'POST', undefined, offline);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error: 'Shared state is unreachable. Git actions need it; browsing still works.'});
    expect((await call('status', 'GET', undefined, offline)).status).toBe(200);
    expect((await offline.handle(new Request('http://127.0.0.1/api/projects/alpha/tree'), ['alpha', 'tree'])).status).toBe(200);
  });
  it('commits locally through the route when there is no origin', async () => {
    const response = await call('commit-push', 'POST');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({project: 'alpha', cwd: root, status: 'committed-no-origin', branch: 'main'});
    expect((await (await call('status')).json()).dirtyCount).toBe(0);
    expect((await (await call('log?limit=1')).json()).commits[0].subject).toBe('workspace: commit-push snapshot from node-a');
  });
  it('refuses git for the workspace slot', async () => {
    const response = await service.handle(new Request('http://127.0.0.1/api/workspace/git/status'), ['git', 'status'], 'workspace');
    expect(response.status).toBe(404);
  });
});

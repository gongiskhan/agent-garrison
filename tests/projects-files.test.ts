import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {listProjectNames, resolveProjectName} from '@/lib/dev-root';
import {renderMarkdown} from '@/lib/markdown';
import {seedProject} from './projects-fixture';
// @ts-ignore ESM package API is the framework-independent route handler.
import {createProjectsService, READ_ONLY, validProject} from '../packages/projects/src/projects.mjs';
// @ts-ignore
import {MAX_TEXT_BYTES} from '../packages/projects/src/fs.mjs';
// @ts-ignore
import {dirtyState} from '../packages/projects/src/git.mjs';

let scratch: string, home: string, workspace: string, devRoot: string, outside: string, alpha: string, beta: string;
let service: ReturnType<typeof createProjectsService>;
const node = {id: 'fixture-a', name: 'Fixture A', accentColor: '#31563f', isSelf: true, state: 'online'};
beforeAll(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-files-'));
  home = path.join(scratch, 'home'); workspace = path.join(home, 'files'); devRoot = path.join(scratch, 'dev'); outside = path.join(scratch, 'outside');
  await fs.mkdir(outside, {recursive: true}); await fs.mkdir(workspace, {recursive: true});
  alpha = await seedProject(devRoot, 'alpha', {'docs/deep/readme.md': '# Synthetic guide\n\n- First\n- Second\n', 'notes.txt': 'hello\n'});
  beta = await seedProject(devRoot, 'beta', {'private.txt': 'Synthetic beta file'});
  await fs.mkdir(path.join(devRoot, 'gamma')); await fs.symlink(beta, path.join(alpha, 'beta-link'));
  await fs.mkdir(path.join(outside, '.git')); await fs.symlink(outside, path.join(devRoot, 'sneaky'));
  await fs.mkdir(path.join(workspace, 'reports')); await fs.writeFile(path.join(workspace, 'reports/q3.md'), '# Synthetic report\n');
  await fs.writeFile(path.join(workspace, 'notes.txt'), 'hello'); await fs.writeFile(path.join(workspace, 'vault.json'), '{"synthetic":true}');
  await fs.writeFile(path.join(outside, 'target.txt'), 'ORIGINAL');
  await fs.symlink(outside, path.join(workspace, 'linkdir')); await fs.symlink(path.join(outside, 'target.txt'), path.join(workspace, 'linkfile.txt'));
  for (const name of ['.env', '.envrc', '.env.local', 'test.pem', 'test.key', 'test.crt', 'id_rsa_test', 'test.p12', 'test.pfx', 'credentials.json', '.netrc', '.npmrc']) await fs.writeFile(path.join(alpha, name), 'synthetic credential fixture');
  service = createProjectsService({env: {GARRISON_HOME: home}, node: () => node, devRoot: () => devRoot, listProjects: () => listProjectNames(devRoot), resolveProject: (name: string) => resolveProjectName(name, {devRoot})});
});
afterAll(async () => {await fs.rm(scratch, {recursive: true, force: true});});

function call(url: string, method = 'GET', body?: object, headers: Record<string, string> = {}) {
  const request = new Request(`http://127.0.0.1${url}`, {method, headers: {host: '127.0.0.1', ...headers}, ...(body ? {body: JSON.stringify(body)} : {})});
  const pathname = new URL(request.url).pathname;
  const parts = pathname.split('/').slice(2);
  return service.handle(request, parts.slice(1).map(decodeURIComponent), parts[0]);
}
const fileUrl = (source: string, rel: string) => `/api/${source}/file?path=${encodeURIComponent(rel)}`;

describe('Projects files and workspace', () => {
  it('lists the scoped root (dirs first), hiding credential files', async () => {
    const data = await (await call('/api/workspace/tree')).json();
    expect(data.items.map((entry: any) => entry.name)).toEqual(expect.arrayContaining(['reports', 'notes.txt', 'documents', 'recordings', 'runs', 'uploads']));
    expect(data.items.some((entry: any) => entry.name === 'vault.json')).toBe(false);
    expect(data.items[0].type).toBe('dir'); expect(data.source).toBe('workspace'); expect(data.writable).toBe(true);
  });
  it('reads a text file and classifies markdown', async () => {
    expect(await (await call(fileUrl('workspace', 'notes.txt'))).json()).toMatchObject({kind: 'text', content: 'hello', readOnly: false});
    expect(await (await call(fileUrl('workspace', 'reports/q3.md'))).json()).toMatchObject({kind: 'markdown', content: '# Synthetic report\n'});
  });
  it('writes a file within the root', async () => {
    expect(await (await call('/api/workspace/file', 'PUT', {path: 'reports/new.txt', content: 'written'})).json()).toEqual({ok: true, path: 'reports/new.txt'});
    expect((await (await call(fileUrl('workspace', 'reports/new.txt'))).json()).content).toBe('written');
  });
  it('REFUSES path traversal out of the root', async () => {
    expect((await call(fileUrl('workspace', '../outside/target.txt'))).status).toBe(403);
    expect((await call('/api/workspace/file', 'PUT', {path: '../escape.txt', content: 'x'})).status).toBe(403);
    for (const rel of ['/absolute', 'reports/../notes.txt', 'a\0b', 'C:\\outside']) expect((await call(fileUrl('workspace', rel))).status).toBe(403);
  });
  it('REFUSES to serve a credential file even by direct path', async () => {
    expect((await call(fileUrl('workspace', 'vault.json'))).status).toBe(403);
  });
  it('REFUSES to READ through a symlinked file pointing outside (O_NOFOLLOW)', async () => {
    expect((await call(fileUrl('workspace', 'linkfile.txt'))).status).toBe(403);
  });
  it('REFUSES to write THROUGH a symlinked dir that points outside the root', async () => {
    expect((await call('/api/workspace/file', 'PUT', {path: 'linkdir/pwned.txt', content: 'x'})).status).toBe(403);
    await expect(fs.access(path.join(outside, 'pwned.txt'))).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('REFUSES to overwrite THROUGH an existing symlinked file pointing outside', async () => {
    expect((await call('/api/workspace/file', 'PUT', {path: 'linkfile.txt', content: 'HACKED'})).status).toBe(403);
    expect(await fs.readFile(path.join(outside, 'target.txt'), 'utf8')).toBe('ORIGINAL');
  });
  it('rejects a cross-origin request (CSRF guard)', async () => {
    for (const origin of ['https://evil.example', 'http://localhost', 'null']) expect((await call('/api/workspace/tree', 'GET', undefined, {origin})).status).toBe(403);
    expect((await call('/api/workspace/tree', 'GET', undefined, {origin: 'http://127.0.0.1'})).status).toBe(200);
  });
  it('offers the local source plus one per dev-root project', async () => {
    const data = await (await call('/api/projects')).json();
    expect(data.node).toEqual(node); expect(data.projects.map((row: any) => row.project)).toEqual(['alpha', 'beta']);
    expect(data.workspace).toEqual({root: workspace, writable: true}); expect(data.machines).toEqual([]);
  });
  it('browses and reads inside a project source', async () => {
    const data = await (await call('/api/projects/alpha/tree?path=docs%2Fdeep')).json();
    expect(data).toMatchObject({source: 'project:alpha', writable: false, items: [{name: 'readme.md', path: 'docs/deep/readme.md', type: 'file'}]});
    expect(await (await call(fileUrl('projects/alpha', 'docs/deep/readme.md'))).json()).toMatchObject({kind: 'markdown', readOnly: true});
  });
  it('hides the repository\'s own .git and its credential files', async () => {
    const data = await (await call('/api/projects/alpha/tree')).json();
    expect(data.items.map((row: any) => row.name)).toEqual(['docs', 'notes.txt']);
    for (const rel of ['.git/config', '.env', '.envrc', '.env.local', 'test.pem', 'test.key', 'test.crt', 'id_rsa_test', 'test.p12', 'test.pfx', 'credentials.json', '.netrc', '.npmrc']) expect((await call(fileUrl('projects/alpha', rel))).status, rel).toBe(403);
  });
  it('REFUSES to reach project beta from project alpha by traversal', async () => {
    expect((await call(fileUrl('projects/alpha', '../beta/private.txt'))).status).toBe(403);
  });
  it('REFUSES to reach project beta from project alpha THROUGH a symlink', async () => {
    expect((await call(fileUrl('projects/alpha', 'beta-link/private.txt'))).status).toBe(403);
  });
  it('keeps the LOCAL root confined exactly as before, with its own root', async () => {
    expect((await call(fileUrl('workspace', '../../dev/alpha/notes.txt'))).status).toBe(403);
    expect((await call(fileUrl('projects/alpha', '../../home/files/notes.txt'))).status).toBe(403);
  });
  it('REFUSES every write to a project source', async () => {
    for (const [action, method] of [['file', 'PUT'], ['mkdir', 'POST']]) {
      const response = await call(`/api/projects/alpha/${action}`, method, {path: 'blocked', content: 'x'});
      expect(response.status).toBe(403); expect(await response.json()).toEqual({error: READ_ONLY});
    }
  });
  it('distinguishes invalid project names from absent repositories', async () => {
    expect((await call('/api/projects/.hidden/summary')).status).toBe(400);
    expect((await call('/api/projects/gamma/summary')).status).toBe(404);
    expect(await (await call('/api/projects/absent/summary')).json()).toEqual({error: 'no such project'});
  });
  it('reports the exact summary model without fetching', async () => {
    const summary = await (await call('/api/projects/beta/summary')).json();
    expect(summary).toMatchObject({project: 'beta', branch: 'main', upstream: null, ahead: 0, behind: 0, dirtyCount: 0, stash: 0, mergeInProgress: false});
    expect(summary.head).toMatch(/^[a-f0-9]{40}$/); expect(summary.lastCommitAt).toMatch(/^\d{4}-/);
  });
  it('never throws when the dev-root is missing', async () => {
    const absent = path.join(scratch, 'absent');
    const instance = createProjectsService({env: {GARRISON_HOME: home}, node: () => node, devRoot: () => absent, listProjects: () => listProjectNames(absent, {selfCheckout: true}), resolveProject: () => null});
    expect((await (await instance.handle(new Request('http://127.0.0.1/api/projects'))).json()).projects).toEqual([]);
  });
  it('refuses machines as a project name even when it has a repository marker', async () => {
    await fs.mkdir(path.join(devRoot, 'machines/.git'), {recursive: true});
    expect(resolveProjectName('machines', {devRoot})).toBeNull();
    expect((await call('/api/projects/machines/summary')).status).toBe(400);
  });
  it('rejects a workspace write over a symlinked parent even when its target is inside', async () => {
    await fs.symlink(path.join(workspace, 'reports'), path.join(workspace, 'inside-link'));
    expect((await call('/api/workspace/file', 'PUT', {path: 'inside-link/new.txt', content: 'changed'})).status).toBe(403);
    expect((await call('/api/workspace/mkdir', 'POST', {path: 'inside-link/new-folder'})).status).toBe(403);
  });
  it('refuses a final in-root symlink at open and hides credential aliases', async () => {
    await fs.symlink(path.join(alpha, 'notes.txt'), path.join(alpha, 'note-link'));
    await fs.symlink(path.join(alpha, '.env'), path.join(alpha, 'secret-alias'));
    expect((await call(fileUrl('projects/alpha', 'note-link'))).status).toBe(403);
    expect((await call(fileUrl('projects/alpha', 'secret-alias'))).status).toBe(403);
    expect((await (await call('/api/projects/alpha/tree')).json()).items.some((row: any) => row.name === 'secret-alias')).toBe(false);
  });
  it('reports vanished files, refuses oversized files, and returns base64 images', async () => {
    expect((await call(fileUrl('workspace', 'vanished.txt'))).status).toBe(404);
    await fs.writeFile(path.join(workspace, 'large.txt'), Buffer.alloc(MAX_TEXT_BYTES + 1, 65));
    const large = await call(fileUrl('workspace', 'large.txt'));
    expect(large.status).toBe(413); expect(await large.json()).toEqual({error: 'file too large to open in the browser', size: MAX_TEXT_BYTES + 1});
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(workspace, 'pixel.png'), image);
    expect(await (await call(fileUrl('workspace', 'pixel.png'))).json()).toMatchObject({kind: 'image', encoding: 'base64', content: image.toString('base64'), ext: 'png'});
  });
  it('creates folders and keeps wiki-style names plain in Projects markdown', async () => {
    expect(await (await call('/api/workspace/mkdir', 'POST', {path: 'documents/new'})).json()).toEqual({ok: true, path: 'documents/new'});
    expect(renderMarkdown('# Guide\n\n[[name]]\n\n- One', {wikiLinks: false})).toContain('[[name]]');
    expect(renderMarkdown('[[name]]', {wikiLinks: false})).not.toContain('<a');
    expect(renderMarkdown('[[name]]')).toContain('/archive/search');
  });
});

it.each([[' M', 'modified'], ['.M', 'modified'], ['M.', 'modified'], ['A.', 'added'], ['.D', 'deleted'], ['R.', 'renamed'], ['??', 'untracked'], ['UU', 'conflict'], ['AA', 'conflict'], ['DD', 'conflict'], ['..', 'other']])('derives dirty state %s as %s', (xy, expected) => {
  expect(dirtyState(xy)).toBe(expected);
});

it.each(['-sample', '_sample'])('keeps the safe project ID %s accepted by the relay', name => {
  expect(validProject(name)).toBe(true);
});

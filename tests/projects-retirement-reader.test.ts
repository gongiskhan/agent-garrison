import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parse} from 'yaml';
import {RETIRED_PROJECTS_FITTING as retired} from '../src/lib/composition-migrate';

const fixture = vi.hoisted(() => ({root: '', getComposition: vi.fn(), putComposition: vi.fn()}));
vi.mock('@/lib/paths', async original => ({...await original<typeof import('@/lib/paths')>(), get COMPOSITIONS_DIR() {return path.join(fixture.root, 'compositions');}}));
vi.mock('@/lib/state-client', () => ({stateClient: () => fixture, StateUnavailableError: class extends Error {}}));
vi.mock('@/lib/library', () => ({readLibrary: async () => []}));
const manifest = (name = 'Fixture') => `name: fixture\nversion: 1.0.0\nx-garrison:\n  composition:\n    id: fixture\n    name: ${name}\n    schema: 4\n    selections:\n      sessions: [{id: ${retired}, config: {}}]\n    global_config: {}\n    duties: []\n    targets: []\n`;
let file: string;
beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-reader-'));
  file = path.join(fixture.root, 'compositions/fixture/apm.yml');
  await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, manifest());
  vi.stubEnv('GARRISON_HOME', path.join(fixture.root, 'home'));
  vi.stubEnv('GARRISON_STATE_URL', 'http://authority.invalid'); vi.stubEnv('GARRISON_STATE_TOKEN', 'synthetic-token');
  fixture.getComposition.mockReset(); fixture.putComposition.mockReset().mockResolvedValue({rev: 3});
});
afterEach(async () => {vi.unstubAllEnvs(); await fs.rm(fixture.root, {recursive: true, force: true});});
describe('Projects retirement on composition reads', () => {
  it('the normal reader removes the selection on first load and records it once', async () => {
    const {readComposition} = await import('@/lib/compositions');
    const first = await readComposition('fixture'); expect(first.selections.sessions ?? []).toEqual([]);
    const saved = await fs.readFile(file, 'utf8'); expect(saved).not.toContain(retired);
    const log = path.join(fixture.root, 'home/migrations/projects/fixture.json'); const record = await fs.readFile(log, 'utf8');
    await readComposition('fixture'); expect(await fs.readFile(file, 'utf8')).toBe(saved); expect(await fs.readFile(log, 'utf8')).toBe(record);
  });
  it('retries a shared revision conflict against fresh bytes and preserves an intervening edit', async () => {
    const {syncCompositionFromState} = await import('@/lib/composition-sync');
    fixture.getComposition.mockResolvedValueOnce({rev: 1, manifestYaml: manifest(), files: []}).mockResolvedValueOnce({rev: 2, manifestYaml: manifest('Concurrent edit'), files: []});
    fixture.putComposition.mockRejectedValueOnce(Object.assign(new Error('revision conflict'), {status: 409})).mockResolvedValueOnce({rev: 3});
    await syncCompositionFromState('fixture', path.dirname(file));
    expect(fixture.putComposition.mock.calls.map(call => call[2])).toEqual([{ifMatchRev: 1}, {ifMatchRev: 2}]);
    const saved = await fs.readFile(file, 'utf8'); expect(saved).not.toContain(retired);
    expect(parse(saved)['x-garrison'].composition.name).toBe('Concurrent edit');
  });
  it('does not materialize rejected shared changes or report a successful removal', async () => {
    const {syncCompositionFromState} = await import('@/lib/composition-sync');
    fixture.getComposition.mockResolvedValue({rev: 1, manifestYaml: manifest(), files: []});
    fixture.putComposition.mockRejectedValue(new Error('state unavailable'));
    await expect(syncCompositionFromState('fixture', path.dirname(file))).rejects.toThrow('state unavailable');
    expect(await fs.readFile(file, 'utf8')).toBe(manifest());
    await expect(fs.stat(path.join(fixture.root, 'home/migrations'))).rejects.toMatchObject({code: 'ENOENT'});
  });
});

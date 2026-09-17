import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {parse} from 'yaml';
import {RETIRED_PROJECTS_FITTING as retired, retireProjectsYaml} from '../src/lib/composition-migrate';
import {recordProjectsRetirement, retireProjectsFile} from '../src/lib/projects-retirement';

const manifest = (dependency = `../../fittings/seed/${retired}`) => `# Synthetic composition\nname: fixture\ndependencies:\n  apm:\n    - path: ${dependency}\n    - path: ../../fittings/seed/sample-view\nx-garrison:\n  composition:\n    schema: 4\n    selections:\n      sessions:\n        - id: ${retired}\n          config: {root: /synthetic/artifacts, token: fixture-secret}\n        - id: sample-view\n          config: {label: Keep this value}\n    unfitted: [${retired}, sample-opt-out]\n    global_config:\n      custom: {keep: true}\n`;
describe('Projects composition retirement', () => {
  let root: string;
  beforeEach(async () => {root = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-retirement-'));});
  afterEach(async () => {await fs.rm(root, {recursive: true, force: true});});
  it.each([`../../fittings/seed/${retired}`, `fittings/seed/${retired}`, `../fittings/seed/${retired}/`])('removes a retired selection and dependency at %s and preserves unrelated content', dependency => {
    const result = retireProjectsYaml(manifest(dependency)), doc = parse(result);
    expect(result).toContain('# Synthetic composition');
    expect(result).not.toContain(retired);
    expect(doc.dependencies.apm).toEqual([{path: '../../fittings/seed/sample-view'}]);
    expect(doc['x-garrison'].composition.selections.sessions).toEqual([{id: 'sample-view', config: {label: 'Keep this value'}}]);
    expect(doc['x-garrison'].composition.global_config).toEqual({custom: {keep: true}});
    expect(doc['x-garrison'].composition.unfitted).toEqual(['sample-opt-out']);
    expect(retireProjectsYaml(result)).toBe(result);
  });
  it('leaves a manifest with no retired surface byte-for-byte unchanged', () => {
    const raw = '# Keep authored spacing\nname: fixture\nx-garrison: {composition: {schema: 4, selections: {}}}\n';
    expect(retireProjectsYaml(raw)).toBe(raw);
  });
  it('refuses malformed YAML without changing a file or writing a removal record', async () => {
    const file = path.join(root, 'apm.yml'), raw = 'x-garrison: [invalid'; await fs.writeFile(file, raw);
    await expect(retireProjectsFile(file, 'fixture', root)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    await expect(fs.stat(path.join(root, 'migrations'))).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('migrates on first load and records only removal metadata once', async () => {
    const file = path.join(root, 'apm.yml'); await fs.writeFile(file, manifest());
    await retireProjectsFile(file, 'fixture', root);
    const migrated = await fs.readFile(file, 'utf8'), log = path.join(root, 'migrations/projects/fixture.json'), record = await fs.readFile(log, 'utf8');
    expect(JSON.parse(record)).toEqual({at: expect.any(String), composition: 'fixture', removed: [retired]});
    expect(record).not.toContain('fixture-secret'); expect(record).not.toContain('/synthetic/artifacts');
    await retireProjectsFile(file, 'fixture', root); await recordProjectsRetirement('fixture', root);
    expect(await fs.readFile(file, 'utf8')).toBe(migrated); expect(await fs.readFile(log, 'utf8')).toBe(record);
    expect((await fs.stat(log)).mode & 0o777).toBe(0o600);
  });
  it('does not recreate a missing composition on a tolerant read', async () => {
    await retireProjectsFile(path.join(root, 'absent.yml'), 'absent', root);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

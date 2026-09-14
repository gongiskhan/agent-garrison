import fs from 'node:fs/promises';
import path from 'node:path';
import {expect, it} from 'vitest';

it('keeps the retired fitting and git floors out of live code, tests and current docs', async () => {
  const forbidden = [['file', 'browser'].join('-'), ['git', 'mesh'].join('-'), ['git', 'executor'].join('-'), ['Mesh', 'GitPanel'].join(''), ['/api/mesh', 'git'].join('/')];
  const roots = ['src', 'packages', 'tests', 'fittings', 'scripts', 'compositions', 'docs'];
  const hits: string[] = [];
  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (file === path.join('docs', 'decisions')) continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(file);
        if (forbidden.some(word => bytes.includes(Buffer.from(word)))) hits.push(file);
      }
    }
  }
  await Promise.all(roots.map(walk));
  expect(hits.sort()).toEqual([]);
});

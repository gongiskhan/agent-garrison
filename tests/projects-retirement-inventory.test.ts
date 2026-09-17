import fs from 'node:fs/promises';
import path from 'node:path';
import {expect, it} from 'vitest';
import {selfCheckoutProject} from '@/lib/dev-root';
// @ts-ignore Source inventory uses the same bounded git process module.
import {runGit} from '../packages/projects/src/git.mjs';

it('keeps the retired fitting and git floors out of live code, tests and current docs', async () => {
  const forbidden = [['file', 'browser'].join('-'), ['git', 'mesh'].join('-'), ['git', 'executor'].join('-'), ['Mesh', 'GitPanel'].join(''), ['/api/mesh', 'git'].join('/')];
  const roots = ['src', 'packages', 'tests', 'fittings', 'scripts', 'compositions', 'docs'];
  const cwd = selfCheckoutProject().root;
  const inventory = await runGit(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...roots], {timeoutMs: 10_000, cap: 2 * 1024 * 1024});
  expect(inventory.code).toBe(0); expect(inventory.truncated).toBe(false); expect(inventory.timedOut).toBe(false);
  const hits: string[] = [];
  for (const file of new Set<string>(inventory.stdout.split('\0').filter(Boolean))) {
    if (file.startsWith('docs/decisions/')) continue;
    const absolute = path.join(cwd, file);
    const stat = await fs.lstat(absolute).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
    if (!stat?.isFile()) continue;
    const bytes = await fs.readFile(absolute);
    if (forbidden.some(word => bytes.includes(Buffer.from(word)))) hits.push(file);
  }
  expect(hits.sort()).toEqual([]);
});

import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {git, initRepo, initBare, cloneOf, commitFile} from './projects-git-fixture';
// @ts-ignore The package is exercised directly as ESM.
import {assertPathArg, assertRefArg, DIFF_CAP_BYTES, gitCommitAll, gitDiff, gitFetch, gitLog, gitStatus, parsePorcelainV2, runGit} from '../packages/projects/src/git.mjs';

describe('runGit and its command rails', () => {
  let base: string, dir: string;
  const marker = 'HOOK-RAN';
  beforeAll(async () => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'projects-git-rails-')));
    dir = await initRepo(path.join(base, 'alpha'));
    const hooks = path.join(dir, '.git/hooks');
    mkdirSync(hooks, {recursive: true});
    for (const name of ['pre-commit', 'post-commit']) {
      writeFileSync(path.join(hooks, name), `#!/bin/sh\ntouch "${marker}-${name}"\n`, {mode: 0o755});
    }
  });
  afterAll(() => rmSync(base, {recursive: true, force: true}));

  it('the synthetic hook can execute and write its marker', () => {
    for (const name of ['pre-commit', 'post-commit']) {
      execFileSync(path.join(dir, '.git/hooks', name), [], {cwd: dir, timeout: 2000, maxBuffer: 1024});
      expect(existsSync(path.join(dir, `${marker}-${name}`))).toBe(true);
      rmSync(path.join(dir, `${marker}-${name}`));
    }
  });

  it("NEUTRALISES the repository's hooks (core.hooksPath=/dev/null)", async () => {
    writeFileSync(path.join(dir, 'canary.txt'), 'Synthetic change\n');
    expect((await gitCommitAll(dir, 'Synthetic snapshot through the rail')).committed).toBe(true);
    expect(existsSync(path.join(dir, `${marker}-pre-commit`))).toBe(false);
    expect(existsSync(path.join(dir, `${marker}-post-commit`))).toBe(false);
    expect((await gitStatus(dir)).dirtyCount).toBe(0);
  });

  it('refuses a relative cwd and a non-string argument', () => {
    expect(() => runGit('relative/path', ['status'])).toThrow(/absolute path/);
    expect(() => runGit(dir, ['status', 5])).toThrow(/array of strings/);
  });

  it('overrides a repository filesystem monitor on every invocation', async () => {
    await git(dir, 'config', 'core.fsmonitor', 'true');
    const result = await runGit(dir, ['config', '--get', 'core.fsmonitor']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('false');
    expect((await gitStatus(dir)).branch).toBe('main');
  });

  it('never lets a path argument reach a flag position', () => {
    expect(() => assertPathArg('--output=synthetic')).toThrow(/dash/);
    expect(() => assertPathArg('/synthetic/outside')).toThrow(/repository-relative/);
    expect(() => assertPathArg('../../synthetic/outside')).toThrow(/escapes/);
    expect(() => assertPathArg('src/a\0b')).toThrow(/NUL/);
    expect(assertPathArg('./src/index.ts')).toBe('src/index.ts');
  });

  it('refuses unsafe ref names before they become arguments', () => {
    for (const value of ['--upload-pack=synthetic', 'a b', 'main..HEAD']) expect(() => assertRefArg(value)).toThrow(/unsafe ref/);
    expect(assertRefArg('node/peer-b')).toBe('node/peer-b');
  });

  it('caps output and reports truncation', async () => {
    const result = await runGit(dir, ['log', '--format=%H%n%s'], {cap: 32});
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(32);
    expect(result.truncated).toBe(true);
  });

  it('parses porcelain v2 without making the UI parse it', () => {
    const snapshot = parsePorcelainV2([
      '# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts', '? untracked.txt'
    ].join('\n'));
    expect(snapshot).toMatchObject({branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3});
    expect(snapshot.dirty.map((entry: {path: string}) => entry.path)).toEqual(['src/a.ts', 'new.ts', 'conflict.ts', 'untracked.txt']);
    expect(snapshot.dirty[1]).toMatchObject({xy: 'R.', from: 'old.ts'});
    expect(snapshot.dirty[2].xy).toBe('UU');
  });
});

describe('status and diff on a synthetic repository pair', () => {
  let base: string, a: string, b: string;
  beforeAll(async () => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'projects-git-pair-')));
    a = await initRepo(path.join(base, 'alpha'));
    const origin = await initBare(a, path.join(base, 'origin.git'));
    await git(a, 'remote', 'add', '--', 'origin', origin);
    await git(a, 'push', '--quiet', '--set-upstream', 'origin', 'main');
    b = await cloneOf(a, origin, path.join(base, 'beta'));
  });
  afterAll(() => rmSync(base, {recursive: true, force: true}));

  it('reports a clean tree with an upstream and no divergence', async () => {
    expect(await gitStatus(b)).toMatchObject({branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirtyCount: 0, mergeInProgress: false});
  });
  it('counts local commits as ahead', async () => {
    await commitFile(b, 'beta-only.txt', 'Synthetic beta work\n', 'Synthetic beta snapshot');
    expect(await gitStatus(b)).toMatchObject({ahead: 1, behind: 0});
  });
  it('does NOT fetch implicitly: behind stays zero until fetch is requested', async () => {
    await commitFile(a, 'alpha-only.txt', 'Synthetic alpha work\n', 'Synthetic alpha snapshot');
    await git(a, 'push', '--quiet', 'origin', 'main');
    expect((await gitStatus(b)).behind).toBe(0);
    expect((await gitFetch(b)).ok).toBe(true);
    expect(await gitStatus(b)).toMatchObject({behind: 1, ahead: 1});
  });
  it('lists modified and untracked files with derived states and staging', async () => {
    writeFileSync(path.join(b, 'README.md'), '# Synthetic modified heading\n');
    writeFileSync(path.join(b, 'scratch.txt'), 'Synthetic untracked work\n');
    expect((await gitStatus(b)).dirty).toEqual(expect.arrayContaining([
      expect.objectContaining({path: 'README.md', xy: '.M', state: 'modified', staged: false}),
      expect.objectContaining({path: 'scratch.txt', xy: '??', state: 'untracked', staged: false})
    ]));
    await git(b, 'add', '--', 'README.md');
    expect((await gitStatus(b)).dirty).toEqual(expect.arrayContaining([expect.objectContaining({path: 'README.md', xy: 'M.', staged: true})]));
    await git(b, 'commit', '-m', 'Synthetic staged snapshot');
    rmSync(path.join(b, 'scratch.txt'));
  });
  it('sees a merge in progress', async () => {
    await commitFile(a, 'shared.txt', 'Synthetic alpha side\n', 'Synthetic alpha shared line');
    await git(a, 'push', '--quiet', 'origin', 'main');
    await commitFile(b, 'shared.txt', 'Synthetic beta side\n', 'Synthetic beta shared line');
    await gitFetch(b);
    await expect(git(b, 'merge', '--no-ff', 'origin/main')).rejects.toThrow();
    expect(await gitStatus(b)).toMatchObject({mergeInProgress: true, inProgress: ['merge']});
    expect((await gitStatus(b)).dirty).toEqual(expect.arrayContaining([expect.objectContaining({path: 'shared.txt', state: 'conflict'})]));
    await git(b, 'merge', '--abort');
  });
  it('caps a large diff and says so', async () => {
    await commitFile(b, 'big.txt', 'Synthetic seed\n', 'Synthetic large file seed');
    writeFileSync(path.join(b, 'big.txt'), `${'x'.repeat(DIFF_CAP_BYTES + 200_000)}\n`);
    const diff = await gitDiff(b, {relPath: 'big.txt'});
    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.diff)).toBeLessThanOrEqual(DIFF_CAP_BYTES);
    await git(b, 'checkout', '--', 'big.txt');
  });
  it('REFUSES to diff a binary file rather than answering with a placeholder', async () => {
    await commitFile(b, 'logo.bin', Buffer.from([0, 1, 2]), 'Synthetic binary seed');
    writeFileSync(path.join(b, 'logo.bin'), Buffer.from([0, 1, 3, 255]));
    await expect(gitDiff(b, {relPath: 'logo.bin'})).rejects.toThrow(/binary/);
    expect((await gitDiff(b)).binary).toContain('logo.bin');
    await git(b, 'checkout', '--', 'logo.bin');
  });
  it('clamps the log limit and returns structured commits', async () => {
    const log = await gitLog(b, {limit: 99999});
    expect(log.limit).toBe(200);
    expect(log.commits[0]).toMatchObject({author: 'Synthetic Author'});
    expect(log.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await gitLog(b, {limit: 1})).commits).toHaveLength(1);
  });
});

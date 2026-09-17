import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {resolveProjectName} from '../src/lib/dev-root';
import {seedProject} from './projects-fixture';
// @ts-ignore The package is exercised directly as ESM.
import {runGit} from '../packages/projects/src/git.mjs';

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const resolved = resolveProjectName(path.basename(cwd), {devRoot: path.dirname(cwd)});
  if (!resolved) throw new Error('Synthetic project did not resolve');
  const result = await runGit(resolved, args, {timeoutMs: 30_000, cap: 1024 * 1024});
  if (result.code) throw new Error(result.stderr || result.stdout || `git exited ${result.code}`);
  return result.stdout;
}

export async function initRepo(dir: string) {
  return seedProject(path.dirname(dir), path.basename(dir), {'README.md': '# Synthetic project\n'});
}

export async function initBare(cwd: string, dir: string) {
  await git(cwd, 'init', '--bare', '--quiet', '--initial-branch=main', '--', dir);
  return dir;
}

export async function cloneOf(cwd: string, origin: string, dir: string) {
  mkdirSync(path.dirname(dir), {recursive: true});
  await git(cwd, 'clone', '--quiet', '--', origin, dir);
  const root = resolveProjectName(path.basename(dir), {devRoot: path.dirname(dir)});
  if (!root) throw new Error('Synthetic clone did not resolve');
  await git(root, 'config', 'user.email', 'fixture@example.test');
  await git(root, 'config', 'user.name', 'Synthetic Author');
  await git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

export async function commitFile(cwd: string, rel: string, body: string | Buffer, message: string) {
  mkdirSync(path.dirname(path.join(cwd, rel)), {recursive: true});
  writeFileSync(path.join(cwd, rel), body);
  await git(cwd, 'add', '-A', '--', rel);
  await git(cwd, 'commit', '--quiet', '-m', message);
}

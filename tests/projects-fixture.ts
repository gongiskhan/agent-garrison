import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveProjectName} from '@/lib/dev-root';
// @ts-ignore The same ESM rail is used by the app and synthetic repositories.
import {runGit} from '../packages/projects/src/git.mjs';

export async function seedProject(devRoot: string, project: string, files: Record<string, string | Buffer> = {'readme.md': '# Synthetic project\n'}) {
  const root = path.join(devRoot, project);
  await fs.mkdir(path.join(root, '.git'), {recursive: true});
  const resolved = resolveProjectName(project, {devRoot});
  if (!resolved) throw new Error('Synthetic project did not resolve');
  const execute = async (args: string[]) => {
    const result = await runGit(resolved, args, {timeoutMs: 20_000, cap: 64 * 1024});
    if (result.code || result.truncated) throw new Error(result.stderr || 'Synthetic git command failed');
  };
  await execute(['init', '--quiet', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Projects Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false']]) await execute(['config', key, value]);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(resolved, name)), {recursive: true});
    await fs.writeFile(path.join(resolved, name), content);
  }
  await execute(['add', '--', '.']);
  await execute(['commit', '--quiet', '-m', 'Synthetic initial snapshot']);
  return resolved;
}

import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir, rename, unlink, writeFile} from 'node:fs/promises';
import {HttpError, MAX_TEXT_BYTES, assertWriteInRoot, relativePath, resolveInRoot, tree, read} from './fs.mjs';

export function workspaceRoot(env = process.env) {
  let root = env.GARRISON_FILEBROWSER_ROOT || path.join(env.GARRISON_HOME || path.join(os.homedir(), '.garrison'), 'files');
  if (root === '~') root = os.homedir();
  else if (root.startsWith('~/')) root = path.join(os.homedir(), root.slice(2));
  return path.resolve(root);
}

export function createWorkspace(root) {
  const scope = {root, source: 'workspace', writable: true};
  let ready;
  const initialize = () => ready ??= (async () => {
    await mkdir(root, {recursive: true});
    for (const name of ['documents', 'recordings', 'runs', 'uploads']) {
      const target = await assertWriteInRoot(root, resolveInRoot(root, name));
      await mkdir(target, {recursive: true});
    }
  })().catch(error => {ready = undefined; throw error;});
  return {
    root,
    initialize,
    async tree(rel) {await initialize(); return tree(scope, rel);},
    async read(rel) {await initialize(); return read(scope, rel);},
    async write(value, content, encoding = 'utf8') {
      await initialize();
      const rel = relativePath(value);
      if (!rel) throw new HttpError(400, 'path required');
      if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
      if (!['utf8', 'base64'].includes(encoding)) throw new HttpError(400, 'invalid encoding');
      const data = Buffer.from(content, encoding);
      if (data.length > MAX_TEXT_BYTES) throw new HttpError(413, 'content too large');
      const abs = await assertWriteInRoot(root, resolveInRoot(root, rel));
      const parent = path.dirname(abs);
      await mkdir(parent, {recursive: true});
      await assertWriteInRoot(root, resolveInRoot(root, rel));
      const temp = path.join(parent, `.garrison-projects-${randomUUID()}`);
      try {
        await writeFile(temp, data, {flag: 'wx', mode: 0o600});
        await rename(temp, abs);
      } finally {
        await unlink(temp).catch(error => {if (error.code !== 'ENOENT') throw error;});
      }
      return {ok: true, path: rel};
    },
    async mkdir(value) {
      await initialize();
      const rel = relativePath(value);
      if (!rel) throw new HttpError(400, 'path required');
      const abs = await assertWriteInRoot(root, resolveInRoot(root, rel));
      await mkdir(abs, {recursive: true});
      return {ok: true, path: rel};
    }
  };
}

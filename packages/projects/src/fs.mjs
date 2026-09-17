import path from 'node:path';
import {constants} from 'node:fs';
import {lstat, open, readdir, realpath, stat} from 'node:fs/promises';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const SENSITIVE = [
  /(^|\/)vault\.json$/i,
  /(^|\/)internal-token$/i,
  /(^|\/)\.env[^/]*(\/|$)/i,
  /\.(key|pem|crt|p12|pfx)$/i,
  /(^|\/)id_rsa[^/]*(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)(credentials\.json|\.netrc|\.npmrc)(\/|$)/i
];

export class HttpError extends Error {
  constructor(status, message, fields = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.fields = fields;
  }
}

export function isSensitive(rel) {
  return SENSITIVE.some(pattern => pattern.test(rel.replace(/\\/g, '/')));
}

export function relativePath(value = '') {
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value)
    || path.win32.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new HttpError(403, 'path escapes workspace root');
  }
  const rel = path.posix.normalize(value.replace(/\\/g, '/'));
  return rel === '.' ? '' : rel.replace(/\/$/, '');
}

export function resolveInRoot(root, rel) {
  const clean = relativePath(rel);
  if (isSensitive(clean)) throw new HttpError(403, 'file not browsable');
  const abs = path.resolve(root, clean);
  assertContained(path.resolve(root), abs);
  return abs;
}

function assertContained(root, target) {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new HttpError(403, 'path escapes workspace root');
  }
}

export async function assertRealInRoot(root, abs) {
  const rootReal = await realpath(root);
  const actual = await realpath(abs);
  assertContained(rootReal, actual);
  if (isSensitive(path.relative(rootReal, actual))) throw new HttpError(403, 'file not browsable');
  return actual;
}

// Every existing parent must be an ordinary directory. This also refuses an
// in-root directory symlink, so writes never follow a mutable parent alias.
export async function assertWriteInRoot(root, abs) {
  const rootReal = await realpath(root);
  const rel = path.relative(path.resolve(root), abs);
  assertContained(path.resolve(root), abs);
  let current = rootReal;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new HttpError(403, 'path escapes workspace root');
      await assertRealInRoot(rootReal, current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return path.join(rootReal, rel);
}

export function kindFor(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXT.has(ext) ? 'image' : ['.md', '.markdown'].includes(ext) ? 'markdown' : 'text';
}

export async function tree(scope, value = '') {
  const rel = relativePath(value), abs = resolveInRoot(scope.root, rel);
  await assertRealInRoot(scope.root, abs);
  const entries = await readdir(abs, {withFileTypes: true});
  const items = [];
  for (const entry of entries) {
    const child = path.posix.join(rel, entry.name);
    if (isSensitive(child)) continue;
    try {
      const target = resolveInRoot(scope.root, child);
      await assertRealInRoot(scope.root, target);
      const info = await stat(target);
      if (!info.isFile() && !info.isDirectory()) continue;
      items.push({name: entry.name, path: child, type: info.isDirectory() ? 'dir' : 'file', size: info.isFile() ? info.size : 0});
    } catch {
      // A vanished or refused child is not offered as an openable file.
    }
  }
  items.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  return {source: scope.source, path: rel, writable: scope.writable === true, items};
}

export async function read(scope, value) {
  const rel = relativePath(value), abs = resolveInRoot(scope.root, rel);
  await assertRealInRoot(scope.root, abs);
  let handle;
  try {
    handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EMLINK') throw new HttpError(403, 'path escapes workspace root');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new HttpError(400, 'not a file');
    if (info.size > MAX_TEXT_BYTES) throw new HttpError(413, 'file too large to open in the browser', {size: info.size});
    const kind = kindFor(rel), encoding = kind === 'image' ? 'base64' : 'utf8';
    const content = (await handle.readFile()).toString(encoding);
    return {path: rel, kind, encoding, content, ...(kind === 'image' ? {ext: path.extname(rel).slice(1)} : {}), readOnly: !scope.writable};
  } finally {
    await handle.close();
  }
}

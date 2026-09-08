import { lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import path from "node:path";

/** A literal component, never a traversal or a filename supplied as a path. */
export function pathId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(value)) {
    throw new Error("invalid viewer identifier");
  }
  return value;
}

export function relativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") ||
      path.isAbsolute(value) || value.split("/").includes("..")) throw new Error("path must stay inside the repo");
  return value.split("/").filter(component => component && component !== ".").join("/") || ".";
}

/** Refuse every symlink below the explicitly selected root, including dangling ones.
 * Checking existing ancestors also confines writes whose final file is still absent.
 */
export function confinedPath(root, relative) {
  const rel = relativePath(relative);
  const base = path.resolve(root);
  let at = base;
  for (const component of rel.split("/")) {
    if (!component || component === ".") continue;
    at = path.join(at, component);
    try {
      if (lstatSync(at).isSymbolicLink()) throw new Error("symlinks are not permitted in viewer paths");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return at;
}

export function canonicalRoot(root) { return realpathSync(path.resolve(root)); }

/** Bounded regular-file read; never follows a replaced final symlink or a FIFO. */
export function readRegularText(file, limit = 8 * 1024 * 1024) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("viewer file limit exceeded");
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > limit) throw new Error("viewer file limit exceeded");
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally { closeSync(fd); }
}

/** Synchronous reader used by the bounded static/import scans. */
export function readRepoText(root, relative) {
  try { return readRegularText(confinedPath(root, relative)); }
  catch { return null; }
}

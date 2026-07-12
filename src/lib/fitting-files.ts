import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "./paths";
import { getLibraryEntry } from "./library";
import type { LibraryEntry } from "./types";

const HIDDEN_NAMES = new Set(["node_modules", "apm_modules", ".git", ".DS_Store"]);
const BLOCKED_SEGMENTS = new Set(["node_modules", "apm_modules", ".git", ".apm"]);
const MAX_READ_BYTES = 1_048_576;

export interface FittingFilesError {
  status: number;
  message: string;
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
}

export interface FileContents {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  size: number;
}

export class FittingFileError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function resolveLocalFitting(id: string): Promise<{ entry: LibraryEntry; root: string }> {
  const entry = await getLibraryEntry(id);
  if (!entry) {
    throw new FittingFileError(404, `Unknown fitting: ${id}`);
  }
  if (!entry.localPath) {
    throw new FittingFileError(404, `Fitting ${id} is not local`);
  }
  const root = path.resolve(ROOT_DIR, entry.localPath);
  return { entry, root };
}

function safeResolve(root: string, userPath: string): string {
  const normalized = (userPath ?? "").replace(/^\/+/, "");
  const joined = path.resolve(root, normalized);
  if (joined !== root && !joined.startsWith(`${root}${path.sep}`)) {
    throw new FittingFileError(400, "Path escapes the fitting directory");
  }
  return joined;
}

function rejectBlockedSegments(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === "") return;
  const segments = relative.split(path.sep);
  for (const segment of segments) {
    if (BLOCKED_SEGMENTS.has(segment)) {
      throw new FittingFileError(400, `Path includes a blocked segment: ${segment}`);
    }
  }
}

// safeResolve is LEXICAL only, so a real symlink INSIDE the fitting (e.g.
// `out -> /tmp/outside`, which a crafted source could carry) would let a
// lexically-contained path write THROUGH the link to outside the root. Resolve
// the realpath of the deepest EXISTING ancestor of the target and require it to
// stay within the realpath'd root. The not-yet-existing tail is created later as
// real dirs (mkdir never traverses a symlink it just made), so only the existing
// ancestor chain can smuggle in a symlink — and realpath collapses that chain.
async function assertNoSymlinkEscape(root: string, target: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let ancestor = target;
  for (;;) {
    let real: string;
    try {
      real = await fs.realpath(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return; // hit fs root without an existing symlink
        ancestor = parent;
        continue;
      }
      throw error;
    }
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
      throw new FittingFileError(400, "Path escapes the fitting directory (symlinked ancestor)");
    }
    return;
  }
}

export async function listDirectory(id: string, userPath = ""): Promise<DirectoryListing> {
  const { root } = await resolveLocalFitting(id);
  const target = safeResolve(root, userPath);
  // Read-side containment: a crafted Fitting could carry a symlink `out -> /etc`
  // that safeResolve (lexical) admits; realpath the ancestor chain so a listing
  // never escapes the fitting root the way the write paths already guard.
  await assertNoSymlinkEscape(root, target);

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new FittingFileError(404, "Directory not found");
  }
  if (!stat.isDirectory()) {
    throw new FittingFileError(400, "Path is not a directory");
  }

  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (HIDDEN_NAMES.has(dirent.name)) continue;
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, type: "dir" });
    } else if (dirent.isFile()) {
      let size: number | undefined;
      try {
        const fileStat = await fs.stat(path.join(target, dirent.name));
        size = fileStat.size;
      } catch {
        size = undefined;
      }
      entries.push({ name: dirent.name, type: "file", size });
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: path.relative(root, target).split(path.sep).join("/"), entries };
}

function isLikelyUtf8(buffer: Buffer): boolean {
  // Treat anything with NUL bytes as binary; otherwise round-trip via utf8.
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) return false;
  }
  const text = buffer.toString("utf8");
  return Buffer.byteLength(text, "utf8") === buffer.length;
}

export async function readFile(id: string, userPath: string): Promise<FileContents> {
  if (!userPath) {
    throw new FittingFileError(400, "path is required");
  }
  const { root } = await resolveLocalFitting(id);
  const target = safeResolve(root, userPath);
  // Read-side containment: without this a Fitting-carried symlink `leak.md ->
  // /etc/passwd` would pass the lexical safeResolve and fs.readFile would follow
  // it off-root. Match the write paths' realpath guard.
  await assertNoSymlinkEscape(root, target);

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new FittingFileError(404, "File not found");
  }
  if (!stat.isFile()) {
    throw new FittingFileError(400, "Path is not a file");
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new FittingFileError(413, `File is larger than ${MAX_READ_BYTES} bytes`);
  }

  const buffer = await fs.readFile(target);
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (isLikelyUtf8(buffer)) {
    return { path: relative, content: buffer.toString("utf8"), encoding: "utf8", size: stat.size };
  }
  return { path: relative, content: buffer.toString("base64"), encoding: "base64", size: stat.size };
}

export async function writeFile(id: string, userPath: string, content: string): Promise<{ path: string; size: number }> {
  if (!userPath) {
    throw new FittingFileError(400, "path is required");
  }
  if (typeof content !== "string") {
    throw new FittingFileError(400, "content must be a string");
  }
  const { root } = await resolveLocalFitting(id);
  const target = safeResolve(root, userPath);
  rejectBlockedSegments(root, target);
  await assertNoSymlinkEscape(root, target);

  let existing;
  try {
    existing = await fs.stat(target);
  } catch {
    throw new FittingFileError(404, "File does not exist (this endpoint does not create new files)");
  }
  if (!existing.isFile()) {
    throw new FittingFileError(400, "Path is not a file");
  }

  await fs.writeFile(target, content, "utf8");
  const after = await fs.stat(target);
  const relative = path.relative(root, target).split(path.sep).join("/");
  return { path: relative, size: after.size };
}

// Create a NEW file inside a fitting (the counterpart to the overwrite-only
// writeFile). Same path-escape + blocked-segment guards, but it REQUIRES the
// target not already exist and creates any missing parent directories within
// the fitting root. Editing an existing file still goes through writeFile.
export async function createFile(
  id: string,
  userPath: string,
  content: string
): Promise<{ path: string; size: number }> {
  if (!userPath) {
    throw new FittingFileError(400, "path is required");
  }
  if (typeof content !== "string") {
    throw new FittingFileError(400, "content must be a string");
  }
  const { root } = await resolveLocalFitting(id);
  const target = safeResolve(root, userPath);
  if (target === root) {
    throw new FittingFileError(400, "path is required");
  }
  rejectBlockedSegments(root, target);
  await assertNoSymlinkEscape(root, target);

  let existing;
  try {
    existing = await fs.lstat(target);
  } catch {
    existing = null;
  }
  if (existing) {
    throw new FittingFileError(409, "File already exists (use the overwrite endpoint to edit it)");
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  const after = await fs.stat(target);
  const relative = path.relative(root, target).split(path.sep).join("/");
  return { path: relative, size: after.size };
}

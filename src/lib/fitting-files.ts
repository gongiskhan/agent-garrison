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

export async function listDirectory(id: string, userPath = ""): Promise<DirectoryListing> {
  const { root } = await resolveLocalFitting(id);
  const target = safeResolve(root, userPath);

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

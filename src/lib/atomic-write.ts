import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Crash-safe, torn-read-safe file writes for the host-config surface.
//
// Garrison writes ~/.claude files immediately (no save buttons) and a narrow
// watcher may read settings.json the instant a write lands. A naive
// fs.writeFile truncates-then-writes, so a concurrent reader can catch an empty
// or partial file, and a crash mid-write loses the old contents. These helpers
// remove both hazards.

export interface AtomicWriteOpts {
  encoding?: BufferEncoding;
  mode?: number;
}

// Write `data` to `absPath` atomically: write a sibling temp file on the SAME
// filesystem as the (symlink-resolved) destination, fsync it, then rename over
// the target. rename(2) is atomic within a filesystem — a concurrent reader sees
// either the old complete file or the new complete file, never a torn one, and a
// crash leaves the previous file intact. Writing through a symlinked directory
// deploys into the real target (matching APM's verified `.claude` symlink
// write-through) while leaving the link itself intact.
export async function writeFileAtomic(
  absPath: string,
  data: string | Buffer,
  opts: AtomicWriteOpts = {}
): Promise<void> {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  // Resolve symlinks in the directory so the temp file lands on the same device
  // as the final file — a cross-device rename would fail with EXDEV.
  const realDir = await fs.realpath(dir);
  const base = path.basename(absPath);
  const finalPath = path.join(realDir, base);
  const tmpPath = path.join(
    realDir,
    `.${base}.garrison-tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  );

  const fh = await fs.open(tmpPath, "w", opts.mode ?? 0o644);
  try {
    await fh.writeFile(data, { encoding: opts.encoding ?? "utf8" });
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

// Convenience: pretty-print + atomic-write a JSON document (trailing newline, the
// shape Claude Code itself writes).
export async function writeJsonAtomic(
  absPath: string,
  value: unknown,
  opts: AtomicWriteOpts = {}
): Promise<void> {
  await writeFileAtomic(absPath, `${JSON.stringify(value, null, 2)}\n`, opts);
}

export interface TolerantReadResult {
  exists: boolean;
  text: string;
}

export interface TolerantReadOpts {
  retries?: number;
  delayMs?: number;
  // Throw to signal the read is incomplete and should be retried — e.g. pass
  // `(t) => JSON.parse(t)` so a watcher that fires mid-write retries instead of
  // surfacing a truncated, unparseable read.
  validate?: (text: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Read a file that another writer may be replacing concurrently. ENOENT
// short-circuits to {exists:false}. On a read error or a `validate` failure,
// retry with linear backoff. After exhausting retries, return the last raw read
// if we got one (the bytes are real even if validation never passed), else
// rethrow.
export async function readFileTolerant(
  absPath: string,
  opts: TolerantReadOpts = {}
): Promise<TolerantReadResult> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 15;
  let lastText: string | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await fs.readFile(absPath, "utf8");
      lastText = text;
      if (opts.validate) opts.validate(text); // throws -> retry
      return { exists: true, text };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, text: "" };
      }
      lastErr = err;
      if (attempt < retries) await sleep(delayMs * (attempt + 1));
    }
  }
  if (lastText !== null) return { exists: true, text: lastText };
  throw lastErr;
}

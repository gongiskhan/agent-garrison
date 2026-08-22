// The up() fast path's change detector (Garrison-improvements card, item 3).
//
// A full `up` spends its minutes in `apm install`, per-fitting setup hooks and
// verify hooks — work that only tells us something new when the COMPOSITION
// changed. The fingerprint captures everything those steps depend on: the
// manifest, the machine-local overlay, the lockfile, and every path-dependency
// fitting's source tree (newest mtime + file count + byte total, skipping
// build artifacts). Same fingerprint + a previously successful verified up =
// the expensive steps are provably redundant and may be skipped; ANY change
// takes the full path exactly as before.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "apm_modules", ".next", "__pycache__"]);

interface TreeStat {
  newestMtimeMs: number;
  files: number;
  bytes: number;
}

async function scanTree(dir: string, stat: TreeStat): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await scanTree(path.join(dir, entry.name), stat);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const st = await fsp.stat(path.join(dir, entry.name));
      stat.files += 1;
      stat.bytes += st.size;
      if (st.mtimeMs > stat.newestMtimeMs) stat.newestMtimeMs = st.mtimeMs;
    } catch { /* raced deletion — the next up refingerprints */ }
  }
}

async function fileContent(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** Relative `path:` dependencies from the composition's apm.yml. */
function pathDependencies(apmYml: string): string[] {
  const deps: string[] = [];
  for (const line of apmYml.split("\n")) {
    const m = line.match(/^\s*-\s*path:\s*(\S+)\s*$/);
    if (m) deps.push(m[1]);
  }
  return deps;
}

export async function compositionFingerprint(compositionDir: string): Promise<string> {
  const hash = createHash("sha256");
  const apmYml = await fileContent(path.join(compositionDir, "apm.yml"));
  hash.update(apmYml);
  hash.update("\0");
  hash.update(await fileContent(path.join(compositionDir, "local.yml")));
  hash.update("\0");
  hash.update(await fileContent(path.join(compositionDir, "apm.lock.yaml")));
  for (const dep of pathDependencies(apmYml)) {
    const dir = path.resolve(compositionDir, dep);
    const stat: TreeStat = { newestMtimeMs: 0, files: 0, bytes: 0 };
    await scanTree(dir, stat);
    hash.update(`\0${dep}:${Math.trunc(stat.newestMtimeMs)}:${stat.files}:${stat.bytes}`);
  }
  return hash.digest("hex");
}

export interface LastUpRecord {
  fingerprint: string;
  at: string;
  ok: boolean;
  /** The verify results the fingerprinted state actually produced, replayed
   *  into the runner state on the fast path so the UI stays truthful. */
  verifyResults?: unknown[];
}

function lastUpPath(compositionDir: string): string {
  return path.join(compositionDir, ".garrison", "last-up.json");
}

export async function readLastUp(compositionDir: string): Promise<LastUpRecord | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(lastUpPath(compositionDir), "utf8"));
    return parsed && typeof parsed.fingerprint === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeLastUp(
  compositionDir: string,
  record: LastUpRecord
): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(lastUpPath(compositionDir)), { recursive: true });
    await fsp.writeFile(lastUpPath(compositionDir), JSON.stringify(record, null, 2));
  } catch { /* best-effort — a missing record just means the next up is full */ }
}

// json-log.mjs - shared tolerant JSON-array log-file helper. Used by the
// ecosystem-update and reapply-sweep phases so a full-disk/permissions failure
// on the final persistence write degrades to a logged console.error rather
// than breaking either phase's "never throws" contract.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export function defaultStateDir() {
  return process.env.IMPROVER_DATA || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "improver");
}

export async function loadJsonLog(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Never throws - a write failure (full disk, EACCES, EROFS) is logged to
// stderr and swallowed.
export async function saveJsonLog(file, entries) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(entries, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error(`json-log: failed to persist ${file}: ${err?.message || err}`);
  }
}

// Load, push, save in one call - the common "append one entry" pattern.
export async function appendJsonLog(file, entry) {
  const log = await loadJsonLog(file);
  log.push(entry);
  await saveJsonLog(file, log);
  return log;
}

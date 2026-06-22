// archive.mjs — reversible move/unmove of a skill directory (v1). archiveSkill
// moves <claudeHome>/skills/<name> -> <dataDir>/archived/<name> and records it
// in archived.json; unarchiveSkill copies it back. Both use fs.cp + fs.rm
// (copy-then-remove, copy VERIFIED before the live dir is removed) so the move
// is reversible and the off-disk copy is never destroyed. GARRISON_CLAUDE_HOME
// sandboxes the source in tests, so this mutates nothing real.

import { cp, rm, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export function skillsDirOf(claudeHome) {
  return path.join(claudeHome, "skills");
}

async function readIndex(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function writeIndex(file, idx) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(idx, null, 2) + "\n", "utf8");
}

// Move <claudeHome>/skills/<name> -> <dataDir>/archived/<name>.
export async function archiveSkill(name, { claudeHome, dataDir, now = null } = {}) {
  const src = path.join(skillsDirOf(claudeHome), name);
  const dest = path.join(dataDir, "archived", name);
  const indexFile = path.join(dataDir, "archived.json");
  if (!existsSync(src)) return { ok: false, reason: "source-missing", src };

  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true }); // clean stale archive of same name
  await cp(src, dest, { recursive: true });
  await stat(dest); // verify the copy landed before removing the live dir
  await rm(src, { recursive: true, force: true });

  const idx = await readIndex(indexFile);
  idx[name] = { archivedAt: now || new Date().toISOString(), from: src, to: dest };
  await writeIndex(indexFile, idx);
  return { ok: true, from: src, to: dest };
}

// Copy <dataDir>/archived/<name> back to <claudeHome>/skills/<name>. The
// off-disk archived copy is left in place (never destroyed).
export async function unarchiveSkill(name, { claudeHome, dataDir } = {}) {
  const src = path.join(dataDir, "archived", name);
  const dest = path.join(skillsDirOf(claudeHome), name);
  const indexFile = path.join(dataDir, "archived.json");
  if (!existsSync(src)) return { ok: false, reason: "archive-missing", src };

  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
  await stat(dest);

  const idx = await readIndex(indexFile);
  delete idx[name];
  await writeIndex(indexFile, idx);
  return { ok: true, from: src, to: dest, restored: true };
}

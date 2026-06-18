// snapshot.mjs — byte snapshot/restore of a single SKILL.md (v1). Before any
// apply, snapshotSkill copies the live SKILL.md into
// <dataDir>/snapshots/<name>/<id>.SKILL.md plus a <id>.meta.json {sha, at}. If a
// post-apply gate fails, restoreSkill writes the snapshot back and reports
// whether the restored bytes match the snapshot sha — byte-identical rollback.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function shaOf(content) {
  return `sha256:${createHash("sha256").update(content ?? "").digest("hex")}`;
}

export function skillMdPath(claudeHome, name) {
  return path.join(claudeHome, "skills", name, "SKILL.md");
}

// Copy the live SKILL.md into the snapshot store. A not-yet-existing target
// snapshots as empty (sha of "").
export async function snapshotSkill(name, id, { claudeHome, dataDir } = {}) {
  const live = skillMdPath(claudeHome, name);
  let content = "";
  try {
    content = await readFile(live, "utf8");
  } catch {
    content = "";
  }
  const dir = path.join(dataDir, "snapshots", name);
  await mkdir(dir, { recursive: true });
  const snapPath = path.join(dir, `${id}.SKILL.md`);
  await writeFile(snapPath, content, "utf8");
  const sha = shaOf(content);
  await writeFile(
    path.join(dir, `${id}.meta.json`),
    JSON.stringify({ name, id, sha, live, at: new Date().toISOString() }, null, 2) + "\n",
    "utf8"
  );
  return { path: snapPath, sha, live };
}

// Restore a snapshot back over the live SKILL.md. Returns { restored, sha,
// matches } — `matches` is true when the restored file's sha equals the recorded
// snapshot sha (proves byte-identical rollback).
export async function restoreSkill(name, id, { claudeHome, dataDir } = {}) {
  const dir = path.join(dataDir, "snapshots", name);
  const snapPath = path.join(dir, `${id}.SKILL.md`);
  if (!existsSync(snapPath)) return { restored: false, reason: "snapshot-missing", path: snapPath };

  const snapContent = await readFile(snapPath, "utf8");
  const live = skillMdPath(claudeHome, name);
  await mkdir(path.dirname(live), { recursive: true });
  await writeFile(live, snapContent, "utf8");

  const back = await readFile(live, "utf8");
  const sha = shaOf(back);
  let snapSha = shaOf(snapContent);
  try {
    const meta = JSON.parse(await readFile(path.join(dir, `${id}.meta.json`), "utf8"));
    if (meta && typeof meta.sha === "string") snapSha = meta.sha;
  } catch {
    /* use computed snapSha */
  }
  return { restored: true, sha, matches: sha === snapSha, path: snapPath };
}

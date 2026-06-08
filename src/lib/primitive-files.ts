import fs from "node:fs/promises";
import path from "node:path";
import { claudeHome } from "./claude-home";
import { writeFileAtomic } from "./atomic-write";

// Writer-of-record for the loose file primitives Garrison owns directly:
//   skill   -> skills/<name>/SKILL.md   (a dir with a SKILL.md)
//   command -> commands/<name>.md
//   rule    -> rules/<name>.md
//
// The writer-of-record invariant (see FLOW_PLAN): Garrison freely creates/edits/
// deletes LOOSE files. For an APM-OWNED file, editing is honest drift (allowed +
// surfaced) but deleting is BLOCKED — the caller must Park it (so the lock never
// lies). This module is a pure writer; the owned/loose decision is enforced by
// the quarters dispatch, which reads the state model before delete.

export type FilePrimitiveSurface = "skill" | "command" | "rule";

export interface FilePrimitiveResult {
  ok: boolean;
  id?: string;
  code?: "exists" | "not-found" | "invalid";
  error?: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function relPathFor(surface: FilePrimitiveSurface, name: string): string {
  switch (surface) {
    case "skill":
      return `skills/${name}/SKILL.md`;
    case "command":
      return `commands/${name}.md`;
    case "rule":
      return `rules/${name}.md`;
  }
}

// The path we delete: a skill is a whole dir; commands/rules are single files.
function deleteTargetRel(surface: FilePrimitiveSurface, name: string): string {
  return surface === "skill" ? `skills/${name}` : relPathFor(surface, name);
}

function absFor(home: string, rel: string): string {
  return path.join(home, rel);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function validateName(name: string): string | null {
  if (!name || !name.trim()) return "name is required";
  if (!NAME_RE.test(name)) return "name may contain only letters, digits, dot, dash, underscore (no slashes)";
  return null;
}

export interface FilePrimitiveRead {
  exists: boolean;
  content: string;
  path: string; // claudeHome-relative
}

export async function readFilePrimitive(
  surface: FilePrimitiveSurface,
  name: string,
  home: string = claudeHome()
): Promise<FilePrimitiveRead> {
  const rel = relPathFor(surface, name);
  const abs = absFor(home, rel);
  try {
    const content = await fs.readFile(abs, "utf8");
    return { exists: true, content, path: rel };
  } catch {
    return { exists: false, content: "", path: rel };
  }
}

export async function createFilePrimitive(
  surface: FilePrimitiveSurface,
  name: string,
  content: string,
  home: string = claudeHome()
): Promise<FilePrimitiveResult> {
  const err = validateName(name);
  if (err) return { ok: false, code: "invalid", error: err };
  const rel = relPathFor(surface, name);
  const abs = absFor(home, rel);
  // A skill collides if its DIR exists; a command/rule if the .md exists.
  const collisionAbs = absFor(home, deleteTargetRel(surface, name));
  if (await exists(collisionAbs)) {
    return { ok: false, code: "exists", error: `a ${surface} named "${name}" already exists` };
  }
  await writeFileAtomic(abs, content.endsWith("\n") ? content : `${content}\n`);
  return { ok: true, id: `${surface}:${name}` };
}

export async function updateFilePrimitive(
  surface: FilePrimitiveSurface,
  name: string,
  content: string,
  home: string = claudeHome()
): Promise<FilePrimitiveResult> {
  const rel = relPathFor(surface, name);
  const abs = absFor(home, rel);
  if (!(await exists(abs))) {
    return { ok: false, code: "not-found", error: `no ${surface} named "${name}"` };
  }
  await writeFileAtomic(abs, content.endsWith("\n") ? content : `${content}\n`);
  return { ok: true, id: `${surface}:${name}` };
}

// Pure delete (no ownership check — the dispatch guards owned files before
// calling this). Removes the whole skill dir, or the single command/rule file.
export async function deleteFilePrimitive(
  surface: FilePrimitiveSurface,
  name: string,
  home: string = claudeHome()
): Promise<FilePrimitiveResult> {
  const targetRel = deleteTargetRel(surface, name);
  const abs = absFor(home, targetRel);
  if (!(await exists(abs))) {
    return { ok: false, code: "not-found", error: `no ${surface} named "${name}"` };
  }
  await fs.rm(abs, { recursive: true, force: true });
  return { ok: true, id: `${surface}:${name}` };
}

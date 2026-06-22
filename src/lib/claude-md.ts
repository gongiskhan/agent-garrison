import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { claudeHome } from "./claude-home";
import { writeFileAtomic } from "./atomic-write";

// Host-config editor for CLAUDE.md (user + project scope). Garrison manages
// these durable, hand-authored guidance files directly; the Basic Memory
// store (fittings/seed/basic-memory) is a SEPARATE store and is untouched.
//
// Never-clobber: writes carry the sha the client last read; if the file changed
// underneath (edited outside Garrison), the write is refused as a conflict
// rather than overwriting.

export type ClaudeMdScope = "user" | "project";

export interface ClaudeMdOpts {
  claudeHome?: string;
  projectDir?: string;
}

function sha(s: string): string {
  return `sha256:${crypto.createHash("sha256").update(s).digest("hex")}`;
}

export function claudeMdPath(scope: ClaudeMdScope, opts?: ClaudeMdOpts): string {
  if (scope === "user") return path.join(opts?.claudeHome ?? claudeHome(), "CLAUDE.md");
  return path.join(opts?.projectDir ?? process.cwd(), "CLAUDE.md");
}

export interface ClaudeMdView {
  scope: ClaudeMdScope;
  path: string;
  exists: boolean;
  content: string;
  sha: string;
}

export async function readClaudeMd(scope: ClaudeMdScope, opts?: ClaudeMdOpts): Promise<ClaudeMdView> {
  const p = claudeMdPath(scope, opts);
  try {
    const content = await fs.readFile(p, "utf8");
    return { scope, path: p, exists: true, content, sha: sha(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scope, path: p, exists: false, content: "", sha: sha("") };
    }
    throw error;
  }
}

export type WriteClaudeMdResult =
  | { ok: true; view: ClaudeMdView }
  | { ok: false; code: "conflict"; current: ClaudeMdView };

export async function writeClaudeMd(
  scope: ClaudeMdScope,
  body: string,
  opts?: ClaudeMdOpts & { baselineSha?: string }
): Promise<WriteClaudeMdResult> {
  const current = await readClaudeMd(scope, opts);
  // Refuse if the file changed since the client last read it (never-clobber).
  if (current.exists && opts?.baselineSha && current.sha !== opts.baselineSha) {
    return { ok: false, code: "conflict", current };
  }
  await writeFileAtomic(current.path, body);
  return { ok: true, view: { scope, path: current.path, exists: true, content: body, sha: sha(body) } };
}

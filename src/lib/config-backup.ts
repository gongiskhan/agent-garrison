import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { claudeHome, claudeJsonPath, garrisonDir } from "./claude-home";

// Pre-install / pre-teardown snapshot of the user's engine config surfaces.
//
// The snapshot is BOTH the restore source for Uninstall AND the ownership
// baseline for the timestamp/hash heuristic: an item captured here at install
// time is the user's, and is never overwritten or removed by Garrison; anything
// that appears afterwards is a Garrison candidate. The per-entry sha256 +
// mtimeMs is the oracle the "keep yours on ambiguity" rule (Phase 3) reads.
//
// It is deliberately lean: the small JSON control files plus the user's authored
// file primitives (skills / commands / rules — text, bounded). We do NOT copy
// the whole ~/.claude.json (large; holds project history + OAuth material) —
// only its `mcpServers` slice is extracted.

export interface BackupEntry {
  rel: string; // path within the backup dir
  source: string; // absolute source path it was copied from
  sha256: string; // "sha256:<hex>"
  mtimeMs: number;
  size: number;
}

export interface BackupManifest {
  version: 1;
  reason: string;
  createdAt: string;
  claudeHome: string;
  entries: BackupEntry[];
  notes: string[];
}

export interface SnapshotResult {
  dir: string;
  manifest: BackupManifest;
}

export interface SnapshotOpts {
  // Base home for the NATIVE engine configs (~/.codex, ~/.gemini). Defaults to
  // the OS home; overridable so tests don't read the real user's engine config.
  nativeHome?: string;
}

function sha(buf: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`;
}

async function statOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

export function backupsRootDir(): string {
  return path.join(garrisonDir(), "backups");
}

export async function snapshotClaudeConfig(
  reason: string,
  opts: SnapshotOpts = {}
): Promise<SnapshotResult> {
  const home = claudeHome();
  const nativeHome = opts.nativeHome ?? homedir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(backupsRootDir(), `${reason}-${stamp}`);
  await fs.mkdir(dir, { recursive: true });

  const entries: BackupEntry[] = [];
  const notes: string[] = [];

  const grabFile = async (absSrc: string, relOut: string): Promise<void> => {
    const st = await statOrNull(absSrc);
    if (!st || !st.isFile()) return;
    const buf = await fs.readFile(absSrc);
    const out = path.join(dir, relOut);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, buf);
    entries.push({ rel: relOut, source: absSrc, sha256: sha(buf), mtimeMs: st.mtimeMs, size: buf.length });
  };

  const grabDir = async (absSrc: string, relOutBase: string): Promise<void> => {
    const root = await statOrNull(absSrc);
    if (!root || !root.isDirectory()) return;
    const walk = async (relInside: string): Promise<void> => {
      const absHere = relInside ? path.join(absSrc, relInside) : absSrc;
      const dirents = await fs.readdir(absHere, { withFileTypes: true });
      for (const d of dirents) {
        const childRel = relInside ? path.join(relInside, d.name) : d.name;
        if (d.isDirectory()) await walk(childRel);
        else if (d.isFile()) await grabFile(path.join(absSrc, childRel), path.join(relOutBase, childRel));
      }
    };
    await walk("");
  };

  // ~/.claude control files
  await grabFile(path.join(home, "settings.json"), "claude/settings.json");
  await grabFile(path.join(home, "settings.local.json"), "claude/settings.local.json");
  await grabFile(path.join(home, "mcp.json"), "claude/mcp.json");
  await grabFile(path.join(home, "plugins", "installed_plugins.json"), "claude/plugins/installed_plugins.json");

  // ~/.claude authored file primitives (text; bounded)
  await grabDir(path.join(home, "skills"), "claude/skills");
  await grabDir(path.join(home, "commands"), "claude/commands");
  await grabDir(path.join(home, "rules"), "claude/rules");

  // ~/.claude.json — extract ONLY the mcpServers slice (never the auth/history bulk).
  const claudeJson = claudeJsonPath(home);
  try {
    const raw = await fs.readFile(claudeJson, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
      const slice = Buffer.from(`${JSON.stringify({ mcpServers: parsed.mcpServers }, null, 2)}\n`, "utf8");
      await fs.writeFile(path.join(dir, "claude.json.mcpServers.json"), slice);
      const st = await statOrNull(claudeJson);
      entries.push({
        rel: "claude.json.mcpServers.json",
        source: claudeJson,
        sha256: sha(slice),
        mtimeMs: st?.mtimeMs ?? 0,
        size: slice.length
      });
    }
  } catch {
    notes.push("~/.claude.json absent or unparseable — mcpServers slice not captured");
  }

  // Native engine homes (codex / gemini) — the REAL user config Uninstall restores.
  await grabFile(path.join(nativeHome, ".codex", "config.toml"), "codex/config.toml");
  await grabFile(path.join(nativeHome, ".gemini", "settings.json"), "gemini/settings.json");

  const manifest: BackupManifest = {
    version: 1,
    reason,
    createdAt: new Date().toISOString(),
    claudeHome: home,
    entries,
    notes
  };
  await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { dir, manifest };
}

export async function readBackupManifest(dir: string): Promise<BackupManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) return parsed as BackupManifest;
  } catch {
    // none
  }
  return null;
}

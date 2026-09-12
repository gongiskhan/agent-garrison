// macOS can report an NFC filename for an already tracked NFD filename.
// Repair only duplicate index entries, never the vault's working-tree files.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function guardUnicodeAliases({ cwd = process.cwd(), platform = process.platform } = {}) {
  if (platform !== "darwin") return { removed: 0 };
  const git = (args, input) => execFileSync("git", args, {
    cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  const previous = new Set(git(["ls-tree", "-rz", "--name-only", "HEAD"]).split("\0").filter(Boolean));
  const groups = new Map();
  for (const row of git(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    const [mode, oid, stage] = row.slice(0, tab).split(" ");
    const name = row.slice(tab + 1);
    const key = name.normalize("NFC");
    const group = groups.get(key) ?? [];
    group.push({ name, mode, oid, stage });
    groups.set(key, group);
  }
  const aliases = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const originals = group.filter((entry) => previous.has(entry.name));
    if (originals.length !== 1 || group.some((entry) => entry.stage !== "0"
      || entry.mode !== originals[0]?.mode || entry.oid !== originals[0]?.oid)) {
      throw new Error("Conflicting Unicode filename aliases: preserve the index and resolve before syncing");
    }
    aliases.push(...group.filter((entry) => entry !== originals[0]).map((entry) => entry.name));
  }
  if (!aliases.length) return { removed: 0 };
  if (aliases.some((name) => /[\r\n]/.test(name))) {
    throw new Error("Unicode filename alias contains a newline; manual review required");
  }
  const exclude = path.resolve(cwd, git(["rev-parse", "--git-path", "info/exclude"]).trim());
  const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const patterns = aliases.map((name) => "/" + name.replace(/[\\*?\[\]#! ]/g, "\\$&"))
    .filter((pattern) => !existing.split("\n").includes(pattern));
  git(["update-index", "--force-remove", "-z", "--stdin"], aliases.join("\0") + "\0");
  // Exclude only the untracked spelling of each identical tracked file. New
  // files and changes to the canonical tracked path still participate in sync.
  if (patterns.length) {
    mkdirSync(path.dirname(exclude), { recursive: true });
    appendFileSync(exclude, "\n# Garrison: identical Unicode aliases of tracked files\n" + patterns.join("\n") + "\n");
  }
  return { removed: aliases.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = guardUnicodeAliases({ cwd: process.argv[2] || process.cwd() });
    if (result.removed) console.log(`vault-git-sync: removed ${result.removed} identical Unicode index alias(es); files preserved`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

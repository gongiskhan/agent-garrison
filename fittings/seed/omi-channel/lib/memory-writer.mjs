// Headless Garrison-memory writer - the basic-memory (Obsidian vault) file
// pattern from fittings/seed/basic-memory/scripts/capture-session.py: plain
// frontmattered markdown written into the vault's Memory dir; the Basic Memory
// file watcher indexes it, the nightly improver dream pass consolidates it.
//
// Load-bearing details copied from that pattern:
// - filename prefix `omi-` and NOT `session-` (the improver dream phase
//   auto-archives stale session-* checkpoints as expendable);
// - secret redaction before anything touches disk;
// - provenance as bullet fields in the body (invariant I1: the memory is OUR
//   summary; Omi text appears only as clearly marked source context);
// - never mutate existing notes, never touch MEMORY.md (hand-curated).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function vaultMemoryDir(env = process.env) {
  const vault = (env.BASIC_MEMORY_VAULT_DIR || "").trim() || path.join(os.homedir(), "ObsidianVault");
  const memoryDir = (env.BASIC_MEMORY_MEMORY_DIR || "").trim() || "Memory";
  return { vault, dir: path.join(vault, memoryDir) };
}

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /omi_(dev|mcp)_[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]{12,}/g
];

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "note";
}

export class MemoryWriter {
  // dir injectable for tests; requireVault=true skips (with a reason) when the
  // vault root does not exist - memory-store is an optional-one dependency.
  constructor({ dir = null, env = process.env } = {}) {
    this.explicit = Boolean(dir);
    if (dir) {
      this.vault = dir;
      this.dir = dir;
    } else {
      const resolved = vaultMemoryDir(env);
      this.vault = resolved.vault;
      this.dir = resolved.dir;
    }
  }

  // The DEFAULT vault must already exist (we never create ~/ObsidianVault -
  // its absence means basic-memory is not set up and writes are skipped with a
  // reason). An explicitly injected dir is created on demand.
  available() {
    return this.explicit || existsSync(this.vault);
  }

  // -> { ok: true, file } | { ok: false, skipped }
  write({ title, content, tags = [], provenance = {}, now = new Date() }) {
    if (!this.available()) return { ok: false, skipped: `vault dir missing: ${this.vault}` };
    mkdirSync(this.dir, { recursive: true });
    const safeTitle = redactSecrets(title).replace(/\n/g, " ").trim() || "Omi capture";
    const allTags = ["omi", ...tags.filter((t) => typeof t === "string" && t && t !== "omi")];
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const file = path.join(this.dir, `omi-${stamp}-${slugify(safeTitle)}.md`);
    const lines = [
      "---",
      `title: ${safeTitle}`,
      "type: note",
      `tags: [${allTags.join(", ")}]`,
      "---",
      "",
      redactSecrets(content).trim(),
      "",
      "## Provenance",
      ""
    ];
    for (const [key, value] of Object.entries(provenance)) {
      if (value === null || value === undefined || value === "") continue;
      lines.push(`- **${key}**: ${redactSecrets(String(value))}`);
    }
    lines.push("");
    writeFileSync(file, lines.join("\n"));
    return { ok: true, file };
  }
}

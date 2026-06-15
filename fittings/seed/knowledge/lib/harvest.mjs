// harvest.mjs — learned-memory harvest (BRIEF v4 Knowledge faculty).
//
// Claude Code Auto Memory (MEMORY.md) is harvested into the vault IDEMPOTENTLY.
// Learned notes are HINTS to validate (code-check or recurrence) before they earn
// permanent vault placement, so they land in a `harvested/` namespace tagged as
// pending. Running harvest twice on the same MEMORY.md leaves the vault unchanged
// (harvest-idempotent-ok). Pure functions + a thin disk applier.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

// Parse the MEMORY.md index lines: `- [Title](file.md) — hook`.
export function parseMemoryIndex(memoryMd) {
  const out = [];
  for (const line of String(memoryMd).split("\n")) {
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:—|-)?\s*(.*)$/);
    if (!m) continue;
    const slug = m[2].replace(/\.md$/, "").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    out.push({ slug, title: m[1].trim(), hook: (m[3] || "").trim() });
  }
  return out;
}

export function harvestedName(slug) {
  return `harvested-${slug}`;
}

// Decide which memory entries are NEW relative to the existing vault file names.
// Idempotent: an entry already present (by harvested-<slug>) is skipped.
export function planHarvest(memoryEntries, existingNames) {
  const existing = new Set(existingNames);
  const toAdd = [];
  for (const e of memoryEntries) {
    if (!existing.has(harvestedName(e.slug))) toAdd.push(e);
  }
  return toAdd;
}

export function harvestNoteContent(entry) {
  return [
    "---",
    "status: harvested-pending",
    `source: MEMORY.md`,
    "---",
    "",
    `# ${entry.title}`,
    "",
    entry.hook || "(learned hint — validate before promoting to a canonical convention)"
  ].join("\n") + "\n";
}

// Apply a harvest to a vault dir. Returns { added: [...], skipped: n }. The
// second run on the same MEMORY.md adds nothing (idempotent).
export function harvestIntoVault(memoryMdPath, vaultDir) {
  const memoryMd = existsSync(memoryMdPath) ? readFileSync(memoryMdPath, "utf8") : "";
  const entries = parseMemoryIndex(memoryMd);
  mkdirSync(vaultDir, { recursive: true });
  const existingNames = readdirSync(vaultDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  const toAdd = planHarvest(entries, existingNames);
  for (const e of toAdd) {
    writeFileSync(path.join(vaultDir, `${harvestedName(e.slug)}.md`), harvestNoteContent(e), "utf8");
  }
  return { added: toAdd.map((e) => harvestedName(e.slug)), skipped: entries.length - toAdd.length, total: entries.length };
}

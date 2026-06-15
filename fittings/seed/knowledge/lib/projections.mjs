// projections.mjs — cross-runtime memory projections (BRIEF v4 Knowledge faculty).
//
// The canonical vault (prescriptive rules/conventions) is PROJECTED to per-runtime
// files so any runtime/provider walks into the same prepared workspace — this is
// the portability lever (switching the runtime never loses memory). All functions
// are pure + deterministic (idempotent: same vault → identical bytes).
//   AGENTS.md  — the cross-tool standard (full content)
//   CLAUDE.md  — thin, imports @AGENTS.md (Claude Code import syntax)
//   GEMINI.md  — thin, imports @AGENTS.md (Gemini equivalent)
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const SENTINELS = {
  agents: "<!-- garrison:knowledge:agents v1 -->",
  claude: "<!-- garrison:knowledge:claude v1 -->",
  gemini: "<!-- garrison:knowledge:gemini v1 -->"
};

// Read the vault: every *.md under the vault dir, sorted by name for determinism.
export function readVault(vaultDir) {
  if (!existsSync(vaultDir)) return [];
  return readdirSync(vaultDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f.replace(/\.md$/, ""), content: readFileSync(path.join(vaultDir, f), "utf8").trim() }));
}

// Compile AGENTS.md — the canonical cross-tool standard. Deterministic.
export function compileAgents(entries) {
  const parts = [SENTINELS.agents, "# Project conventions (canonical)", ""];
  parts.push("These rules are projected from the Knowledge vault to every runtime.", "");
  for (const e of entries) {
    parts.push(`## ${e.name}`, "", e.content, "");
  }
  return parts.join("\n").trimEnd() + "\n";
}

// CLAUDE.md / GEMINI.md are thin pointers that import the canonical AGENTS.md
// (so a single edit to the vault re-projects everywhere; no drift between files).
export function compileClaude() {
  return [SENTINELS.claude, "# Claude Code memory", "", "@AGENTS.md", "", "Project conventions live in AGENTS.md (projected from the Knowledge vault)."].join("\n") + "\n";
}

export function compileGemini() {
  return [SENTINELS.gemini, "# Gemini memory", "", "@AGENTS.md", "", "Project conventions live in AGENTS.md (projected from the Knowledge vault)."].join("\n") + "\n";
}

// Project all three from a vault dir. Pure: returns { filename: bytes }.
export function projectAll(vaultDir) {
  const entries = readVault(vaultDir);
  return {
    "AGENTS.md": compileAgents(entries),
    "CLAUDE.md": compileClaude(),
    "GEMINI.md": compileGemini()
  };
}

// Write projections idempotently: only rewrite a file whose bytes changed.
// Returns { written: [...], unchanged: [...] } — provisioning-idempotent relies
// on the second run reporting everything unchanged.
export function writeProjections(targetDir, projections) {
  mkdirSync(targetDir, { recursive: true });
  const written = [];
  const unchanged = [];
  for (const [name, bytes] of Object.entries(projections)) {
    const p = path.join(targetDir, name);
    const prev = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (prev === bytes) unchanged.push(name);
    else {
      writeFileSync(p, bytes, "utf8");
      written.push(name);
    }
  }
  return { written, unchanged };
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// Sequoias-derived. Rewrites `${PORT:-N}` defaults in frontend workspace dev
// scripts so `npm run dev` from a worktree binds the worktree's allocated
// frontend port instead of the upstream default (3000, 5173, …).

const FRONTEND_DIRS = new Set([
  "ekoa-app",
  "ekoa_app",
  "ekoa",
  "app",
  "frontend",
  "web",
  "ui",
  "next",
  "client"
]);

const PORT_DEFAULT_RE = /\$\{PORT:-(\d+)\}/g;
const GARRISON_MARKER = "GARRISON_FRONTEND_PORT";

type PortFlagRule = {
  command: string;
  defaultPort: number;
};

const PORT_FLAG_TOOLS: PortFlagRule[] = [
  { command: "next dev", defaultPort: 3000 },
  { command: "next start", defaultPort: 3000 },
  { command: "vite dev", defaultPort: 5173 },
  { command: "vite preview", defaultPort: 4173 }
];

function commandHasPortFlag(script: string, cmd: string): boolean {
  const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b[^&;|]*?(?:-p\\s|--port[=\\s])`);
  return re.test(script);
}

export async function patchFrontendDevScripts(
  worktreeRoot: string
): Promise<string[]> {
  const modified: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(worktreeRoot, { withFileTypes: true });
  } catch {
    return modified;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!FRONTEND_DIRS.has(entry.name.toLowerCase())) continue;
    const pkgPath = path.join(worktreeRoot, entry.name, "package.json");
    if (!fs.existsSync(pkgPath)) continue;

    let raw: string;
    let parsed: { scripts?: Record<string, string> };
    try {
      raw = await fsp.readFile(pkgPath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed.scripts || typeof parsed.scripts !== "object") continue;

    let changed = false;
    for (const [key, val] of Object.entries(parsed.scripts)) {
      if (typeof val !== "string") continue;
      let rewritten = val;

      if (!rewritten.includes(GARRISON_MARKER)) {
        rewritten = rewritten.replace(
          PORT_DEFAULT_RE,
          "${PORT:-${GARRISON_FRONTEND_PORT:-$1}}"
        );
      }

      for (const rule of PORT_FLAG_TOOLS) {
        if (!rewritten.includes(rule.command)) continue;
        if (commandHasPortFlag(rewritten, rule.command)) continue;
        const escaped = rule.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`\\b${escaped}\\b`);
        rewritten = rewritten.replace(
          re,
          `${rule.command} -p \${PORT:-\${GARRISON_FRONTEND_PORT:-${rule.defaultPort}}}`
        );
      }

      if (rewritten !== val) {
        parsed.scripts[key] = rewritten;
        changed = true;
      }
    }
    if (changed) {
      const trailing = raw.endsWith("\n") ? "\n" : "";
      await fsp.writeFile(pkgPath, JSON.stringify(parsed, null, 2) + trailing);
      modified.push(path.relative(worktreeRoot, pkgPath));
    }
  }
  return modified;
}

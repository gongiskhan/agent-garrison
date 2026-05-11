import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { allocatePort } from "./ports";

// Sequoias-derived. Discovers root + first-level .env files in a worktree,
// rewrites per-service port variables and localhost:N URLs to deterministic
// values from `allocatePort`, and synthesises minimal per-workspace .env files
// for monorepo packages that read process.env.PORT.

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  ".vercel",
  ".serverless",
  "out",
  "tmp"
]);

const ENV_FILE_RE = /^\.env(\..+)?$/;

export type EnvRewriteResult = {
  envFiles: string[];
  ports: Record<string, number>;
};

export type EnvRewriteOptions = {
  branch: string;
  mainPortMap: Record<number, { service: string; key: string }>;
  reserved?: Set<number>;
};

export async function discoverEnvFiles(rootDir: string): Promise<string[]> {
  // .env files are intentionally gitignored — discovery deliberately ignores
  // .gitignore. We scan root + first-level subdirs only.
  const out: string[] = [];

  const collect = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!ENV_FILE_RE.test(entry.name)) continue;
      const entryRel = rel ? path.posix.join(rel, entry.name) : entry.name;
      out.push(entryRel);
    }
  };

  collect(rootDir, "");

  let topEntries: fs.Dirent[];
  try {
    topEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out.sort();
  }
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    collect(path.join(rootDir, entry.name), entry.name);
  }

  return out.sort();
}

export function readMainPortMap(
  rootDir: string,
  envFiles: string[]
): Record<number, { service: string; key: string }> {
  const map: Record<number, { service: string; key: string }> = {};
  for (const rel of envFiles) {
    const abs = path.join(rootDir, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, key, rawValue] = m;
      const value = rawValue.replace(/^['"](.*)['"]$/, "$1");
      const portFromKey = isPortKey(key) ? Number(value) : NaN;
      if (Number.isFinite(portFromKey) && portFromKey > 0 && portFromKey < 65536) {
        map[portFromKey] = { service: serviceForKey(key), key };
      }
      const urlPortRe = /(?:localhost|127\.0\.0\.1):(\d{2,5})/g;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = urlPortRe.exec(value))) {
        const port = Number(urlMatch[1]);
        if (port > 0 && port < 65536 && !(port in map)) {
          map[port] = { service: serviceForKey(key), key };
        }
      }
    }
  }
  return map;
}

export function isPortKey(key: string): boolean {
  return /(^|_)PORT(_|$)/i.test(key);
}

export function serviceForKey(key: string): string {
  const upper = key.toUpperCase();
  if (upper.includes("CORTEX")) return "cortex";
  if (upper.includes("NEXT") || upper.includes("APP") || upper.includes("FRONTEND")) {
    return "ekoa_app";
  }
  const prefixMatch = key.match(/^([A-Z][A-Z0-9]*?)(?:_PORT.*)?$/i);
  if (prefixMatch && prefixMatch[1]) {
    return prefixMatch[1].toLowerCase();
  }
  return key.toLowerCase();
}

// Map a package subdirectory to a port from the allocated set, using common
// monorepo conventions. Many services read process.env.PORT directly with a
// hardcoded default — without this mapping, every worktree would collide on
// that default. Returns undefined if no match is found.
const DIR_PORT_ALIASES: Record<string, string[]> = {
  cortex: ["cortex", "api", "backend", "server"],
  api: ["api", "cortex", "backend", "server"],
  backend: ["backend", "api", "cortex", "server"],
  server: ["server", "api", "cortex", "backend"],
  "ekoa-app": ["ekoa_app", "ekoa-app", "app", "frontend", "web", "ui", "next"],
  ekoa_app: ["ekoa_app", "ekoa-app", "app", "frontend", "web", "ui", "next"],
  ekoa: ["ekoa_app", "ekoa-app", "ekoa", "app", "frontend", "web", "ui", "next"],
  app: ["app", "ekoa_app", "frontend", "web", "ui", "next"],
  frontend: ["frontend", "ekoa_app", "app", "web", "ui", "next"],
  web: ["web", "ekoa_app", "frontend", "app", "ui", "next"],
  ui: ["ui", "ekoa_app", "frontend", "app", "web", "next"],
  next: ["next", "ekoa_app", "frontend", "app", "web", "ui"],
  client: ["client", "frontend", "web", "ui", "app", "ekoa_app"]
};

// Workspace dir names that inherit NEXT_PUBLIC_* env vars from the worktree's
// root .env. Mirrors FRONTEND_DIRS in package-json-patcher.
const FRONTEND_DIR_NAMES = new Set([
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

function readNextPublicLines(worktreeRoot: string): string {
  const rootEnv = path.join(worktreeRoot, ".env");
  let content: string;
  try {
    content = fs.readFileSync(rootEnv, "utf8");
  } catch {
    return "";
  }
  const lines = content.split(/\r?\n/);
  const keep: string[] = [];
  for (const line of lines) {
    if (/^\s*NEXT_PUBLIC_[A-Za-z0-9_]+\s*=/.test(line)) keep.push(line);
  }
  return keep.join("\n");
}

export async function ensureWorkspacePortFiles(
  worktreeRoot: string,
  ports: Record<string, number>
): Promise<string[]> {
  const touched: string[] = [];
  const nextPublicBlock = readNextPublicLines(worktreeRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(worktreeRoot, { withFileTypes: true });
  } catch {
    return touched;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const dir = path.join(worktreeRoot, entry.name);
    if (!fs.existsSync(path.join(dir, "package.json"))) continue;
    const port = packagePortForDir(entry.name, ports);
    if (port === undefined) continue;
    const isFrontend = FRONTEND_DIR_NAMES.has(entry.name.toLowerCase());

    const dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    const dotEnv = dirEntries.find((e) => e.isFile() && e.name === ".env");
    const target = path.join(dir, ".env");

    if (!dotEnv) {
      const fePart =
        isFrontend && nextPublicBlock
          ? `\n# NEXT_PUBLIC_* mirrored from root .env (Next.js only reads .env\n` +
            `# files in its own project dir, so URLs that point at sibling\n` +
            `# workspaces have to be duplicated here for Next.js to see them).\n` +
            `${nextPublicBlock}\n`
          : "";
      const content =
        `# PORT injected by Garrison (${entry.name} workspace allocation)\n` +
        `# This package's dev script reads process.env.PORT but the upstream\n` +
        `# repo doesn't track an env file here, so Garrison creates one to\n` +
        `# avoid cross-worktree collisions on default ports.\n` +
        `PORT=${port}\n` +
        fePart;
      await fsp.writeFile(target, content);
      touched.push(path.posix.join(entry.name, ".env"));
      continue;
    }

    let existing = "";
    try {
      existing = await fsp.readFile(target, "utf8");
    } catch {
      continue;
    }
    const isOurs = /^# PORT injected by Garrison/m.test(existing);
    const hasPortLine = /^PORT=/m.test(existing);

    const dataLines = existing
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#"));
    const onlyPortAndNextPublic = dataLines.every(
      (l) => /^PORT=/.test(l) || /^NEXT_PUBLIC_/.test(l)
    );

    if (isOurs && hasPortLine && onlyPortAndNextPublic) {
      const fePart =
        isFrontend && nextPublicBlock
          ? `\n# NEXT_PUBLIC_* mirrored from root .env (Next.js only reads .env\n` +
            `# files in its own project dir, so URLs that point at sibling\n` +
            `# workspaces have to be duplicated here for Next.js to see them).\n` +
            `${nextPublicBlock}\n`
          : "";
      const content =
        `# PORT injected by Garrison (${entry.name} workspace allocation)\n` +
        `# This package's dev script reads process.env.PORT but the upstream\n` +
        `# repo doesn't track an env file here, so Garrison creates one to\n` +
        `# avoid cross-worktree collisions on default ports.\n` +
        `PORT=${port}\n` +
        fePart;
      if (existing !== content) {
        await fsp.writeFile(target, content);
        touched.push(path.posix.join(entry.name, ".env"));
      }
      continue;
    }

    let next = existing;
    if (hasPortLine) {
      next = next.replace(/^PORT=.*$/m, `PORT=${port}`);
    } else {
      next =
        (next.endsWith("\n") ? next : next + "\n") +
        `\n# PORT injected by Garrison (${entry.name} workspace allocation)\nPORT=${port}\n`;
    }
    if (isFrontend && nextPublicBlock) {
      for (const line of nextPublicBlock.split(/\r?\n/)) {
        const m = line.match(/^\s*(NEXT_PUBLIC_[A-Za-z0-9_]+)\s*=/);
        if (!m) continue;
        const key = m[1];
        const re = new RegExp(`^${key}=.*$`, "m");
        if (re.test(next)) {
          next = next.replace(re, line);
        } else {
          next = (next.endsWith("\n") ? next : next + "\n") + line + "\n";
        }
      }
    }
    if (next !== existing) {
      await fsp.writeFile(target, next);
      touched.push(path.posix.join(entry.name, ".env"));
    }
  }
  return touched;
}

export function packagePortForDir(
  dirname: string,
  ports: Record<string, number>
): number | undefined {
  const lower = dirname.toLowerCase();
  if (ports[lower] !== undefined) return ports[lower];
  const aliasChain = DIR_PORT_ALIASES[lower];
  if (aliasChain) {
    for (const candidate of aliasChain) {
      if (ports[candidate] !== undefined) return ports[candidate];
    }
  }
  return undefined;
}

type ParsedLine =
  | { kind: "plain"; raw: string }
  | {
      kind: "kv";
      indent: string;
      key: string;
      quoteChar: string;
      value: string;
    };

function parseLine(line: string): ParsedLine {
  const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return { kind: "plain", raw: line };
  const [, indent, key, rawValue] = m;
  const quoted = rawValue.match(/^(['"])(.*)\1\s*$/);
  const quoteChar = quoted ? quoted[1] : "";
  const value = quoted ? quoted[2] : rawValue;
  return { kind: "kv", indent, key, quoteChar, value };
}

export async function rewriteEnvFiles(
  worktreeRoot: string,
  envFiles: string[],
  opts: EnvRewriteOptions
): Promise<EnvRewriteResult> {
  const ports: Record<string, number> = {};
  const reserved = opts.reserved ?? new Set<number>();

  const fileContents: { rel: string; lines: ParsedLine[]; original: string }[] = [];
  const servicesNeeded = new Set<string>();

  for (const rel of envFiles) {
    const abs = path.join(worktreeRoot, rel);
    let content: string;
    try {
      content = await fsp.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/).map(parseLine);
    fileContents.push({ rel, lines, original: content });
    const fileDir = path.posix.dirname(rel);
    const fileInPackage = fileDir && fileDir !== ".";
    for (const line of lines) {
      if (line.kind !== "kv") continue;
      if (isPortKey(line.key)) {
        // Bare `PORT` in a per-package env file is resolved via
        // packagePortForDir at write time — skip the per-service allocation.
        if (line.key.toUpperCase() === "PORT" && fileInPackage) {
          // skip
        } else {
          servicesNeeded.add(serviceForKey(line.key));
        }
      }
      const urlPortRe = /(?:localhost|127\.0\.0\.1):(\d{2,5})/g;
      let m: RegExpExecArray | null;
      while ((m = urlPortRe.exec(line.value))) {
        const oldPort = Number(m[1]);
        const mainEntry = opts.mainPortMap[oldPort];
        if (mainEntry) servicesNeeded.add(mainEntry.service);
      }
    }
  }

  for (const service of servicesNeeded) {
    ports[service] = await allocatePort(opts.branch, service, { reserved });
  }

  for (const file of fileContents) {
    const out: string[] = [];
    let sawPortKey = false;
    const dir = path.posix.dirname(file.rel);
    const dirname = dir && dir !== "." ? path.posix.basename(dir) : "";
    const packagePort = dirname ? packagePortForDir(dirname, ports) : undefined;
    for (const line of file.lines) {
      if (line.kind === "plain") {
        out.push(line.raw);
        continue;
      }
      let { value } = line;
      if (line.key.toUpperCase() === "PORT") {
        sawPortKey = true;
        if (dirname && packagePort !== undefined) {
          value = String(packagePort);
        } else if (!dirname) {
          const port = ports[serviceForKey(line.key)];
          if (port != null) value = String(port);
        }
      } else if (isPortKey(line.key)) {
        const service = serviceForKey(line.key);
        const port = ports[service];
        if (port != null) value = String(port);
      }
      value = value.replace(/(localhost|127\.0\.0\.1):(\d{2,5})/g, (match, host, p) => {
        const oldPort = Number(p);
        const mainEntry = opts.mainPortMap[oldPort];
        if (!mainEntry) return match;
        const newPort = ports[mainEntry.service];
        if (newPort == null) return match;
        return `${host}:${newPort}`;
      });
      out.push(`${line.indent}${line.key}=${line.quoteChar}${value}${line.quoteChar}`);
    }

    if (dir && dir !== ".") {
      const portForPackage = packagePort;
      if (portForPackage !== undefined && !sawPortKey) {
        if (out.length > 0 && out[out.length - 1].trim() !== "") {
          out.push("");
        }
        out.push(`# PORT injected by Garrison (${dirname} package allocation)`);
        out.push(`PORT=${portForPackage}`);
      }
    }

    await fsp.writeFile(path.join(worktreeRoot, file.rel), out.join("\n"));
  }

  return { envFiles, ports };
}

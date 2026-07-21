import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { readYamlFile } from "./yaml";
import type { PortNeed, ProjectConfig } from "./types";

const cache = new Map<string, ProjectConfig>();

const RawConfigSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    rootPath: z.string().optional(),
    portNeeds: z
      .array(
        z.object({
          name: z.string(),
          default: z.number().optional()
        })
      )
      .optional(),
    startupCommands: z.array(z.string()).optional(),
    envTemplate: z.record(z.string()).optional(),
    defaultBaseBranch: z.string().optional()
  })
  .passthrough();

type RawConfig = z.infer<typeof RawConfigSchema>;

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~"
    ? path.join(os.homedir(), p.slice(2))
    : p;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function defaultsForRepo(repoPath: string): ProjectConfig {
  const name = path.basename(repoPath);
  return {
    id: name,
    name,
    rootPath: repoPath,
    portNeeds: [],
    startupCommands: [],
    envTemplate: {},
    defaultBaseBranch: "main"
  };
}

function mergeConfigs(
  base: ProjectConfig,
  partial: RawConfig | null
): ProjectConfig {
  if (!partial) return base;
  return {
    id: partial.id ?? base.id,
    name: partial.name ?? base.name,
    rootPath: base.rootPath,
    portNeeds: partial.portNeeds ?? base.portNeeds,
    startupCommands: partial.startupCommands ?? base.startupCommands,
    envTemplate: partial.envTemplate ?? base.envTemplate,
    defaultBaseBranch: partial.defaultBaseBranch ?? base.defaultBaseBranch
  };
}

async function loadFile(filePath: string): Promise<RawConfig | null> {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = await readYamlFile<unknown>(filePath);
    if (!data) return null;
    const parsed = RawConfigSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function inferDefaultBaseBranch(repoPath: string): string {
  try {
    const ref = execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: repoPath, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    const match = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch { /* fall through */ }
  try {
    execFileSync("git", ["rev-parse", "--verify", "main"], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 2000
    });
    return "main";
  } catch { /* fall through */ }
  try {
    execFileSync("git", ["rev-parse", "--verify", "master"], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 2000
    });
    return "master";
  } catch { /* fall through */ }
  return "main";
}

function parsePortFlagsFromScript(value: string): { name: string; port?: number }[] {
  const out: { name: string; port?: number }[] = [];
  const portEnv = value.match(/\bPORT\s*=\s*(\d+)/);
  if (portEnv) out.push({ name: "port", port: Number(portEnv[1]) });
  const pFlag = value.match(/(?:^|\s)-p\s+(\d+)/);
  if (pFlag) out.push({ name: "port", port: Number(pFlag[1]) });
  const longFlag = value.match(/--port[=\s](\d+)/);
  if (longFlag) out.push({ name: "port", port: Number(longFlag[1]) });
  return out;
}

export function inferPortNeeds(repoPath: string): PortNeed[] {
  const collected = new Map<string, PortNeed>();
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const candidateKeys = ["dev", "start", "serve"];
      for (const key of candidateKeys) {
        const cmd = scripts[key];
        if (!cmd) continue;
        for (const { port } of parsePortFlagsFromScript(cmd)) {
          if (!collected.has(key)) {
            collected.set(key, { name: key, default: port });
          }
        }
        if (!collected.has(key) && /next dev|vite|webpack-dev-server/.test(cmd)) {
          const defaultPort = /vite/.test(cmd) ? 5173 : 27777;
          collected.set(key, { name: key, default: defaultPort });
        }
      }
    } catch { /* ignore malformed package.json */ }
  }
  for (const envName of [".env", ".env.local", ".env.development"]) {
    const envPath = path.join(repoPath, envName);
    if (!fs.existsSync(envPath)) continue;
    try {
      const text = fs.readFileSync(envPath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
        if (!m) continue;
        const [, key, rawValue] = m;
        if (!/(^|_)PORT(_|$)/i.test(key)) continue;
        const value = rawValue.replace(/^['"](.*)['"]$/, "$1").trim();
        const port = Number(value);
        if (!Number.isFinite(port) || port <= 0 || port > 65535) continue;
        const niceName = key.toLowerCase();
        if (!collected.has(niceName)) collected.set(niceName, { name: niceName, default: port });
      }
    } catch { /* ignore */ }
  }
  return Array.from(collected.values());
}

export async function loadProjectConfig(repoPath: string): Promise<ProjectConfig> {
  const resolved = realpathOrSelf(expandHome(repoPath));
  const cached = cache.get(resolved);
  if (cached) return cached;

  let config = defaultsForRepo(resolved);

  const homeFile = path.join(
    os.homedir(),
    ".garrison",
    "projects",
    `${path.basename(resolved)}.yml`
  );
  config = mergeConfigs(config, await loadFile(homeFile));

  const inRepoFile = path.join(resolved, ".garrison", "project.yml");
  config = mergeConfigs(config, await loadFile(inRepoFile));

  if (config.portNeeds.length === 0) {
    config.portNeeds = inferPortNeeds(resolved);
  }
  if (!config.defaultBaseBranch || config.defaultBaseBranch === "main") {
    const inferred = inferDefaultBaseBranch(resolved);
    if (inferred && inferred !== "main") {
      config.defaultBaseBranch = inferred;
    }
  }

  cache.set(resolved, config);
  return config;
}

export function _resetProjectConfigCacheForTests(): void {
  cache.clear();
}

const PROJECT_ROOT_CANDIDATES = [
  path.join(os.homedir(), "Projects"),
  path.join(os.homedir(), "dev"),
  path.join(os.homedir(), "code")
];

/**
 * Resolve a project id (basename slug) to its repo root path.
 * Search order:
 *   1. ~/.garrison/projects/<id>.yml — read rootPath field
 *   2. ~/.garrison/sessions/state.json — find a registered project with matching basename
 *   3. ~/Projects/<id>, ~/dev/<id>, ~/code/<id> (first existing)
 * Throws if no path resolves.
 */
export async function resolveProjectRepoPath(projectId: string): Promise<string> {
  const garrisonHome = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  const homeFile = path.join(
    garrisonHome,
    "projects",
    `${projectId}.yml`
  );
  if (fs.existsSync(homeFile)) {
    const raw = await loadFile(homeFile);
    if (raw?.rootPath) return realpathOrSelf(expandHome(raw.rootPath));
  }

  const stateFile = path.join(garrisonHome, "sessions", "state.json");
  if (fs.existsSync(stateFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
        projects?: Record<string, { name?: string; path?: string }>;
      };
      for (const project of Object.values(raw.projects ?? {})) {
        if (project.name === projectId && project.path) {
          return realpathOrSelf(project.path);
        }
        if (project.path && path.basename(project.path) === projectId) {
          return realpathOrSelf(project.path);
        }
      }
    } catch { /* ignore */ }
  }

  for (const root of PROJECT_ROOT_CANDIDATES) {
    const candidate = path.join(root, projectId);
    if (fs.existsSync(candidate)) return realpathOrSelf(candidate);
  }

  throw new Error(`could not resolve project id '${projectId}' to a repository path`);
}

export async function writeProjectConfigFile(
  filePath: string,
  config: Partial<RawConfig>
): Promise<void> {
  const yaml = await import("./yaml");
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await yaml.writeYamlFile(filePath, config);
}

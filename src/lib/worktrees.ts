import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  applyEnvTemplate,
  discoverEnvFiles,
  ensureWorkspacePortFiles,
  readMainPortMap,
  rewriteEnvFiles
} from "./worktree/env-rewriter";
import { defaultPortRange, type PortRange } from "./worktree/ports";
import { loadGarrisonConfig } from "./garrison-config";
import { patchFrontendDevScripts } from "./worktree/package-json-patcher";
import {
  removeSession,
  upsertSession,
  type Session
} from "./garrison-sessions";
import { computeUrls } from "./tailscale";
import { spawnTracked } from "./spawn";
import type { ProjectConfig } from "./types";

const execFileAsync = promisify(execFile);

export interface Worktree {
  worktreePath: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

export interface CreateWorktreeResult {
  worktreePath: string;
  envFiles: string[];
  ports: Record<string, number>;
  urls: Record<string, string>;
  id: string;
  title?: string;
  baseBranch: string;
}

export interface CreateWorktreeOpts {
  title?: string;
  projectConfig?: ProjectConfig;
}

export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const repo = expandHome(repoPath);
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo
  });
  return parseWorktreePorcelain(stdout, repo);
}

export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch?: string,
  opts: CreateWorktreeOpts = {}
): Promise<CreateWorktreeResult> {
  assertValidBranchName(branch);
  const cfg = opts.projectConfig;
  const baseRef = (baseBranch ?? cfg?.defaultBaseBranch ?? "main").trim();
  assertValidRef(baseRef);
  const slug = slugifyBranch(branch);
  if (!slug) throw new InvalidArgumentError("invalid branch name");
  const repo = expandHome(repoPath);
  const repoName = path.basename(repo);
  const worktreesRoot = cfg?.worktreeBase
    ? path.dirname(expandHome(cfg.worktreeBase))
    : path.join(homedir(), ".worktrees");
  const worktreeParentDir = cfg?.worktreeBase
    ? expandHome(cfg.worktreeBase)
    : path.join(worktreesRoot, repoName);
  const worktreePath = path.join(worktreeParentDir, slug);

  if (fs.existsSync(worktreePath)) {
    throw new Error(`worktree already exists at ${worktreePath}`);
  }
  await fsp.mkdir(path.dirname(worktreePath), { recursive: true });

  const { stdout: branchOut } = await execFileAsync("git", ["branch", "--list", branch], {
    cwd: repo
  });
  const branchExists = branchOut.trim().length > 0;

  if (branchExists) {
    await execFileAsync("git", ["worktree", "add", worktreePath, branch], { cwd: repo });
  } else {
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath, baseRef], {
      cwd: repo
    });
  }

  // Mirror Sequoias's env handling: discover .env* files in the source repo,
  // copy them into the new worktree, rewrite port variables and localhost
  // URLs to allocated values, then patch frontend dev scripts.
  const mainEnvFiles = await discoverEnvFiles(repo);
  const mainPortMap = readMainPortMap(repo, mainEnvFiles);

  const worktreeEnvFiles: string[] = [];
  for (const rel of mainEnvFiles) {
    const src = path.join(repo, rel);
    const dst = path.join(worktreePath, rel);
    if (!fs.existsSync(src)) continue;
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst)) {
      await fsp.copyFile(src, dst);
    }
    worktreeEnvFiles.push(rel);
  }

  // Port range precedence: project config → ~/.garrison/config.yml → env vars / defaults.
  const resolvedRange: PortRange =
    cfg?.portPool ?? (await loadGarrisonConfig()).portPool ?? defaultPortRange();

  const { ports } = await rewriteEnvFiles(worktreePath, worktreeEnvFiles, {
    branch,
    mainPortMap,
    range: resolvedRange
  });

  const createdPortFiles = await ensureWorkspacePortFiles(worktreePath, ports);
  for (const f of createdPortFiles) {
    if (!worktreeEnvFiles.includes(f)) worktreeEnvFiles.push(f);
  }

  await patchFrontendDevScripts(worktreePath);

  const now = new Date().toISOString();
  const worktreeId = randomUUID();
  const urls = computeUrls(ports);

  // Phase 2.3 — apply project envTemplate substitutions (${ports.X}, ${urls.X})
  // to every key the env file already has. Never adds new keys.
  if (cfg?.envTemplate && Object.keys(cfg.envTemplate).length > 0) {
    await applyEnvTemplate(worktreePath, worktreeEnvFiles, cfg.envTemplate, ports, urls);
  }

  await fsp.writeFile(
    path.join(worktreePath, ".garrison-meta.json"),
    JSON.stringify(
      {
        id: worktreeId,
        branch,
        baseBranch: baseRef,
        title: opts.title,
        repo: repoName,
        ports,
        urls,
        envFiles: worktreeEnvFiles,
        createdAt: now
      },
      null,
      2
    )
  );

  const hasStartupCommands = Boolean(cfg?.startupCommands?.length);

  const session: Session = {
    branch,
    worktreePath,
    ports,
    envFiles: worktreeEnvFiles,
    createdAt: now,
    lastStatus: "starting",
    lastStatusAt: now,
    id: worktreeId,
    title: opts.title,
    baseBranch: baseRef,
    status: "active",
    urls,
    bindings: [],
    ...(hasStartupCommands
      ? {
          startupCommandsStatus: "pending" as const,
          startupCommandsAt: now
        }
      : {})
  };

  // Upsert a Session entry so Claude Code hooks fired from this worktree can
  // find the right project/branch via findSessionByCwd().
  await upsertSession(repo, session);

  if (hasStartupCommands && cfg?.startupCommands) {
    // Fire-and-forget; failures log a warning and flip the session field,
    // they do NOT roll back the worktree.
    void runStartupCommands(repo, session, cfg.startupCommands);
  }

  return {
    worktreePath,
    envFiles: worktreeEnvFiles,
    ports,
    urls,
    id: worktreeId,
    title: opts.title,
    baseBranch: baseRef
  };
}

async function runStartupCommands(
  repo: string,
  session: Session,
  commands: string[]
): Promise<void> {
  const worktreePath = session.worktreePath;
  await upsertSession(repo, {
    ...session,
    startupCommandsStatus: "running",
    startupCommandsAt: new Date().toISOString()
  }).catch(() => null);
  try {
    for (const command of commands) {
      // eslint-disable-next-line no-await-in-loop
      const exit = await runOneStartupCommand(worktreePath, command);
      if (exit !== 0) {
        await upsertSession(repo, {
          ...session,
          startupCommandsStatus: "failed",
          startupCommandsAt: new Date().toISOString(),
          startupCommandsError: `${command} exited ${exit}`
        }).catch(() => null);
        return;
      }
    }
    await upsertSession(repo, {
      ...session,
      startupCommandsStatus: "success",
      startupCommandsAt: new Date().toISOString()
    }).catch(() => null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertSession(repo, {
      ...session,
      startupCommandsStatus: "failed",
      startupCommandsAt: new Date().toISOString(),
      startupCommandsError: message
    }).catch(() => null);
  }
}

function runOneStartupCommand(worktreePath: string, command: string): Promise<number> {
  return new Promise((resolve) => {
    const { child } = spawnTracked(
      command,
      { cwd: worktreePath, env: process.env, shell: true },
      {
        spawnSite: "worktrees:startupCommand",
        description: command.length > 80 ? command.slice(0, 80) + "…" : command
      }
    );
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.on("error", () => settle(-1));
    child.on("exit", (code) => settle(code ?? -1));
    // Treat "close" as authoritative for processes that detach.
    child.on("close", (code) => settle(code ?? -1));
  });
}


export async function removeWorktree(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  const repo = expandHome(repoPath);

  // Read meta before removing the directory — git worktree remove deletes it.
  const metaPath = path.join(worktreePath, ".garrison-meta.json");
  let branch: string | null = null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { branch?: string };
    branch = meta.branch ?? null;
  } catch {
    branch = null;
  }

  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repo
  }).catch(async () => {
    await fsp.rm(worktreePath, { recursive: true, force: true }).catch(() => null);
    await execFileAsync("git", ["worktree", "prune"], { cwd: repo }).catch(() => null);
  });

  if (branch) {
    await removeSession(repo, branch).catch(() => null);
  }
}

export function slugifyBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}

// Reject branch names containing characters or sequences git itself would
// reject. We're not policing every git rule, just shielding against the most
// common typos and obvious garbage. git rejects the rest.
export function assertValidBranchName(name: string): void {
  if (typeof name !== "string") throw new InvalidArgumentError("branch must be a string");
  const trimmed = name.trim();
  if (!trimmed) throw new InvalidArgumentError("branch is required");
  if (trimmed.length > 200) throw new InvalidArgumentError("branch name too long");
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) {
    throw new InvalidArgumentError("branch name contains whitespace or control characters");
  }
  if (/(^-)|(\.\.)|(@\{)|(\\)/.test(trimmed)) {
    throw new InvalidArgumentError(`invalid branch name: ${name}`);
  }
}

// baseBranch is a git ref (e.g. `main`, `origin/main`, `release/v2`). Don't
// slugify it — slashes are legal in refs. Just reject empty + obvious garbage.
export function assertValidRef(ref: string): void {
  if (typeof ref !== "string") throw new InvalidArgumentError("base ref must be a string");
  const trimmed = ref.trim();
  if (!trimmed) throw new InvalidArgumentError("base ref is required");
  if (trimmed.length > 200) throw new InvalidArgumentError("base ref too long");
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) {
    throw new InvalidArgumentError("base ref contains whitespace or control characters");
  }
  if (/(^-)|(\.\.)|(@\{)|(\\)/.test(trimmed)) {
    throw new InvalidArgumentError(`invalid base ref: ${ref}`);
  }
}

export function parseWorktreePorcelain(output: string, repoPath?: string): Worktree[] {
  const result: Worktree[] = [];
  const blocks = output.trim().split(/\n\n+/);
  const mainPath = repoPath ? safeRealpath(repoPath) : null;
  for (const block of blocks) {
    const lines = block.split("\n");
    const worktreePath = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "";
    const commit = lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "";
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const branch = branchLine ? branchLine.slice(7).replace("refs/heads/", "") : "(detached)";
    if (!worktreePath) continue;
    const isMain =
      mainPath !== null && safeRealpath(worktreePath) === mainPath;
    result.push({ worktreePath, branch, commit: commit.slice(0, 8), isMain });
  }
  return result;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(homedir(), p.slice(2));
  return p;
}

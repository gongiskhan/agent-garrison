import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  discoverEnvFiles,
  ensureWorkspacePortFiles,
  readMainPortMap,
  rewriteEnvFiles
} from "./worktree/env-rewriter";
import { patchFrontendDevScripts } from "./worktree/package-json-patcher";
import { removeSession, upsertSession } from "./garrison-sessions";

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
  baseBranch?: string
): Promise<CreateWorktreeResult> {
  assertValidBranchName(branch);
  const baseRef = (baseBranch ?? "main").trim();
  assertValidRef(baseRef);
  const slug = slugifyBranch(branch);
  if (!slug) throw new InvalidArgumentError("invalid branch name");
  const repo = expandHome(repoPath);
  const worktreesRoot = path.join(homedir(), ".worktrees");
  const repoName = path.basename(repo);
  const worktreePath = path.join(worktreesRoot, repoName, slug);

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

  const { ports } = await rewriteEnvFiles(worktreePath, worktreeEnvFiles, {
    branch,
    mainPortMap
  });

  const createdPortFiles = await ensureWorkspacePortFiles(worktreePath, ports);
  for (const f of createdPortFiles) {
    if (!worktreeEnvFiles.includes(f)) worktreeEnvFiles.push(f);
  }

  await patchFrontendDevScripts(worktreePath);

  const now = new Date().toISOString();
  await fsp.writeFile(
    path.join(worktreePath, ".garrison-meta.json"),
    JSON.stringify(
      {
        branch,
        repo: repoName,
        ports,
        envFiles: worktreeEnvFiles,
        createdAt: now
      },
      null,
      2
    )
  );

  // Upsert a Session entry so Claude Code hooks fired from this worktree can
  // find the right project/branch via findSessionByCwd().
  await upsertSession(repo, {
    branch,
    worktreePath,
    ports,
    envFiles: worktreeEnvFiles,
    createdAt: now,
    lastStatus: "starting",
    lastStatusAt: now
  });

  return { worktreePath, envFiles: worktreeEnvFiles, ports };
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

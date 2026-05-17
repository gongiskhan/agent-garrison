import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const TEST_STATE_DIR = path.join(os.homedir(), ".garrison-test");
export const TEST_STATE_FILE = path.join(TEST_STATE_DIR, "state.json");
export const TEST_PREFS_FILE = path.join(TEST_STATE_DIR, "ui-tab-prefs.json");

const TAILSCALE_HOST = "100.90.155.85";

export interface SeedWorktree {
  branch: string;
  baseBranch?: string;
  title?: string;
  status: "active" | "merged" | "discarded";
  ports?: Record<string, number>;
  bindings?: Array<{
    soul: string;
    sessionId: string;
    mode: "headless" | "interactive";
    tier: { model: string };
    tierFlags: string[];
    spawnedAt: string;
  }>;
}

export async function seedState(opts: {
  projectPath: string;
  worktrees: SeedWorktree[];
}): Promise<void> {
  await fsp.mkdir(TEST_STATE_DIR, { recursive: true });
  const sessions: Record<string, any> = {};
  for (const wt of opts.worktrees) {
    const id = randomUUID();
    const ports = wt.ports ?? { frontend: 50000, backend: 50001 };
    const urls: Record<string, string> = {};
    for (const [name, port] of Object.entries(ports)) {
      urls[name] = `http://${TAILSCALE_HOST}:${port}`;
    }
    sessions[wt.branch] = {
      branch: wt.branch,
      worktreePath: path.join(os.homedir(), ".worktrees-test", wt.branch.replace(/[/\\]/g, "-")),
      ports,
      envFiles: [".env"],
      createdAt: new Date().toISOString(),
      lastStatus: "idle",
      lastStatusAt: new Date().toISOString(),
      id,
      title: wt.title,
      baseBranch: wt.baseBranch ?? "main",
      status: wt.status,
      urls,
      bindings: wt.bindings ?? []
    };
  }
  const state = {
    version: 1,
    projects: {
      [opts.projectPath]: {
        path: opts.projectPath,
        name: path.basename(opts.projectPath),
        sessions
      }
    }
  };
  await fsp.writeFile(TEST_STATE_FILE, JSON.stringify(state, null, 2));
}

export async function clearState(): Promise<void> {
  await fsp.rm(TEST_STATE_FILE, { force: true }).catch(() => null);
  await fsp.rm(TEST_PREFS_FILE, { force: true }).catch(() => null);
}

export async function seedPrefs(opts: {
  target: string;
  projectPath: string;
  devRoot: string;
}): Promise<void> {
  await fsp.mkdir(TEST_STATE_DIR, { recursive: true });
  const prefs = {
    worktrees: {
      lastTarget: opts.target,
      lastProjectByTarget: { [opts.target]: opts.projectPath },
      devRootByTarget: { [opts.target]: opts.devRoot }
    }
  };
  await fsp.writeFile(TEST_PREFS_FILE, JSON.stringify(prefs, null, 2));
}

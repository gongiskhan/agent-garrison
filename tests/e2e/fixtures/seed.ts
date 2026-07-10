import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const TEST_STATE_DIR = path.join(os.homedir(), ".garrison-test");
export const TEST_STATE_FILE = path.join(TEST_STATE_DIR, "state.json");

export interface SeedSession {
  branch: string;
  title?: string;
  lastStatus?: string;
}

// Seed the dev-env session ledger: one row per session, keyed by branch, each
// running at the project's repo root. Sessions are same-branch and carry no
// per-session port pools.
export async function seedState(opts: {
  projectPath: string;
  sessions: SeedSession[];
}): Promise<void> {
  await fsp.mkdir(TEST_STATE_DIR, { recursive: true });
  const sessions: Record<string, unknown> = {};
  const nowIso = new Date().toISOString();
  for (const s of opts.sessions) {
    sessions[s.branch] = {
      branch: s.branch,
      projectPath: opts.projectPath,
      createdAt: nowIso,
      lastStatus: s.lastStatus ?? "idle",
      lastStatusAt: nowIso,
      id: randomUUID(),
      title: s.title ?? null
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
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const GARRISON_DIR = path.join(homedir(), ".garrison");
const PREFS_PATH = path.join(GARRISON_DIR, "workbench-prefs.json");

export interface WorktreePrefs {
  lastTarget: string;
  lastProjectByTarget: Record<string, string>;
  devRootByTarget: Record<string, string>;
}

export interface WorkbenchPrefs {
  worktrees: WorktreePrefs;
}

const DEFAULT_PREFS: WorkbenchPrefs = {
  worktrees: {
    lastTarget: "local",
    lastProjectByTarget: {},
    devRootByTarget: {},
  },
};

function ensureDir(): void {
  if (!existsSync(GARRISON_DIR)) {
    mkdirSync(GARRISON_DIR, { recursive: true, mode: 0o700 });
  }
}

export function readPrefs(): WorkbenchPrefs {
  if (!existsSync(PREFS_PATH)) return structuredClone(DEFAULT_PREFS);
  try {
    const raw = readFileSync(PREFS_PATH, "utf8");
    if (!raw.trim()) return structuredClone(DEFAULT_PREFS);
    const parsed = JSON.parse(raw) as Partial<WorkbenchPrefs>;
    return {
      worktrees: {
        lastTarget: parsed.worktrees?.lastTarget ?? "local",
        lastProjectByTarget: parsed.worktrees?.lastProjectByTarget ?? {},
        devRootByTarget: parsed.worktrees?.devRootByTarget ?? {},
      },
    };
  } catch {
    return structuredClone(DEFAULT_PREFS);
  }
}

export function writePrefs(prefs: WorkbenchPrefs): void {
  ensureDir();
  writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), { mode: 0o600 });
}

export function updatePrefs(patch: { worktrees?: Partial<WorktreePrefs> }): WorkbenchPrefs {
  const current = readPrefs();
  if (patch.worktrees) {
    const wt = patch.worktrees;
    if (wt.lastTarget !== undefined) current.worktrees.lastTarget = wt.lastTarget;
    if (wt.lastProjectByTarget) {
      current.worktrees.lastProjectByTarget = {
        ...current.worktrees.lastProjectByTarget,
        ...wt.lastProjectByTarget,
      };
    }
    if (wt.devRootByTarget) {
      current.worktrees.devRootByTarget = {
        ...current.worktrees.devRootByTarget,
        ...wt.devRootByTarget,
      };
    }
  }
  writePrefs(current);
  return current;
}

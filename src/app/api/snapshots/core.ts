import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEED_FITTINGS_DIR } from "@/lib/paths";

// Shared, side-effect-light helpers for the Snapshots API routes and their
// tests. Kept out of the React view: this module reads the filesystem and must
// never be pulled into the client bundle.

export const FITTING_ID = "snapshots-default";

export interface SnapshotsState {
  lastRun: string;
  ok: boolean;
  bytes?: number;
  error?: string;
}

// The machine-local state/reporting home the scripts write to. Honors
// GARRISON_HOME so tests (and the e2e sandbox) stay isolated from the real one.
export function snapshotsStateDir(): string {
  const home = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  return path.join(home, "snapshots");
}

// Read the last-run record backup.sh writes. Returns null when the file is
// missing or malformed (never throws) so the view can render a clean "no
// backups yet" state.
export function readSnapshotsState(stateDir: string = snapshotsStateDir()): SnapshotsState | null {
  const file = path.join(stateDir, "state.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotsState;
    if (typeof parsed?.lastRun !== "string" || typeof parsed?.ok !== "boolean") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// The exact restore command the view prints for the user to copy. Restore is
// deliberately never automated; falls back to placeholders when a value is
// unknown so the shape is always copy-pasteable.
export function formatRestoreCommand(
  repository: string,
  snapshotId: string,
  targetDir: string
): string {
  const repo = repository && repository.length > 0 ? repository : "<repo>";
  const id = snapshotId && snapshotId.length > 0 ? snapshotId : "<snapshot-id>";
  const target = targetDir && targetDir.length > 0 ? targetDir : "<target-dir>";
  return `restic -r ${repo} restore ${id} --target ${target}`;
}

// Resolve the directory holding the Fitting's scripts. Prefers the copy APM
// installed into the active composition; falls back to the in-repo seed so the
// routes work in plain `next dev` too.
export function resolveScriptsDir(): string {
  const compDir = process.env.GARRISON_COMPOSITION_DIR?.trim();
  if (compDir) {
    const installed = path.join(compDir, "apm_modules", "_local", FITTING_ID, "scripts");
    if (fs.existsSync(installed)) return installed;
  }
  return path.join(SEED_FITTINGS_DIR, FITTING_ID, "scripts");
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { garrisonDir } from "./claude-home";
import { isValidInstanceId } from "./view-instances";

// Layer 2 of the Workspaces/view-state wave: the on-disk side of view
// identity + persistence. Server-only (node imports) — the pure identity
// model it builds on lives in view-instances.ts, which client code may import.
//
// Grain: ~/.garrison/view-state/<fittingId>/<instanceId>.json — one file per
// instance, so enumeration IS the directory listing (no index to drift), the
// same convention as ~/.garrison/ui-fittings/<id>.json.

export function viewStateDir(): string {
  return path.join(garrisonDir(), "view-state");
}

export function viewStateFittingDir(fittingId: string): string {
  if (!isValidInstanceId(fittingId)) {
    throw new Error(`invalid fitting id for view-state path: ${JSON.stringify(fittingId)}`);
  }
  return path.join(viewStateDir(), fittingId);
}

export function viewStateFile(fittingId: string, instanceId: string): string {
  if (!isValidInstanceId(instanceId)) {
    throw new Error(`invalid instance id for view-state path: ${JSON.stringify(instanceId)}`);
  }
  return path.join(viewStateFittingDir(fittingId), `${instanceId}.json`);
}

// Persisted instances for a fitting = the *.json files under its state dir.
// Empty (not ["default"]) when nothing has persisted yet — the caller decides
// whether to fall back to DEFAULT_INSTANCE_ID.
export async function listInstanceIds(fittingId: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(viewStateFittingDir(fittingId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => isValidInstanceId(id))
    .sort();
}

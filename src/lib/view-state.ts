import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readFileTolerant } from "./atomic-write";
import { garrisonDir } from "./claude-home";
import { isValidInstanceId } from "./view-instances";

// Layer 2 of the Workspaces/view-state wave: the generic view-state store.
// Server-only (node imports) — the pure identity model it builds on lives in
// view-instances.ts, which client code may import.
//
// Grain: ~/.garrison/view-state/<fittingId>/<instanceId>.json — one file per
// instance, so enumeration IS the directory listing (no index to drift), the
// same convention as ~/.garrison/ui-fittings/<id>.json. The state payload is
// an opaque blob: each fitting decides what its views remember (terminal:
// cwd + scrollback; a tree view: selection + expansion). Persistence is
// always on — saves are debounced auto-writes, there is no save action
// anywhere. Own-port fittings (separate processes) write the same files
// directly via their own helper; embedded views go through /api/view-state.

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

export async function listFittingIds(): Promise<string[]> {
  // Directories only — root-level files (e.g. eager-boot.json, the Layer 3
  // toggle prefs) are not fittings.
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(viewStateDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => isValidInstanceId(id))
    .sort();
}

// On-disk envelope. `state` is the fitting's opaque blob (its serialize()
// output); the wrapper fields exist so a file is self-describing when read
// outside Garrison (same spirit as the ui-fittings status files).
export interface ViewStateEnvelope<T = unknown> {
  fittingId: string;
  instanceId: string;
  updatedAt: string;
  state: T;
}

export interface ViewStateReadResult<T = unknown> {
  exists: boolean;
  envelope?: ViewStateEnvelope<T>;
}

export async function readViewState<T = unknown>(
  fittingId: string,
  instanceId: string
): Promise<ViewStateReadResult<T>> {
  const file = viewStateFile(fittingId, instanceId);
  const result = await readFileTolerant(file, {
    validate: (text) => {
      JSON.parse(text);
    }
  });
  if (!result.exists) {
    return { exists: false };
  }
  const parsed = JSON.parse(result.text) as Partial<ViewStateEnvelope<T>>;
  if (parsed === null || typeof parsed !== "object" || !("state" in parsed)) {
    // Unrecognised shape — treat as absent rather than feeding a view a blob
    // it never wrote. The file stays on disk for inspection.
    return { exists: false };
  }
  return {
    exists: true,
    envelope: {
      fittingId,
      instanceId,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      state: parsed.state as T
    }
  };
}

export async function writeViewState(
  fittingId: string,
  instanceId: string,
  state: unknown
): Promise<ViewStateEnvelope> {
  const envelope: ViewStateEnvelope = {
    fittingId,
    instanceId,
    updatedAt: new Date().toISOString(),
    state
  };
  const file = viewStateFile(fittingId, instanceId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, envelope);
  return envelope;
}

export async function deleteViewState(fittingId: string, instanceId: string): Promise<boolean> {
  try {
    await fs.unlink(viewStateFile(fittingId, instanceId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Debounced auto-write for server-side callers that persist on every state
// change (the no-save-button invariant: continuous persistence, trailing
// debounce so a burst of changes lands as one atomic write). Keyed per
// instance; survives Next.js dev hot-reload via globalThis, same pattern as
// the runner's record map.
const DEBOUNCE_MS = 500;

interface PendingWrite {
  timer: NodeJS.Timeout;
  state: unknown;
}

const pendingWrites: Map<string, PendingWrite> = ((
  globalThis as { __garrisonViewStateWrites?: Map<string, PendingWrite> }
).__garrisonViewStateWrites ??= new Map());

export function scheduleViewStateWrite(
  fittingId: string,
  instanceId: string,
  state: unknown,
  delayMs: number = DEBOUNCE_MS
): void {
  // Validate eagerly so a bad id fails at schedule time, not inside a timer.
  viewStateFile(fittingId, instanceId);
  const key = `${fittingId}/${instanceId}`;
  const existing = pendingWrites.get(key);
  if (existing) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    void writeViewState(fittingId, instanceId, state).catch((error) => {
      console.error(`[garrison] view-state write failed for ${key}:`, error);
    });
  }, delayMs);
  // Don't hold the process open for a pending state flush.
  timer.unref?.();
  pendingWrites.set(key, { timer, state });
}

// Flush every pending debounced write immediately (shutdown, test teardown).
export async function flushViewStateWrites(): Promise<void> {
  const entries = [...pendingWrites.entries()];
  pendingWrites.clear();
  await Promise.all(
    entries.map(([key, pending]) => {
      clearTimeout(pending.timer);
      const [fittingId, instanceId] = key.split("/");
      return writeViewState(fittingId, instanceId, pending.state).catch((error) => {
        console.error(`[garrison] view-state flush failed for ${key}:`, error);
      });
    })
  );
}

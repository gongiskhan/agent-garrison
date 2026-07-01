import path from "node:path";
import { readFileTolerant, writeJsonAtomic } from "./atomic-write";
import { listCompositions } from "./compositions";
import { isOwnPortFitting } from "./faculties";
import { readLibrary } from "./library";
import { ownPortConfigEnv, startOwnPortFitting, vaultEnvForEntry } from "./own-port-lifecycle";
import type { LibraryEntry } from "./types";
import { isValidInstanceId } from "./view-instances";
import { listInstanceIds, viewStateDir } from "./view-state";

// Layer 3 of the Workspaces/view-state wave: per-view-type eager boot.
// Server-only (node imports, vault, child spawns).
//
// Persistence is universal and always on (Layer 2) — this toggle ONLY decides
// whether a view boots with the server and restores its persisted instances
// immediately, or lazily on first open. Untoggled views still persist and
// restore; they just wait for the user.
//
// Prefs live as a root-level file inside the view-state dir (listFittingIds
// already skips non-directories, so it can never be mistaken for a fitting).
// Only `true` entries are stored — toggled-off is absence, so the file reads
// as the literal list of eager fittings.

export interface EagerBootPrefs {
  version: 1;
  eager: Record<string, boolean>;
}

export function eagerBootPrefsPath(): string {
  return path.join(viewStateDir(), "eager-boot.json");
}

function emptyPrefs(): EagerBootPrefs {
  return { version: 1, eager: {} };
}

export async function readEagerBootPrefs(): Promise<EagerBootPrefs> {
  let result;
  try {
    result = await readFileTolerant(eagerBootPrefsPath(), {
      validate: (text) => {
        JSON.parse(text);
      }
    });
  } catch {
    return emptyPrefs();
  }
  if (!result.exists) {
    return emptyPrefs();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return emptyPrefs();
  }
  if (parsed === null || typeof parsed !== "object") {
    return emptyPrefs();
  }
  const eagerRaw = (parsed as { eager?: unknown }).eager;
  if (eagerRaw === null || typeof eagerRaw !== "object" || Array.isArray(eagerRaw)) {
    return emptyPrefs();
  }
  // Keep only well-formed, path-safe entries — the ids become spawn targets.
  const eager: Record<string, boolean> = {};
  for (const [fittingId, value] of Object.entries(eagerRaw as Record<string, unknown>)) {
    if (value === true && isValidInstanceId(fittingId)) {
      eager[fittingId] = true;
    }
  }
  return { version: 1, eager };
}

export async function setEagerBoot(fittingId: string, eager: boolean): Promise<EagerBootPrefs> {
  if (!isValidInstanceId(fittingId)) {
    throw new Error(`invalid fitting id for eager-boot prefs: ${JSON.stringify(fittingId)}`);
  }
  const prefs = await readEagerBootPrefs();
  if (eager) {
    prefs.eager[fittingId] = true;
  } else {
    delete prefs.eager[fittingId];
  }
  await writeJsonAtomic(eagerBootPrefsPath(), prefs);
  return prefs;
}

export async function isEagerBoot(fittingId: string): Promise<boolean> {
  const prefs = await readEagerBootPrefs();
  return prefs.eager[fittingId] === true;
}

export interface EagerBootSummary {
  booted: string[];
  warmed: string[];
  skipped: string[];
  // Start failures, kept apart from benign skips (not-in-library, already
  // running) so a fitting the boot just failed to bring up is never invisible.
  failed: Array<{ id: string; error: string }>;
}

export interface EagerBootOptions {
  // Tests inject a fixture library; production resolves the real one.
  library?: LibraryEntry[];
  // Per-fitting selected config, keyed by fitting id, projected into the spawn
  // env so an eager-booted own-port fitting reads its apm.yml config (e.g.
  // local-voice's whisper_model/stt_engine) instead of falling back to server
  // defaults. Tests inject a map; production scans all compositions.
  configById?: Map<string, Record<string, unknown>>;
}

// Build a fitting-id → selected-config map by scanning every composition, so
// eager boot (which is composition-agnostic) can still project each fitting's
// config. When more than one composition selects the same fitting, later keys
// win per-field; in practice the voice/own-port config agrees across
// compositions, so the merge is deterministic and correct. Best-effort: a read
// failure yields an empty map (eager boot then spawns on server defaults, the
// prior behavior) rather than aborting the boot.
async function resolveConfigById(): Promise<Map<string, Record<string, unknown>>> {
  const configById = new Map<string, Record<string, unknown>>();
  try {
    const compositions = await listCompositions();
    for (const composition of compositions) {
      for (const items of Object.values(composition.selections)) {
        for (const item of items ?? []) {
          const prev = configById.get(item.id) ?? {};
          configById.set(item.id, { ...prev, ...((item.config ?? {}) as Record<string, unknown>) });
        }
      }
    }
  } catch {
    // ignore — fall back to an empty map (server defaults)
  }
  return configById;
}

// The server-boot sequence (called from src/instrumentation.ts).
//
// Own-port fittings are real processes, so "eager" means: if the status file
// is absent or stale (startOwnPortFitting probes the recorded PID), spawn the
// fitting now — the fitting then rehydrates its own persisted instances on
// boot, exactly as the terminal does.
//
// Embedded views are client React with no server process — there is nothing
// to start. Eager boot can only warm the instance index (listInstanceIds);
// the actual state restore happens in the browser when the view opens, and it
// does so regardless of this toggle. That asymmetry is honest, not a gap.
export async function runEagerBoot(options: EagerBootOptions = {}): Promise<EagerBootSummary> {
  const summary: EagerBootSummary = { booted: [], warmed: [], skipped: [], failed: [] };
  const prefs = await readEagerBootPrefs();
  const eagerIds = Object.keys(prefs.eager).sort();
  if (eagerIds.length === 0) {
    // Absent prefs file or nothing toggled — silent no-op.
    return summary;
  }
  const library = options.library ?? (await readLibrary());
  const byId = new Map(library.map((entry) => [entry.id, entry]));
  // Config projected into own-port spawns so eager boot honors apm.yml config
  // (see resolveConfigById). Config keys are NOT in TRACKED_ENV_KEYS, so adding
  // this env never perturbs the env-drift heal decision — it only changes what a
  // fresh spawn receives.
  const configById = options.configById ?? (await resolveConfigById());
  for (const fittingId of eagerIds) {
    const entry = byId.get(fittingId);
    if (!entry) {
      summary.skipped.push(fittingId);
      console.log(`[garrison] eager-boot: skipped ${fittingId} (not in library)`);
      continue;
    }
    if (isOwnPortFitting(entry)) {
      // Config first so vault/GARRISON_* keys always win on collision (mirrors
      // the runner's startOperativeBoundFittings ordering).
      const extraEnv = {
        ...ownPortConfigEnv(configById.get(fittingId) ?? {}),
        ...(await vaultEnvForEntry(entry))
      };
      const result = await startOwnPortFitting(entry, extraEnv);
      if (!result.ok) {
        const error = result.error ?? "start failed";
        summary.failed.push({ id: fittingId, error });
        console.warn(`[garrison] eager-boot: FAILED ${fittingId} (${error})`);
      } else if (result.alreadyRunning) {
        summary.skipped.push(fittingId);
        console.log(`[garrison] eager-boot: skipped ${fittingId} (already running)`);
      } else if (result.healed) {
        summary.booted.push(fittingId);
        console.log(
          `[garrison] eager-boot: restarted ${fittingId} with vault secrets${result.pid ? ` (pid ${result.pid})` : ""}`
        );
      } else {
        summary.booted.push(fittingId);
        console.log(
          `[garrison] eager-boot: started ${fittingId}${result.pid ? ` (pid ${result.pid})` : ""}`
        );
      }
    } else {
      const instances = await listInstanceIds(fittingId);
      summary.warmed.push(fittingId);
      console.log(
        `[garrison] eager-boot: warmed ${fittingId} (${instances.length} persisted instance${instances.length === 1 ? "" : "s"}; embedded views restore in-browser on open)`
      );
    }
  }
  return summary;
}

// Setup-instruction override store for projected (non-packaged) promoted
// Fittings. A projected Fitting has no on-disk apm.yml, so its editable setup
// steps live here — the single source of truth the projection installer reads,
// mirroring how a packaged Fitting's installer reads `x-garrison.setup`. Edits
// from the Setup Instructions UI persist here; the catalog read merges this over
// the authored baseline. Machine-local under ~/.garrison (honors GARRISON_HOME),
// beside the parked store.

import path from "node:path";
import { garrisonDir } from "./claude-home";
import { writeJsonAtomic, readFileTolerant } from "./atomic-write";
import type { SetupStep } from "./types";

export function promotedOverridesPath(): string {
  return path.join(garrisonDir(), "promoted-fittings.overrides.json");
}

interface OverridesFile {
  // fitting id -> edited setup steps
  setup: Record<string, SetupStep[]>;
}

// Tolerant read of the override file → the id→steps map (the `setup` block).
// Returns {} when absent or unparseable. Single parse site for both the read and
// the read-modify-write paths.
async function readSetupMap(): Promise<Record<string, SetupStep[]>> {
  const { exists, text } = await readFileTolerant(promotedOverridesPath(), {
    validate: (t) => JSON.parse(t)
  });
  if (!exists) return {};
  try {
    const parsed = JSON.parse(text) as Partial<OverridesFile>;
    return parsed?.setup && typeof parsed.setup === "object" ? parsed.setup : {};
  } catch {
    return {};
  }
}

export async function readPromotedOverrides(): Promise<Record<string, SetupStep[]>> {
  return readSetupMap();
}

// In-process write serialization. A single Garrison server process handles every
// tab, so chaining writes here turns the read-modify-write of the shared
// overrides file into a critical section — two tabs editing different Fittings
// can't drop each other's keys (the lost-update race a CAS-less RMW would have).
let writeChain: Promise<void> = Promise.resolve();

async function doWritePromotedSetup(id: string, steps: SetupStep[]): Promise<void> {
  const setup = await readSetupMap();
  // ALWAYS store the array — including an explicit empty array. Clearing every
  // step is a real user choice ("this Fitting has no setup"); deleting the key
  // would let the read fall back to the authored baseline and silently restore
  // the steps the user just removed.
  setup[id] = steps;
  await writeJsonAtomic(promotedOverridesPath(), { setup } satisfies OverridesFile, { mode: 0o600 });
}

// Persist the edited setup steps for one projected Fitting. An empty array is
// stored verbatim (an explicit "no setup"), NOT treated as "reset to baseline".
export async function writePromotedSetup(id: string, steps: SetupStep[]): Promise<void> {
  const run = writeChain.then(
    () => doWritePromotedSetup(id, steps),
    () => doWritePromotedSetup(id, steps)
  );
  // Keep the chain alive regardless of this write's outcome.
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
